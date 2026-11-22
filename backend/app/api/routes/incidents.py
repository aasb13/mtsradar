"""Инциденты: дашборд (4 группы), канбан, список с фильтрами, карточка, правки, переходы,
подтверждение критических, комментарии, история. Мутации — общий слой incident_actions."""

from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.api.deps import CoordinatorUser, CurrentUser, StaffUser
from app.bus import rabbit
from app.core.config import get_settings
from app.db.mongo import get_db
from app.domain.enums import (
    CLOSED,
    GROUP_TITLES,
    RESOLVED,
    STATES,
    TRANSITIONS,
    Group,
)
from app.services import access, incident_actions, presenter
from app.services.incident_query import build_filters
from app.services.store import actor_of, get_doc

router = APIRouter(tags=["incidents"])

BOARD_COLUMNS = [0, 2, 20, 7, 10]


def _now() -> datetime:
    return datetime.now(UTC)


async def _doc_or_404(incident_id: str, include_deleted: bool = False) -> dict[str, Any]:
    doc = await get_doc(incident_id)
    if not doc or (doc["meta"].get("deletedAt") and not include_deleted):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Инцидент не найден")
    return doc


def _visible_query(s, now: datetime) -> dict[str, Any]:
    """Активные + решённые критические, которые ещё показываются с отметкой «решён»."""
    return {
        "meta.deletedAt": None,
        "$or": [
            {"meta.isActive": True},
            {
                "meta.isCritical": True,
                "meta.resolvedAt": {"$gte": now - timedelta(minutes=s.critical_resolved_visible_minutes)},
            },
        ],
    }


# ---------------- дашборд ----------------


@router.get("/dashboard")
async def dashboard(_: StaffUser) -> dict[str, Any]:
    """Всё для главного экрана одним запросом. Дальше фронт живёт на WS-событиях."""
    s, now = get_settings(), _now()
    cards = [presenter.card(d, now, s) async for d in get_db().incidents.find(_visible_query(s, now))]
    groups: dict[str, list[dict[str, Any]]] = {g.value: [] for g in Group}
    for c in cards:
        for g in c["groups"]:
            groups[g].append(c)
    for g in groups.values():
        g.sort(key=presenter.sort_key)

    day_start = now.astimezone(_tz(s.business_tz)).replace(hour=0, minute=0, second=0, microsecond=0)
    resolved_today = await get_db().incidents.count_documents(
        {"meta.deletedAt": None, "meta.resolvedAt": {"$gte": day_start}}
    )
    active = [c for c in cards if c["isActive"]]
    return {
        "serverTime": now,
        "groupTitles": {g.value: t for g, t in GROUP_TITLES.items()},
        "kpi": {
            "active": len(active),
            "critical": sum(1 for c in groups["critical"] if not c["isResolved"]),
            "coordinators": len(groups["coordinators"]),
            "high": len(groups["high"]),
            "research": len(groups["research"]),
            "breached": sum(1 for c in active if c["sla"]["state"] == "breached"),
            "resolvedToday": resolved_today,
        },
        # критические, которые ещё никто не подтвердил — баннер не должен исчезать сам
        "unacknowledgedCritical": [
            c["id"] for c in groups["critical"] if not c["isResolved"] and not c["acknowledged"]
        ],
        "groups": groups,
    }


def _tz(name: str):
    from zoneinfo import ZoneInfo

    return ZoneInfo(name)


# ---------------- канбан ----------------


@router.get("/board")
async def board(
    _: StaffUser,
    priorityId: list[int] | None = Query(None),
    assignedGroupName: str | None = None,
    productName: str | None = None,
    q: str | None = None,
    closedLimit: int = Query(30, ge=0, le=500),
) -> dict[str, Any]:
    s, now = get_settings(), _now()
    query = build_filters(
        priorityId=priorityId, assignedGroupName=assignedGroupName, productName=productName, q=q
    )
    columns = {sid: [] for sid in BOARD_COLUMNS}
    async for d in get_db().incidents.find(query):
        sid = d["data"]["stateId"]
        columns.setdefault(sid, []).append(presenter.card(d, now, s))
    out = []
    for sid, items in columns.items():
        if sid in (RESOLVED, CLOSED):
            items.sort(key=lambda c: c["completionDate"] or c["submitDate"], reverse=True)
            items = items[:closedLimit] if sid == CLOSED else items
        else:
            items.sort(key=presenter.sort_key)
        title = STATES.get(sid, (f"Статус {sid}", ""))[0]
        out.append({"stateId": sid, "title": title, "count": len(items), "cards": items})
    return {"serverTime": now, "columns": out, "transitions": {k: sorted(v) for k, v in TRANSITIONS.items()}}


