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

from app.api.deps import AdminUser
from app.bus import rabbit
from app.db.mongo import get_db
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
