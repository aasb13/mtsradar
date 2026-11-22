"""Общая выдача по оценкам сотрудников: один слой для REST (routes/ratings.py) и агента BigDad.

Анонимный отзыв отдаёт author=None всем, включая получателя.
"""

from typing import Any

from app.db.mongo import get_db


async def aggregate(user_id: str) -> dict[str, Any]:
    """Отзывы о пользователе: средняя, разбивка по звёздам, список отзывов (свежие сверху)."""
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


async def leaderboard() -> list[dict[str, Any]]:
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
    return items
