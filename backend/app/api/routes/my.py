"""Эндпоинты для мобильного приложения и профиля.

GET  /api/my/incidents        — инциденты, видимые текущему пользователю, по уровням приоритета 4..1
GET  /api/my/tasks            — задачи текущего пользователя (учитывает роль)
POST /api/devices             — зарегистрировать FCM-токен устройства для push-уведомлений
POST /api/devices/unregister  — отвязать токен (при выходе из приложения)
"""

from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser
from app.core.config import get_settings
from app.db.mongo import get_db
from app.domain.enums import CLOSED, PRIORITIES, RESOLVED, Role
from app.services import access, presenter

router = APIRouter(tags=["mobile"])

LEVELS = (4, 3, 2, 1)


@router.get("/my/incidents")
async def my_incidents(user: CurrentUser, includeResolved: bool = False) -> dict[str, Any]:
    """Координатор/админ/наблюдатель — все текущие инциденты; разработчик — только свои.
    «Текущие» = не Завершен и не Закрыт (includeResolved=true покажет и их)."""
    s, now = get_settings(), datetime.now(UTC)
    query: dict[str, Any] = {"meta.deletedAt": None, **access.mongo_filter(user)}
    if not includeResolved:
        query["meta.isActive"] = True
    cards = [presenter.card(d, now, s) async for d in get_db().incidents.find(query)]
    cards.sort(key=presenter.sort_key)
    by_level: dict[int, list[dict[str, Any]]] = {p: [] for p in LEVELS}
    for c in cards:
        by_level.setdefault(c["priorityId"], []).append(c)
    return {
        "serverTime": now,
        "role": user["role"],
        "total": len(cards),
        "levels": [
            {
                "priorityId": p,
                "title": f"{p} уровень",
                "name": PRIORITIES.get(p, str(p)),
                "count": len(by_level.get(p, [])),
                "items": by_level.get(p, []),
            }
            for p in LEVELS
        ],
    }


async def tasks_for_user(user: dict[str, Any], include_resolved: bool, now: datetime, s: Any) -> list[dict[str, Any]]:
    """Задачи пользователя с учётом его роли — инциденты, в которых участвует лично он.

    разработчик — где он исполнитель в ITSM или добавлен участником (правила access);
    тестировщик — инциденты, ждущие проверки (Завершен; с include_resolved — и Закрытые);
    координатор/админ — принятые им в работу (ack) и где он добавлен участником.
    """
    query: dict[str, Any] = {"meta.deletedAt": None}
    if user["role"] == Role.DEVELOPER:
        query.update(access.mongo_filter(user))
        if not include_resolved:
            query["meta.isActive"] = True
    elif user["role"] == Role.VIEWER:
        query["data.stateId"] = {"$in": [RESOLVED, CLOSED] if include_resolved else [RESOLVED]}
    else:
        query["$or"] = [{"ack.userId": user["_id"]}, {"members": user["_id"]}]
        if not include_resolved:
            query["meta.isActive"] = True
    cards = [presenter.card(d, now, s) async for d in get_db().incidents.find(query)]
    cards.sort(key=presenter.sort_key)
    return cards


@router.get("/my/tasks")
async def my_tasks(user: CurrentUser, includeResolved: bool = False) -> dict[str, Any]:
    s, now = get_settings(), datetime.now(UTC)
    cards = await tasks_for_user(user, includeResolved, now, s)
    return {"serverTime": now, "role": user["role"], "total": len(cards), "items": cards}


class DeviceIn(BaseModel):
    token: str = Field(min_length=10, max_length=4096, description="FCM registration token")
    platform: Literal["android", "ios", "web"] = "android"


class DeviceOut(BaseModel):
    token: str


@router.post("/devices")
async def register_device(body: DeviceIn, user: CurrentUser) -> dict[str, Any]:
    """Один токен — одно устройство. Если на телефоне вошёл другой пользователь, токен переходит к нему."""
    now = datetime.now(UTC)
    await get_db().devices.update_one(
        {"_id": body.token},
        {
            "$set": {"userId": user["_id"], "platform": body.platform, "lastSeenAt": now},
            "$setOnInsert": {"createdAt": now},
        },
        upsert=True,
    )
    return {"ok": True}


@router.post("/devices/unregister")
async def unregister_device(body: DeviceOut, user: CurrentUser) -> dict[str, Any]:
    res = await get_db().devices.delete_one({"_id": body.token, "userId": user["_id"]})
    return {"ok": True, "removed": res.deleted_count}
