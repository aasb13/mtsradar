"""Действия координатора над инцидентом — общий код для REST (routes/incidents.py)
и ИИ-агента (app/ai/chat_tools.py).

ИИ исполняет те же функции, что и кнопки в интерфейсе, поэтому «агент может только то,
что может сам пользователь» выполняется по построению. Здесь нет проверки ролей:
маршруты защищены зависимостями FastAPI (CoordinatorUser и т.п.), агент — своей матрицей
прав (app/ai/chat_tools.can). Слой только исполняет и пишет историю/события как обычно.

Ошибки наружу отдаются доменными исключениями (ClosedError, InvalidTransitionError,
ConflictError) — маршруты переводят их в HTTP-коды, агент возвращает модели текстом.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from app.bus import rabbit
from app.db.mongo import get_db
from app.domain.enums import CLOSED, FINAL_STATE_IDS, PRIORITIES, RESOLVED, Role, STATES, TRANSITIONS
from app.domain.normalize import reconcile_codes, sanitize, to_ms_utc
from app.services import presenter
from app.services.exporter import maybe_write_back
from app.services.store import ConflictError as ConflictError  # re-export: маршруты ловят его отсюда
from app.services.store import actor_of, archive_incident, get_doc, save_incident


def _now() -> datetime:
    return datetime.now(UTC)


class ClosedError(ValueError):
    """Инцидент в конечном статусе — изменения запрещены."""


class InvalidTransitionError(ValueError):
    """Переход статуса не разрешён процессом."""


class NoDeadlineError(ValueError):
    """Замораживать нечего: у инцидента нет срока."""


async def _save(doc: dict[str, Any], data: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    reconcile_codes(data, doc["data"])
    sanitize(data)
    await save_incident(data, source="api", actor=actor_of(user), prev_doc=doc)
    await maybe_write_back()
    return await get_doc(doc["_id"])


async def apply_patch(doc: dict[str, Any], fields: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    """Правка полей карточки: приоритет, срок, команда/исполнитель, заголовки."""
    data = dict(doc["data"])
    if "priorityId" in fields:
        data["priority"] = PRIORITIES[fields["priorityId"]]
    if "deadline" in fields:
        fields["deadline"] = to_ms_utc(fields["deadline"])
    if "assignedGroupName" in fields and fields["assignedGroupName"] != data.get("assignedGroupName"):
        data["lastAssignmentToTeamDateTime"] = to_ms_utc(_now())
    # назначение команды координатором — это и есть «распределить»: маршрут из «Ваших инцидентов» закрыт.
    # Подтверждение прежней команды тоже считается: штампуем время назначения, иначе diff пуст
    # и save_incident не сохранил бы закрытие маршрута
    route = doc.get("route")
    if "assignedGroupName" in fields and route is not None and route.get("doneAt") is None:
        route["doneAt"] = _now()
        data["lastAssignmentToTeamDateTime"] = to_ms_utc(_now())
    data.update(fields)
    return await _save(doc, data, user)


async def apply_transition(
    doc: dict[str, Any],
    to_state_id: int,
    *,
    state_reason: str | None = None,
    solution: str | None = None,
    user: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Переход статуса по процессу; completionDate ставится/сбрасывается как в REST."""
    data = dict(doc["data"])
    current = data["stateId"]
    if current in FINAL_STATE_IDS:
        raise ClosedError("Инцидент закрыт — при повторе проблемы заводится новый")
    if to_state_id not in TRANSITIONS.get(current, ()):
        allowed = sorted(TRANSITIONS.get(current, ()))
        raise InvalidTransitionError(f"Переход {current} -> {to_state_id} запрещён; можно: {allowed}")
    data["stateId"] = to_state_id
    data["state"], data["stateEnum"] = STATES[to_state_id]
    now = to_ms_utc(_now())
    if to_state_id in (RESOLVED, CLOSED) and not data.get("completionDate"):
        data["completionDate"] = now
    if to_state_id == 2 and current == RESOLVED:  # возврат в работу
        data["completionDate"] = None
    if state_reason is not None:
        data["stateReason"] = state_reason
    if solution is not None:
        data["solution"] = solution
    return await _save(doc, data, user or {})


