"""Пароли (bcrypt) и JWT (access + refresh).

Access-токен короткий и проверяется без похода в Redis.
Refresh-токен длинный; его jti хранится в Redis, поэтому его можно отозвать (logout),
а при обновлении он «ротируется»: старый удаляется, выдаётся новый.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

import bcrypt
import jwt

from app.core.config import get_settings

TokenType = Literal["access", "refresh"]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


def create_token(user_id: str, role: str, token_type: TokenType) -> tuple[str, str, int]:
    """Возвращает (token, jti, ttl_seconds)."""
    s = get_settings()
    ttl = (
        timedelta(minutes=s.access_token_ttl_min)
        if token_type == "access"
        else timedelta(days=s.refresh_token_ttl_days)
    )
    now = datetime.now(UTC)
    jti = uuid.uuid4().hex
    payload = {
        "sub": user_id,
        "role": role,
        "type": token_type,
        "jti": jti,
        "iat": now,
        "exp": now + ttl,
    }
    token = jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)
    return token, jti, int(ttl.total_seconds())


def decode_token(token: str, expected_type: TokenType) -> dict:
    """Бросает jwt.PyJWTError, если токен невалиден, просрочен или другого типа."""
    s = get_settings()
    payload = jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm])
    if payload.get("type") != expected_type:
        raise jwt.InvalidTokenError("wrong token type")
    return payload
