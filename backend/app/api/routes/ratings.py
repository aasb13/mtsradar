"""Оценки сотрудников: любой пользователь может оценить любого другого.

Оценка — 1–5 звёзд с комментарием. Автор оценки хранится всегда; anonymous=True
скрывает его в выдаче (анонимный отзыв), в том числе от самого автора.
Получатель получает уведомление (in-app / Telegram / push — общая доставка).
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.api.deps import CurrentUser
from app.db.mongo import get_db
from app.domain.enums import STAFF_ROLES
from app.services.notify import deliver

router = APIRouter(tags=["ratings"])


class RatingIn(BaseModel):
    score: int = Field(ge=1, le=5)
    comment: str = Field("", max_length=1000)
    anonymous: bool = False


async def _aggregate(user_id: str) -> dict[str, Any]:
    docs = [d async for d in get_db().ratings.find({"targetUserId": user_id}).sort("createdAt", -1)]
    scores = [d["score"] for d in docs]
    distribution: dict[int, int] = {s: 0 for s in (1, 2, 3, 4, 5)}
    for s in scores:
        distribution[s] += 1
    author_ids = {d["authorUserId"] for d in docs if not d.get("anonymous")}
    authors = {
        u["_id"]: u
        async for u in get_db().users.find({"_id": {"$in": list(author_ids)}})
    }
    items = [
        {
            "id": d["_id"],
            "score": d["score"],
            "comment": d["comment"],
            "createdAt": d["createdAt"],
            "anonymous": d.get("anonymous", False),
            "author": None
            if d.get("anonymous")
            else {
                "id": d["authorUserId"],
                "name": authors.get(d["authorUserId"], {}).get("fullName")
                or authors.get(d["authorUserId"], {}).get("email")
                or "Сотрудник",
            },
        }
        for d in docs
    ]
    return {
        "userId": user_id,
        "average": round(sum(scores) / len(scores), 2) if scores else None,
        "count": len(docs),
        "distribution": distribution,
        "items": items,
    }


@router.get("/users/{user_id}/ratings")
async def list_ratings(user_id: str, viewer: CurrentUser) -> dict[str, Any]:
    """Отзывы о пользователе: свои — всегда, чужие — только сотрудники."""
    if viewer["_id"] != user_id and viewer["role"] not in STAFF_ROLES:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Чужие рейтинги видят только сотрудники")
    target = await get_db().users.find_one({"_id": user_id, "deletedAt": None})
    if not target:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    return await _aggregate(user_id)


@router.post("/users/{user_id}/ratings", status_code=201)
async def rate_user(user_id: str, body: RatingIn, author: CurrentUser) -> dict[str, Any]:
    if user_id == author["_id"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя оценить самого себя")
    target = await get_db().users.find_one({"_id": user_id, "deletedAt": None})
    if not target:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    doc = {
        "_id": uuid.uuid4().hex,
        "targetUserId": user_id,
        "authorUserId": author["_id"],
        "score": body.score,
        "comment": body.comment.strip(),
        "anonymous": body.anonymous,
        "createdAt": datetime.now(UTC),
    }
    await get_db().ratings.insert_one(doc)

    title = f"{author.get('fullName') or author['email']} оценил вас на {body.score} из 5"
    if body.anonymous:
        title = f"Вам поставили оценку {body.score} из 5 — анонимный отзыв"
    await deliver(
        {
            "kind": "rating.received",
            "severity": "success" if body.score >= 4 else "info",
            "title": title,
            "body": body.comment.strip() or "Без комментария",
            "incidentId": None,
            "audience": {"anyUsers": [user_id]},
        },
        None,
    )
    return await _aggregate(user_id)


@router.get("/ratings/leaderboard")
async def leaderboard(_: CurrentUser) -> dict[str, Any]:
    """Рейтинг всех сотрудников: средняя оценка и число голосов; без оценок — в конце."""
    agg = {
        row["_id"]: {"average": round(row["avg"], 2), "count": row["count"]}
        async for row in await get_db().ratings.aggregate(
            [
                {"$group": {"_id": "$targetUserId", "avg": {"$avg": "$score"}, "count": {"$sum": 1}}},
            ]
        )
    }
    items: list[dict[str, Any]] = []
    async for u in get_db().users.find({"deletedAt": None}):
        stat = agg.get(u["_id"])
        items.append(
            {
                "userId": u["_id"],
                "fullName": u.get("fullName") or u["email"],
                "role": u["role"],
                "team": u.get("team"),
                "average": stat["average"] if stat else None,
                "count": stat["count"] if stat else 0,
            }
        )
    items.sort(key=lambda x: (x["average"] is None, -(x["average"] or 0), -x["count"], x["fullName"]))
    return {"items": items}
