"""Пользователи нашей системы (координаторы и админы — не путать с исполнителями из ITSM)."""

import uuid
from datetime import UTC, datetime
from typing import Any

from app.core.security import hash_password
from app.db.mongo import get_db
from app.domain.enums import Role

NOTIFICATION_KINDS = {
    "incident.assigned_to_me": "Вас добавили в инцидент (для разработчиков)",
    "incident.new": "Появился новый инцидент",
    "critical.new": "Новый критический инцидент",
    "critical.resolved": "Критический инцидент решён",
    "coordinators.assigned": "Инцидент назначен на координаторов",
    "high.new": "Новый инцидент с высоким приоритетом",
    "sla.danger": "Срок решения скоро истечёт",
    "sla.breached": "Срок решения нарушен",
}


def default_notification_settings() -> dict[str, Any]:
    return {
        "inApp": True,
        "push": True,
        "telegram": False,
        "email": False,
        "kinds": dict.fromkeys(NOTIFICATION_KINDS, True),
    }


def public_user(u: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": u["_id"],
        "email": u["email"],
        "fullName": u.get("fullName"),
        "role": u["role"],
        "itsmLogin": u.get("itsmLogin"),
        "telegramChatId": u.get("telegramChatId"),
        "notificationSettings": u.get("notificationSettings") or default_notification_settings(),
        "createdAt": u.get("createdAt"),
        "deletedAt": u.get("deletedAt"),
    }


async def create_user(
    email: str, password: str, full_name: str, role: Role, itsm_login: str | None = None
) -> dict[str, Any]:
    doc = {
        "_id": uuid.uuid4().hex,
        "email": email.strip().lower(),
        "fullName": full_name,
        "role": role.value,
        "itsmLogin": itsm_login,
        "passwordHash": hash_password(password),
        "telegramChatId": None,
        "notificationSettings": default_notification_settings(),
        "createdAt": datetime.now(UTC),
        "deletedAt": None,
    }
    await get_db().users.insert_one(doc)
    return doc


async def ensure_bootstrap_admin(email: str, password: str) -> None:
    if await get_db().users.count_documents({}) == 0:
        await create_user(email, password, "Администратор", Role.ADMIN)


async def recipients(kind: str) -> list[dict[str, Any]]:
    """Кому слать уведомление данного вида: координаторы и админы, у кого вид не выключен."""
    return await _filter_by_kind(
        get_db().users.find({"deletedAt": None, "role": {"$in": [Role.COORDINATOR, Role.ADMIN]}}), kind
    )


async def developers_for(kind: str, *, logins: list[str] = (), user_ids: list[str] = ()) -> list[dict[str, Any]]:
    """Разработчики-адресаты: по логину исполнителя в ITSM и/или по id (добавлены в инцидент)."""
    ors: list[dict[str, Any]] = []
    if logins:
        ors.append({"itsmLogin": {"$in": [x for x in logins if x]}})
    if user_ids:
        ors.append({"_id": {"$in": list(user_ids)}})
    if not ors:
        return []
    return await _filter_by_kind(get_db().users.find({"deletedAt": None, "role": Role.DEVELOPER, "$or": ors}), kind)


async def _filter_by_kind(cursor, kind: str) -> list[dict[str, Any]]:
    out = []
    async for u in cursor:
        settings = u.get("notificationSettings") or default_notification_settings()
        if settings.get("kinds", {}).get(kind, True):
            out.append(u)
    return out