# ---------------- список ----------------


@router.get("/incidents")
async def list_incidents(
    _: StaffUser,
    group: Group | None = None,
    stateId: list[int] | None = Query(None),
    priorityId: list[int] | None = Query(None),
    assignedGroupName: str | None = None,
    productName: str | None = None,
    slaState: list[Literal["ok", "warning", "danger", "breached", "none", "resolved"]] | None = Query(None),
    active: bool | None = None,
    q: str | None = Query(None, description="поиск по номеру, заголовку, описанию, сервису"),
    includeDeleted: bool = False,
    sort: Literal["attention", "deadline", "submitDate", "priority"] = "attention",
    order: Literal["asc", "desc"] = "asc",
    page: int = Query(1, ge=1),
    perPage: int = Query(50, ge=1, le=500),
) -> dict[str, Any]:
    s, now = get_settings(), _now()
    query = build_filters(
        priorityId=priorityId,
        stateId=stateId,
        assignedGroupName=assignedGroupName,
        productName=productName,
        q=q,
        group=group,
        active=active,
        includeDeleted=includeDeleted,
    )
    # SLA зависит от текущего времени, поэтому фильтр/сортировку по нему делаем в Python.
    # Для объёмов кейса (сотни-тысячи) это быстро; при росте — пересчитывать sla в фоне.
    cards = [presenter.card(d, now, s) async for d in get_db().incidents.find(query)]
    if slaState:
        cards = [c for c in cards if c["sla"]["state"] in slaState]
    far = datetime.max.replace(tzinfo=UTC)
    keys = {
        "attention": presenter.sort_key,
        "deadline": lambda c: c["deadline"] or far,
        "submitDate": lambda c: c["submitDate"],
        "priority": lambda c: -c["priorityId"],
    }
    cards.sort(key=keys[sort], reverse=(order == "desc"))
    total = len(cards)
    start = (page - 1) * perPage
    return {
        "serverTime": now,
        "items": cards[start : start + perPage],
        "total": total,
        "page": page,
        "perPage": perPage,
    }


@router.get("/incidents/{incident_id}")
async def get_incident(incident_id: str, user: CurrentUser) -> dict[str, Any]:
    doc = await _doc_or_404(incident_id, include_deleted=True)
    if not access.can_view(user, doc):  # разработчику — только его инциденты
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Инцидент не найден")
    out = presenter.detail(doc, _now())
    out["allowedTransitions"] = sorted(TRANSITIONS.get(doc["data"]["stateId"], ()))
    return out


# ---------------- изменения от координатора ----------------


class IncidentPatch(BaseModel):
    """Изменения, которые в реальности пришли бы из ITSM; на демо — альтернативный сценарий."""

    priorityId: int | None = Field(None, ge=1, le=4)
    deadline: datetime | None = None
    assignedGroupName: str | None = Field(None, min_length=1)
    assignedEmployee: str | None = None
    assignedEmployeeLogin: str | None = None
    header: str | None = Field(None, min_length=1)
    shortDescription: str | None = None
    description: str | None = None
    expectedVersion: int | None = Field(None, description="если задан — 409 при несовпадении версии")


async def _save(doc: dict[str, Any], data: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    try:
        updated = await incident_actions.apply_patch(doc, data, user)
    except incident_actions.ConflictError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, "Инцидент изменился, обновите карточку") from e
    return presenter.detail(updated, _now())


@router.patch("/incidents/{incident_id}")
async def patch_incident(incident_id: str, body: IncidentPatch, user: CoordinatorUser) -> dict[str, Any]:
    doc = await _doc_or_404(incident_id)
    if body.expectedVersion is not None and body.expectedVersion != doc["meta"]["version"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "Инцидент изменился, обновите карточку")
    fields = body.model_dump(exclude_unset=True, exclude={"expectedVersion"})
    return await _save(doc, fields, user)


class TransitionIn(BaseModel):
    toStateId: int
    stateReason: str | None = None
    solution: str | None = None
    comment: str | None = Field(None, max_length=5000)


@router.post("/incidents/{incident_id}/transition")
async def transition(incident_id: str, body: TransitionIn, user: CoordinatorUser) -> dict[str, Any]:
    doc = await _doc_or_404(incident_id)
    try:
        result = await incident_actions.apply_transition(
            doc, body.toStateId, state_reason=body.stateReason, solution=body.solution, user=user
        )
    except incident_actions.ClosedError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    except incident_actions.InvalidTransitionError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    except incident_actions.ConflictError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, "Инцидент изменился, обновите карточку") from e
    if body.comment:
        await incident_actions.add_comment(incident_id, body.comment, user)
    return presenter.detail(result, _now())


