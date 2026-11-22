"""Одноразовые ссылки-приглашения на ветку (роль).

Админ генерирует ссылку /register?invite=<токен>: регистрация по ней создаёт активный
аккаунт сразу с ролью из приглашения, минуя очередь заявок. Приглашение живёт в Redis
до первого использования (GETDEL, как refresh-токен) или до конца TTL; админ может
отозвать его раньше. Приглашений на роль admin не бывает.

Токен — секрет (даёт роль): в логи не печатается, наружу отдаётся только в ответах
админских эндпоинтов. Регистрация по приглашению — POST /registration/invite.
"""

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import Field
from pymongo.errors import DuplicateKeyError

from app.api.deps import AdminUser
from app.api.routes.auth import TokenPair, _issue
from app.api.routes.registration import ApproveIn, RegisterIn, _rate_limit
from app.core.config import get_settings
from app.db.mongo import get_db
from app.db.redis import get_redis
from app.domain.enums import Role
from app.services.users import create_user, publish_roster_changed

router = APIRouter(tags=["invites"])

INVITE_PREFIX = "invite:"
DEAD_LINK = "Ссылка недействительна или уже использована"


class InviteIn(ApproveIn):
    # role без значения по умолчанию: приглашение всегда выдаётся под конкретную ветку
    role: Role


class InviteRegisterIn(RegisterIn):
    token: str = Field(min_length=1)


def _key(token: str) -> str:
    return f"{INVITE_PREFIX}{token}"


def _check_role(role: Role, itsm_login: str | None) -> None:
    if role == Role.ADMIN:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Приглашение на роль администратора невозможно")
    if role == Role.DEVELOPER and not itsm_login:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Для приглашения разработчика нужен логин ITSM")


@router.post("/invites", status_code=201)
async def create_invite(body: InviteIn, admin: AdminUser) -> dict[str, Any]:
    _check_role(body.role, body.itsmLogin)
    token = uuid.uuid4().hex
    ttl = timedelta(hours=get_settings().invite_ttl_hours)
    now = datetime.now(UTC)
    payload = {
        "role": body.role.value,
        "itsmLogin": body.itsmLogin,
        "createdBy": admin["_id"],
        "createdAt": now.isoformat(),
    }
    await get_redis().set(_key(token), json.dumps(payload, ensure_ascii=False), ex=ttl)
    return {
        "token": token,
        "role": body.role.value,
        "itsmLogin": body.itsmLogin,
        "createdAt": payload["createdAt"],
        "expiresAt": (now + ttl).isoformat(),
    }


@router.get("/invites")
async def list_invites(_: AdminUser) -> list[dict[str, Any]]:
    r = get_redis()
    out: list[dict[str, Any]] = []
    now = datetime.now(UTC)
    async for key in r.scan_iter(match=f"{INVITE_PREFIX}*"):
        raw = await r.get(key)
        if raw is None:  # истёк между SCAN и GET
            continue
        data = json.loads(raw)
        remaining = await r.ttl(key)
        if remaining <= 0:
            continue
        out.append(
            {
                "token": key.removeprefix(INVITE_PREFIX),
                "role": data["role"],
                "itsmLogin": data.get("itsmLogin"),
                "createdAt": data["createdAt"],
                "expiresAt": (now + timedelta(seconds=remaining)).isoformat(),
            }
        )
    return sorted(out, key=lambda x: x["createdAt"], reverse=True)


@router.delete("/invites/{token}", status_code=204)
async def revoke_invite(token: str, _: AdminUser) -> None:
    if not await get_redis().delete(_key(token)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Приглашение не найдено или уже использовано")


@router.post("/registration/invite", response_model=TokenPair, dependencies=[Depends(_rate_limit)])
async def register_by_invite(body: InviteRegisterIn) -> TokenPair:
    raw = await get_redis().get(_key(body.token))
    if raw is None:
        raise HTTPException(status.HTTP_410_GONE, DEAD_LINK)
    invite = json.loads(raw)
    db = get_db()
    if await db.users.find_one({"email": body.email}):
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с такой почтой уже существует")
    try:
        user = await create_user(
            body.email, body.password, body.fullName.strip(), Role(invite["role"]), invite.get("itsmLogin")
        )
    except DuplicateKeyError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с такой почтой уже существует") from e
    await publish_roster_changed()
    # токен сжигается только после успешного создания аккаунта: ошибка формы не должна
    # убивать ссылку, повтор под ту же почту всё равно блокирует уникальный индекс
    await get_redis().getdel(_key(body.token))
    return await _issue(user)
