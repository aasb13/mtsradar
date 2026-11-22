"""Зависимости FastAPI: текущий пользователь, проверка ролей, сервисный ключ."""

import secrets
from typing import Annotated, Any

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from app.core.config import get_settings
from app.core.security import decode_token
from app.db.mongo import get_db
from app.domain.enums import Role

# tokenUrl нужен только для кнопки Authorize в Swagger (/docs)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token", auto_error=False)


def _unauthorized(detail: str = "Не авторизован") -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail, headers={"WWW-Authenticate": "Bearer"})


async def user_from_token(token: str | None) -> dict[str, Any]:
    if not token:
        raise _unauthorized()
    try:
        payload = decode_token(token, "access")
    except jwt.ExpiredSignatureError as e:
        raise _unauthorized("Токен истёк") from e
    except jwt.PyJWTError as e:
        raise _unauthorized("Неверный токен") from e
    user = await get_db().users.find_one({"_id": payload["sub"], "deletedAt": None})
    if not user:
        raise _unauthorized("Пользователь не найден или удалён")
    return user


async def get_current_user(token: Annotated[str | None, Depends(oauth2_scheme)]) -> dict[str, Any]:
    return await user_from_token(token)


CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]


def require_roles(*roles: Role):
    async def checker(user: CurrentUser) -> dict[str, Any]:
        if user["role"] not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
        return user

    return Depends(checker)


AdminUser = Annotated[dict[str, Any], require_roles(Role.ADMIN)]
# все, кроме разработчиков: общий дашборд, канбан, список, статистика
StaffUser = Annotated[dict[str, Any], require_roles(Role.ADMIN, Role.COORDINATOR, Role.VIEWER)]
CoordinatorUser = Annotated[dict[str, Any], require_roles(Role.ADMIN, Role.COORDINATOR)]


async def require_service(x_service_key: Annotated[str | None, Header()] = None) -> None:
    """Для межсервисных вызовов (ИИ-сервис, ITSM). Сравнение за постоянное время."""
    if not x_service_key or not secrets.compare_digest(x_service_key, get_settings().service_api_key):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный X-Service-Key")


ServiceAuth = Depends(require_service)