@router.post("/incidents/{incident_id}/ack")
async def acknowledge(incident_id: str, user: CoordinatorUser) -> dict[str, Any]:
    """«Принял в работу» по критическому — баннер у всех координаторов гаснет."""
    doc = await _doc_or_404(incident_id)
    return await incident_actions.acknowledge(doc, user)


@router.delete("/incidents/{incident_id}", status_code=204)
async def delete_incident(incident_id: str, user: CoordinatorUser) -> None:
    doc = await _doc_or_404(incident_id)
    await incident_actions.archive(doc, user)


@router.post("/incidents/{incident_id}/restore")
async def restore_incident(incident_id: str, user: CoordinatorUser) -> dict[str, Any]:
    doc = await _doc_or_404(incident_id, include_deleted=True)
    if not doc["meta"].get("deletedAt"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Инцидент не в архиве")
    return await _save(doc, dict(doc["data"]), user)


# ---------------- история и комментарии ----------------


@router.get("/incidents/{incident_id}/history")
async def history(incident_id: str, _: StaffUser, limit: int = Query(100, ge=1, le=1000)) -> list[dict[str, Any]]:
    await _doc_or_404(incident_id, include_deleted=True)
    cursor = get_db().incident_events.find({"incidentId": incident_id}).sort("at", -1).limit(limit)
    return [presenter.public(e) async for e in cursor]


class CommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


@router.get("/incidents/{incident_id}/comments")
async def list_comments(incident_id: str, _: StaffUser) -> list[dict[str, Any]]:
    cursor = get_db().comments.find({"incidentId": incident_id, "deletedAt": None}).sort("createdAt", 1)
    return [presenter.public(c) async for c in cursor]


@router.post("/incidents/{incident_id}/comments", status_code=201)
async def add_comment(incident_id: str, body: CommentIn, user: StaffUser) -> dict[str, Any]:
    await _doc_or_404(incident_id)
    return await incident_actions.add_comment(incident_id, body.text, user)


@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(comment_id: str, user: CurrentUser) -> None:
    c = await get_db().comments.find_one({"_id": comment_id, "deletedAt": None})
    if not c:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Комментарий не найден")
    if c["author"]["id"] != user["_id"] and user["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Удалять можно только свои комментарии")
    await get_db().comments.update_one({"_id": comment_id}, {"$set": {"deletedAt": _now()}})


# ---------------- участники (разработчики) ----------------


class MemberIn(BaseModel):
    userId: str


async def _members_changed(
    incident_id: str, user: dict[str, Any], added: list[str], removed: list[str]
) -> dict[str, Any]:
    now = _now()
    doc = await get_doc(incident_id)
    await get_db().incident_events.insert_one(
        {
            "incidentId": incident_id,
            "at": now,
            "type": "members_changed",
            "source": "api",
            "actor": actor_of(user),
            "kinds": ["members_changed"],
            "changes": [{"field": "members", "added": added, "removed": removed}],
            "groupsEntered": [],
            "groupsLeft": [],
        }
    )
    card = presenter.card(doc, now)
    await rabbit.publish(
        "incident.members_changed",
        {"incidentId": incident_id, "actor": actor_of(user), "added": added, "removed": removed, "card": card},
    )
    return card


@router.post("/incidents/{incident_id}/members")
async def add_member(incident_id: str, body: MemberIn, user: CoordinatorUser) -> dict[str, Any]:
    """Добавить разработчика в инцидент: он увидит инцидент в приложении и получит уведомление."""
    await _doc_or_404(incident_id)
    dev = await get_db().users.find_one({"_id": body.userId, "deletedAt": None})
    if not dev or dev["role"] != "developer":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Добавлять можно только пользователей с ролью developer"
        )
    res = await get_db().incidents.update_one({"_id": incident_id}, {"$addToSet": {"members": body.userId}})
    if res.modified_count == 0:
        return presenter.card(await get_doc(incident_id), _now())  # уже был добавлен
    return await _members_changed(incident_id, user, [body.userId], [])


@router.delete("/incidents/{incident_id}/members/{member_id}")
async def remove_member(incident_id: str, member_id: str, user: CoordinatorUser) -> dict[str, Any]:
    await _doc_or_404(incident_id)
    res = await get_db().incidents.update_one({"_id": incident_id}, {"$pull": {"members": member_id}})
    if res.modified_count == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не был добавлен в инцидент")
    return await _members_changed(incident_id, user, [], [member_id])
