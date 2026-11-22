"""Вход, обновление и отзыв токенов, профиль текущего пользователя."""

from typing import Annotated, Any

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field, field_validator

from app.api.deps import CurrentUser
from app.core.config import get_settings
from app.core.security import create_token, decode_token, hash_password, verify_password
from app.db.mongo import get_db
from app.db.redis import get_redis
from app.services.users import NOTIFICATION_KINDS, public_user

router = APIRouter(tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str


class RefreshIn(BaseModel):
    refreshToken: str


class TokenPair(BaseModel):
    accessToken: str
    refreshToken: str
    tokenType: str = "bearer"
    expiresIn: int
    user: dict[str, Any]


async def _rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    key = f"rl:login:{ip}"
    r = get_redis()
    count = await r.incr(key)
    if count == 1:
        await r.expire(key, 60)
    if count > get_settings().login_rate_limit_per_min:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много попыток входа, подождите минуту")


async def _issue(user: dict[str, Any]) -> TokenPair:
    access, _, access_ttl = create_token(user["_id"], user["role"], "access")
    refresh, jti, refresh_ttl = create_token(user["_id"], user["role"], "refresh")
    await get_redis().set(f"refresh:{jti}", user["_id"], ex=refresh_ttl)
    return TokenPair(accessToken=access, refreshToken=refresh, expiresIn=access_ttl, user=public_user(user))


async def _authenticate(email: str, password: str) -> dict[str, Any]:
    email = email.strip().lower()
    user = await get_db().users.find_one({"email": email, "deletedAt": None})
    if user is None and await get_db().registration_requests.find_one({"email": email, "status": "pending"}):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Заявка на регистрацию ещё рассматривается — войдите, когда администратор её одобрит"
        )
    if not user or not verify_password(password, user["passwordHash"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный email или пароль")
    return user


@router.post("/auth/login", response_model=TokenPair, dependencies=[Depends(_rate_limit)])
async def login(body: LoginIn) -> TokenPair:
    return await _issue(await _authenticate(body.email, body.password))


@router.post("/auth/token", include_in_schema=True, dependencies=[Depends(_rate_limit)])
async def token_for_swagger(form: Annotated[OAuth2PasswordRequestForm, Depends()]) -> dict[str, str]:
    """Тот же вход, но в формате OAuth2-формы — для кнопки Authorize в Swagger (username = email)."""
    pair = await _issue(await _authenticate(form.username, form.password))
    return {"access_token": pair.accessToken, "token_type": "bearer"}


@router.post("/auth/refresh", response_model=TokenPair)
async def refresh(body: RefreshIn) -> TokenPair:
    try:
        payload = decode_token(body.refreshToken, "refresh")
    except jwt.PyJWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный refresh-токен") from e
    # getdel: токен одноразовый (ротация). Повторное использование -> 401
    user_id = await get_redis().getdel(f"refresh:{payload['jti']}")
    if not user_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh-токен отозван или уже использован")
    user = await get_db().users.find_one({"_id": user_id, "deletedAt": None})
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Пользователь удалён")
    return await _issue(user)


@router.post("/auth/logout", status_code=204)
async def logout(body: RefreshIn) -> None:
    try:
        payload = decode_token(body.refreshToken, "refresh")
        await get_redis().delete(f"refresh:{payload['jti']}")
    except jwt.PyJWTError:
        pass


# ---------- профиль ----------


class NotificationSettingsIn(BaseModel):
    inApp: bool = True
    telegram: bool = False
    email: bool = False
    kinds: dict[str, bool] = Field(default_factory=dict)

    @field_validator("kinds")
    @classmethod
    def _known(cls, v: dict[str, bool]) -> dict[str, bool]:
        unknown = set(v) - set(NOTIFICATION_KINDS)
        if unknown:
            raise ValueError(f"неизвестные виды уведомлений: {sorted(unknown)}")
        return {**dict.fromkeys(NOTIFICATION_KINDS, True), **v}


class MeUpdate(BaseModel):
    fullName: str | None = Field(None, min_length=1, max_length=200)
    telegramChatId: str | None = None
    notificationSettings: NotificationSettingsIn | None = None
    currentPassword: str | None = None
    newPassword: str | None = Field(None, min_length=8)

    @field_validator("newPassword")
    @classmethod
    def _bcrypt_limit(cls, v: str | None) -> str | None:
        if v is not None and len(v.encode()) > 72:
            raise ValueError("пароль длиннее 72 байт")
        return v


@router.get("/me")
async def me(user: CurrentUser) -> dict[str, Any]:
    return {**public_user(user), "notificationKinds": NOTIFICATION_KINDS}


@router.patch("/me")
async def update_me(body: MeUpdate, user: CurrentUser) -> dict[str, Any]:
    update: dict[str, Any] = {}
    if body.fullName is not None:
        update["fullName"] = body.fullName
    if "telegramChatId" in body.model_fields_set:
        update["telegramChatId"] = body.telegramChatId
    if body.notificationSettings is not None:
        update["notificationSettings"] = body.notificationSettings.model_dump()
    if body.newPassword:
        if not body.currentPassword or not verify_password(body.currentPassword, user["passwordHash"]):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Текущий пароль указан неверно")
        update["passwordHash"] = hash_password(body.newPassword)
    if update:
        await get_db().users.update_one({"_id": user["_id"]}, {"$set": update})
    fresh = await get_db().users.find_one({"_id": user["_id"]})
    return public_user(fresh)