async def acknowledge(doc: dict[str, Any], user: dict[str, Any]) -> dict[str, Any]:
    """«Принял в работу» по критическому — баннер у всех координаторов гаснет."""
    incident_id = doc["_id"]
    now = _now()
    ack = {"userId": user["_id"], "name": user.get("fullName"), "at": now}
    await get_db().incidents.update_one({"_id": incident_id}, {"$set": {"ack": ack}})
    await get_db().incident_events.insert_one(
        {
            "incidentId": incident_id,
            "at": now,
            "type": "acknowledged",
            "source": "api",
            "actor": actor_of(user),
            "kinds": ["acknowledged"],
            "changes": [],
            "groupsEntered": [],
            "groupsLeft": [],
        }
    )
    doc["ack"] = ack
    card = presenter.card(doc, now)
    await rabbit.publish(
        "incident.acknowledged", {"incidentId": incident_id, "actor": actor_of(user), "card": card}
    )
    return card


async def freeze(
    doc: dict[str, Any],
    *,
    reason: str,
    comment: str | None = None,
    auto_unfreeze_at: datetime | None = None,
    user: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Пауза SLA: meta.freeze ставится в Mongo, sla_monitor перестаёт брать инцидент в работу,
    карточка показывает SLA на момент начала паузы. Дедлайн при заморозке не трогается —
    он сдвигается один раз при разморозке на длительность паузы."""
    incident_id = doc["_id"]
    if doc["meta"].get("deletedAt"):
        raise ConflictError("Инцидент в архиве")
    if doc["data"].get("stateId") in FINAL_STATE_IDS:
        raise ClosedError("Инцидент закрыт — при повторе проблемы заводится новый")
    if doc["data"].get("deadline") is None:
        raise NoDeadlineError("У инцидента нет срока")
    if (doc["meta"].get("freeze") or {}).get("startedAt") is not None:
        raise ConflictError("Инцидент уже заморожен")
    now = _now()
    freeze_meta = {
        "startedAt": now,
        "endsAt": to_ms_utc(auto_unfreeze_at) if auto_unfreeze_at is not None else None,
        "reason": reason,
        "actor": actor_of(user),
    }
    # "$exists": False в фильтре — двойная заморозка невозможна и на уровне записи
    res = await get_db().incidents.update_one(
        {"_id": incident_id, "meta.freeze.startedAt": {"$exists": False}},
        {"$set": {"meta.freeze": freeze_meta}},
    )
    if res.matched_count == 0:
        raise ConflictError("Инцидент изменился, обновите карточку")
    await get_db().incident_events.insert_one(
        {
            "incidentId": incident_id,
            "at": now,
            "type": "frozen",
            "source": "api",
            "actor": actor_of(user),
            "kinds": ["frozen"],
            "changes": [],
            "groupsEntered": [],
            "groupsLeft": [],
            "reason": reason,
        }
    )
    doc["meta"]["freeze"] = freeze_meta
    card = presenter.card(doc, now)
    await rabbit.publish(
        "incident.frozen", {"incidentId": incident_id, "auto": False, "actor": actor_of(user), "card": card}
    )
    if comment:
        await add_comment(incident_id, comment, user)
    return card


def unfreeze_deadline(deadline: datetime | None, started_at: datetime, now: datetime) -> datetime | None:
    """Дедлайн после разморозки: текущий + длительность паузы (сдвиг, а не накопление секунд)."""
    if deadline is None:
        return None
    paused = max(0.0, (now - started_at).total_seconds())
    return to_ms_utc(deadline + timedelta(seconds=paused))


async def unfreeze(
    doc: dict[str, Any], *, user: dict[str, Any] | None = None, auto: bool = False
) -> dict[str, Any]:
    """Снятие паузы: meta.freeze убирается целиком ($unset, чтобы работал $exists-фильтр
    sla_monitor), дедлайн сдвигается на длительность заморозки. Воркер вызывает ту же
    функцию по расписанию для авто-разморозки (auto=True)."""
    incident_id = doc["_id"]
    freeze_meta = doc["meta"].get("freeze") or {}
    started_at = freeze_meta.get("startedAt")
    if started_at is None:
        raise ConflictError("Инцидент не заморожен")
    if doc["meta"].get("deletedAt"):
        raise ConflictError("Инцидент в архиве")
    now = _now()
    old_deadline = doc["data"].get("deadline")
    new_deadline = unfreeze_deadline(old_deadline, started_at, now)
    update: dict[str, Any] = {"$set": {"meta.updatedAt": now}, "$unset": {"meta.freeze": ""}}
    if new_deadline != old_deadline:
        update["$set"]["data.deadline"] = new_deadline
    res = await get_db().incidents.update_one(
        {"_id": incident_id, "meta.freeze.startedAt": {"$exists": True}}, update
    )
    if res.matched_count == 0:
        raise ConflictError("Инцидент изменился, обновите карточку")
    await get_db().incident_events.insert_one(
        {
            "incidentId": incident_id,
            "at": now,
            "type": "unfrozen",
            "source": "system" if auto else "api",
            "actor": actor_of(user),
            "kinds": ["unfrozen"],
            "changes": [{"field": "deadline", "old": old_deadline, "new": new_deadline}]
            if new_deadline != old_deadline
            else [],
            "groupsEntered": [],
            "groupsLeft": [],
            "auto": auto,
        }
    )
    doc["meta"].pop("freeze", None)
    doc["meta"]["updatedAt"] = now
    if new_deadline is not None:
        doc["data"]["deadline"] = new_deadline
    card = presenter.card(doc, now)
    await rabbit.publish(
        "incident.unfrozen", {"incidentId": incident_id, "auto": auto, "actor": actor_of(user), "card": card}
    )
    return card


async def unfreeze_due() -> int:
    """Авто-разморозка по endsAt; вызывается воркером с той же периодичностью, что и SLA-контроль."""
    now = _now()
    count = 0
    query = {"meta.deletedAt": None, "meta.freeze.endsAt": {"$ne": None, "$lte": now}}
    async for doc in get_db().incidents.find(query):
        try:
            await unfreeze(doc, auto=True)
        except ConflictError:
            continue  # разморожена вручную, пока воркер обрабатывал выборку
        count += 1
    return count


async def add_comment(incident_id: str, text: str, user: dict[str, Any]) -> dict[str, Any]:
    now = _now()
    comment = {
        "_id": uuid.uuid4().hex,
        "incidentId": incident_id,
        "author": actor_of(user),
        "text": text,
        "createdAt": now,
        "deletedAt": None,
    }
    await get_db().comments.insert_one(comment)
    await rabbit.publish(
        "incident.comment_added", {"incidentId": incident_id, "comment": presenter.public(comment)}
    )
    return presenter.public(comment)


async def add_member(incident_id: str, dev: dict[str, Any], user: dict[str, Any]) -> bool:
    """Добавить разработчика в участники: он увидит инцидент и получит уведомление.

    Общий код REST (routes/incidents.py) и ИИ-агента (chat_tools.py) — назначение исполнителя
    без ITSM-логина даёт доступ только через участие. False — уже был в участниках.
    """
    if dev.get("role") != Role.DEVELOPER:
        raise ValueError("Добавлять можно только пользователей с ролью developer")
    now = _now()
    res = await get_db().incidents.update_one({"_id": incident_id}, {"$addToSet": {"members": dev["_id"]}})
    if res.modified_count == 0:
        return False
    await get_db().incident_events.insert_one(
        {
            "incidentId": incident_id,
            "at": now,
            "type": "members_changed",
            "source": "api",
            "actor": actor_of(user),
            "kinds": ["members_changed"],
            "changes": [{"field": "members", "added": [dev["_id"]], "removed": []}],
            "groupsEntered": [],
            "groupsLeft": [],
        }
    )
    card = presenter.card(await get_doc(incident_id), now)
    await rabbit.publish(
        "incident.members_changed",
        {"incidentId": incident_id, "actor": actor_of(user), "added": [dev["_id"]], "removed": [], "card": card},
    )
    return True


async def archive(doc: dict[str, Any], user: dict[str, Any]) -> None:
    """Мягкое удаление: карточка уходит в архив, история остаётся."""
    await archive_incident(doc, source="api", actor=actor_of(user))
    await maybe_write_back()
