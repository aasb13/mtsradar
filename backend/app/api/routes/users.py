"""Управление пользователями (только admin). Удаление — логическое."""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from app.api.deps import AdminUser, StaffUser
from app.api.routes.my import tasks_for_user
from app.core.config import get_settings
from app.core.security import hash_password
from app.db.mongo import get_db
from app.domain.enums import Role
from app.services.users import create_user, public_user, publish_roster_changed

router = APIRouter(prefix="/users", tags=["users"])


class UserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=8, max_length=72)
    fullName: str = Field(min_length=1, max_length=200)
    role: Role = Role.COORDINATOR
    itsmLogin: str | None = Field(None, description="логин в ITSM (assignedEmployeeLogin) — для разработчиков")


class UserUpdate(BaseModel):
    fullName: str | None = Field(None, min_length=1, max_length=200)
    role: Role | None = None
    password: str | None = Field(None, min_length=8, max_length=72)
    itsmLogin: str | None = None
    team: str | None = Field(None, max_length=200, description="команда (assignedGroupName) — для разработчиков")


@router.get("")
async def list_users(_: StaffUser, role: Role | None = None, includeDeleted: bool = False) -> list[dict[str, Any]]:
    query: dict[str, Any] = {} if includeDeleted else {"deletedAt": None}
    if role:
        query["role"] = role
    return [public_user(u) async for u in get_db().users.find(query).sort("fullName", 1)]


@router.get("/{user_id}")
async def get_user(user_id: str, _: StaffUser) -> dict[str, Any]:
    u = await get_db().users.find_one({"_id": user_id})
    if not u:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    return public_user(u)


@router.get("/{user_id}/tasks")
async def user_tasks(user_id: str, _: StaffUser, includeResolved: bool = False) -> dict[str, Any]:
    """Задачи пользователя из чужого профиля — те же правила, что у /my/tasks."""
    target = await get_db().users.find_one({"_id": user_id, "deletedAt": None})
    if not target:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    s, now = get_settings(), datetime.now(UTC)
    cards = await tasks_for_user(target, includeResolved, now, s)
    return {"serverTime": now, "role": target["role"], "total": len(cards), "items": cards}


@router.post("", status_code=201)
async def create(body: UserCreate, _: AdminUser) -> dict[str, Any]:
    try:
        user = await create_user(body.email, body.password, body.fullName, body.role, body.itsmLogin)
    except DuplicateKeyError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с таким email уже есть") from e
    await publish_roster_changed(user)
    return public_user(user)


@router.patch("/{user_id}")
async def update(user_id: str, body: UserUpdate, admin: AdminUser) -> dict[str, Any]:
    if body.role is not None and user_id == admin["_id"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя изменить роль самому себе")
    upd: dict[str, Any] = {}
    if body.fullName is not None:
        upd["fullName"] = body.fullName
    if body.role is not None:
        upd["role"] = body.role.value
    if body.password:
        upd["passwordHash"] = hash_password(body.password)
    if "itsmLogin" in body.model_fields_set:
        upd["itsmLogin"] = body.itsmLogin
    if "team" in body.model_fields_set:
        upd["team"] = body.team
    if upd:
        res = await get_db().users.update_one({"_id": user_id, "deletedAt": None}, {"$set": upd})
        if res.matched_count == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
        updated = await get_db().users.find_one({"_id": user_id})
        if updated is not None:
            await publish_roster_changed(updated)
    return await get_user(user_id, admin)


@router.delete("/{user_id}", status_code=204)
async def delete(user_id: str, admin: AdminUser) -> None:
    if user_id == admin["_id"]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя удалить самого себя")
    res = await get_db().users.update_one(
        {"_id": user_id, "deletedAt": None}, {"$set": {"deletedAt": datetime.now(UTC)}}
    )
    if res.matched_count == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    deleted = await get_db().users.find_one({"_id": user_id})
    if deleted is not None:
        await publish_roster_changed(deleted)
