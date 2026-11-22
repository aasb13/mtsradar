"""Команды, созданные администратором (до первого инцидента с таким assignedGroupName).

Справочник assignedGroups выводится из инцидентов, поэтому команда, назначенная
до появления инцидентов, должна жить в базе — иначе она была бы видна только
тому браузеру, который её добавил. Удаление логическое: название исключается
из справочника, но остаётся в истории инцидентов.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from app.api.deps import AdminUser, StaffUser
from app.bus import rabbit
from app.core.config import get_settings
from app.db.mongo import get_db
from app.domain.classify import flags
from app.services import presenter
from app.services.store import actor_of

router = APIRouter(prefix="/teams", tags=["teams"])

MAX_NAME_LENGTH = 200


class TeamCreate(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)


class TeamRename(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)


def _clean(body_name: str) -> str:
    name = body_name.strip()
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Название не может быть пустым")
    return name


async def _alive_team(name: str) -> dict[str, Any] | None:
    return await get_db().teams.find_one({"name": name, "deletedAt": None})


async def _publish_changed() -> None:
    await rabbit.publish("team.changed", {})


@router.post("", status_code=201)
async def create(body: TeamCreate, user: AdminUser) -> dict[str, Any]:
    name = _clean(body.name)
    db = get_db()
    if await _alive_team(name):
        raise HTTPException(status.HTTP_409_CONFLICT, "Команда с таким названием уже есть")
    # имя удалённой команды можно занять заново: поднимаем старый документ вместо дубля
    await db.teams.update_one(
        {"name": name, "deletedAt": {"$ne": None}},
        {"$set": {"createdAt": datetime.now(UTC), "createdBy": actor_of(user), "deletedAt": None}},
    )
    if await _alive_team(name) is None:
        try:
            await db.teams.insert_one(
                {"_id": uuid.uuid4().hex, "name": name, "createdAt": datetime.now(UTC), "createdBy": actor_of(user), "deletedAt": None}
            )
        except DuplicateKeyError as e:
            raise HTTPException(status.HTTP_409_CONFLICT, "Команда с таким названием уже есть") from e
    await _publish_changed()
    return {"name": name}


@router.patch("/{name}")
async def rename(name: str, body: TeamRename, _: AdminUser) -> dict[str, Any]:
    old = _clean(name)
    new = _clean(body.name)
    if not await _alive_team(old):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Команда не найдена")
    if new != old and await _alive_team(new):
        raise HTTPException(status.HTTP_409_CONFLICT, "Команда с таким названием уже есть")
    if new != old:
        await get_db().teams.update_one({"name": old, "deletedAt": None}, {"$set": {"name": new}})
        await _publish_changed()
    return {"name": new}


@router.delete("/{name}", status_code=204)
async def delete(name: str, _: AdminUser) -> None:
    clean = _clean(name)
    if not await _alive_team(clean):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Команда не найдена")
    await get_db().teams.update_one({"name": clean, "deletedAt": None}, {"$set": {"deletedAt": datetime.now(UTC)}})
    await _publish_changed()


@router.get("/{name}/profile")
async def profile(name: str, _: StaffUser) -> dict[str, Any]:
    """Профиль команды: состав, назначенные и выполненные инциденты, средняя оценка.

    Команда может существовать только в инцидентах или в пользователях — тогда в
    коллекции teams её нет, но профиль всё равно должен открываться.
    """
    team_name = _clean(name)
    db = get_db()
    team = await _alive_team(team_name)
    known = (
        team is not None
        or await db.incidents.find_one({"data.assignedGroupName": team_name}) is not None
        or await db.users.find_one({"team": team_name, "deletedAt": None}) is not None
    )
    if not known:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Команда не найдена")

    s, now = get_settings(), datetime.now(UTC)
    docs = [d async for d in db.incidents.find({"meta.deletedAt": None, "data.assignedGroupName": team_name})]
    active_docs = [d for d in docs if flags(d["data"], s).is_active]
    done_docs = [d for d in docs if not flags(d["data"], s).is_active]

    accounts = [u async for u in db.users.find({"team": team_name, "deletedAt": None}).sort("fullName", 1)]
    account_ids = [u["_id"] for u in accounts]
    scores_by_user: dict[str, list[int]] = {uid: [] for uid in account_ids}
    async for r in db.ratings.find({"targetUserId": {"$in": account_ids}}):
        scores_by_user.setdefault(r["targetUserId"], []).append(r["score"])

    def belongs(d: dict[str, Any], user: dict[str, Any]) -> bool:
        data = d["data"]
        names = {n for n in (user.get("fullName"), user.get("email")) if isinstance(n, str) and n != ""}
        login = user.get("itsmLogin")
        return (
            (isinstance(login, str) and login != "" and data.get("assignedEmployeeLogin") == login)
            or data.get("assignedEmployee") in names
            or user["_id"] in (d.get("members") or [])
        )

    members: list[dict[str, Any]] = []
    for u in accounts:
        scores = scores_by_user.get(u["_id"], [])
        members.append(
            {
                "id": u["_id"],
                "name": u.get("fullName") or u["email"],
                "email": u["email"],
                "itsmLogin": u.get("itsmLogin"),
                "role": u["role"],
                "kind": "account",
                "active": sum(belongs(d, u) for d in active_docs),
                "done": sum(belongs(d, u) for d in done_docs),
                "rating": {"average": round(sum(scores) / len(scores), 2), "count": len(scores)} if scores else None,
            }
        )

    # Исполнители из ITSM, у которых нет аккаунта в системе: их names видим в инцидентах.
    account_names = {m["name"] for m in members}
    executors: list[str] = []
    for d in docs:
        executor = d["data"].get("assignedEmployee")
        if isinstance(executor, str) and executor != "" and executor not in account_names and executor not in executors:
            executors.append(executor)
    for executor in executors:
        members.append(
            {
                "id": None,
                "name": executor,
                "email": None,
                "itsmLogin": next(
                    (
                        d["data"].get("assignedEmployeeLogin")
                        for d in docs
                        if d["data"].get("assignedEmployee") == executor and d["data"].get("assignedEmployeeLogin")
                    ),
                    None,
                ),
                "role": None,
                "kind": "executor",
                "active": sum(1 for d in active_docs if d["data"].get("assignedEmployee") == executor),
                "done": sum(1 for d in done_docs if d["data"].get("assignedEmployee") == executor),
                "rating": None,
            }
        )

    all_scores = [score for scores in scores_by_user.values() for score in scores]
    assigned = [presenter.card(d, now, s) for d in active_docs]
    assigned.sort(key=presenter.sort_key)
    done = [presenter.card(d, now, s) for d in done_docs]
    done.sort(key=lambda c: c.get("completionDate") or "", reverse=True)
    return {
        "name": team_name,
        "serverTime": now,
        "createdAt": team.get("createdAt") if team else None,
        "members": members,
        "assigned": assigned,
        "done": done,
        "rating": {
            "average": round(sum(all_scores) / len(all_scores), 2) if all_scores else None,
            "count": len(all_scores),
            "ratedMembers": sum(1 for scores in scores_by_user.values() if scores),
        },
    }
