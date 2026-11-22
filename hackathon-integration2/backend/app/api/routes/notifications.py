"""Центр уведомлений (колокольчик). Новые уведомления также приходят по WebSocket."""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status

from app.api.deps import CurrentUser
from app.db.mongo import get_db
from app.services.presenter import public

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
async def list_notifications(
    user: CurrentUser, unreadOnly: bool = False, limit: int = Query(50, ge=1, le=500)
) -> dict[str, Any]:
    query: dict[str, Any] = {"userId": user["_id"]}
    if unreadOnly:
        query["readAt"] = None
    items = [public(n) async for n in get_db().notifications.find(query).sort("createdAt", -1).limit(limit)]
    unread = await get_db().notifications.count_documents({"userId": user["_id"], "readAt": None})
    return {"items": items, "unread": unread}


@router.post("/{notification_id}/read")
async def mark_read(notification_id: str, user: CurrentUser) -> dict[str, Any]:
    res = await get_db().notifications.update_one(
        {"_id": notification_id, "userId": user["_id"]}, {"$set": {"readAt": datetime.now(UTC)}}
    )
    if res.matched_count == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Уведомление не найдено")
    return {"ok": True}


@router.post("/read-all")
async def mark_all_read(user: CurrentUser) -> dict[str, Any]:
    res = await get_db().notifications.update_many(
        {"userId": user["_id"], "readAt": None}, {"$set": {"readAt": datetime.now(UTC)}}
    )
    return {"marked": res.modified_count}
