"""Заявки на регистрацию.

Самостоятельная регистрация без роли: посетитель оставляет ФИО, рабочую почту и пароль —
заявка уходит админам (колокольчик + WebSocket). Админ одобряет заявку, выбрав роль:
аккаунт создаётся сразу с паролем из заявки, — или отклоняет её.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from pymongo.errors import DuplicateKeyError

from app.api.deps import AdminUser
from app.bus import rabbit
from app.core.config import get_settings
from app.core.security import hash_password
from app.db.mongo import get_db
from app.db.redis import get_redis
from app.domain.enums import Role
from app.services.notify import deliver
from app.services.users import create_user, public_user, publish_roster_changed

router = APIRouter(tags=["registration"])


async def _rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    key = f"rl:register:{ip}"
    r = get_redis()
    count = await r.incr(key)
    if count == 1:
        await r.expire(key, 60)
    if count > get_settings().register_rate_limit_per_min:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много заявок, подождите минуту")


class RegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=8)
    fullName: str = Field(min_length=1, max_length=200)

    @field_validator("email")
    @classmethod
    def _work_domain(cls, v: str) -> str:
        v = v.strip().lower()
        if not v.endswith("@mts.ru"):
            raise ValueError("только рабочая почта домена @mts.ru")
        return v

    @field_validator("password")
    @classmethod
    def _bcrypt_limit(cls, v: str) -> str:
        if len(v.encode()) > 72:
            raise ValueError("пароль длиннее 72 байт")
        return v


class ApproveIn(BaseModel):
    role: Role = Role.COORDINATOR
    itsmLogin: str | None = Field(None, description="логин в ITSM (assignedEmployeeLogin) — для разработчиков")

    @field_validator("itsmLogin")
    @classmethod
    def _trim(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        return v if v else None


class RejectIn(BaseModel):
    reason: str | None = Field(None, max_length=500)


def public_request(doc: dict[str, Any]) -> dict[str, Any]:
    """Заявка без passwordHash — хеш не покидает сервер."""
    return {
        "id": doc["_id"],
        "email": doc["email"],
        "fullName": doc["fullName"],
        "status": doc["status"],
        "createdAt": doc.get("createdAt"),
        "decidedAt": doc.get("decidedAt"),
        "role": doc.get("role"),
        "itsmLogin": doc.get("itsmLogin"),
    }


async def _get_request(request_id: str) -> dict[str, Any]:
    doc = await get_db().registration_requests.find_one({"_id": request_id})
    if not doc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Заявка не найдена")
    return doc


@router.post("/auth/register", status_code=201, dependencies=[Depends(_rate_limit)])
async def register(body: RegisterIn) -> dict[str, Any]:
    db = get_db()
    if await db.users.find_one({"email": body.email}):
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с таким email уже есть")
    if await db.registration_requests.find_one({"email": body.email, "status": "pending"}):
        raise HTTPException(status.HTTP_409_CONFLICT, "Заявка с этой почтой уже отправлена и ждёт проверки")
    doc = {
        "_id": uuid.uuid4().hex,
        "email": body.email,
        "fullName": body.fullName.strip(),
        "passwordHash": hash_password(body.password),
        "status": "pending",
        "createdAt": datetime.now(UTC),
        "decidedAt": None,
        "decidedBy": None,
        "role": None,
        "itsmLogin": None,
        "reason": None,
    }
    await db.registration_requests.insert_one(doc)
    await deliver(
        {
            "kind": "registration.requested",
            "severity": "info",
            "title": "Новая заявка на регистрацию",
            "body": f"{doc['fullName']} · {doc['email']}",
            "incidentId": None,
            "audience": {"admins": True},
        },
        None,
    )
    await rabbit.publish("registration.created", {"request": public_request(doc)})
    return public_request(doc)


@router.get("/registration-requests")
async def list_requests(_: AdminUser) -> list[dict[str, Any]]:
    return [
        public_request(doc)
        async for doc in get_db().registration_requests.find({"status": "pending"}).sort("createdAt", 1)
    ]


@router.post("/registration-requests/{request_id}/approve")
async def approve(request_id: str, body: ApproveIn, admin: AdminUser) -> dict[str, Any]:
    doc = await _get_request(request_id)
    if doc["status"] != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "Заявка уже рассмотрена")
    try:
        user = await create_user(
            doc["email"], "", doc["fullName"], body.role, body.itsmLogin, password_hash=doc["passwordHash"]
        )
    except DuplicateKeyError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с таким email уже есть") from e
    await get_db().registration_requests.update_one(
        {"_id": request_id},
        {
            "$set": {
                "status": "approved",
                "decidedAt": datetime.now(UTC),
                "decidedBy": admin["_id"],
                "role": body.role.value,
                "itsmLogin": body.itsmLogin,
            }
        },
    )
    await rabbit.publish("registration.decided", {"id": request_id, "status": "approved", "email": doc["email"]})
    await publish_roster_changed()
    return public_user(user)


@router.post("/registration-requests/{request_id}/reject")
async def reject(request_id: str, body: RejectIn, admin: AdminUser) -> dict[str, Any]:
    doc = await _get_request(request_id)
    if doc["status"] != "pending":
        raise HTTPException(status.HTTP_409_CONFLICT, "Заявка уже рассмотрена")
    await get_db().registration_requests.update_one(
        {"_id": request_id},
        {
            "$set": {
                "status": "rejected",
                "decidedAt": datetime.now(UTC),
                "decidedBy": admin["_id"],
                "reason": body.reason,
            }
        },
    )
    await rabbit.publish("registration.decided", {"id": request_id, "status": "rejected", "email": doc["email"]})
    return public_request(await _get_request(request_id))
