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
from datetime import UTC, datetime
from typing import Any

from app.bus import rabbit
from app.db.mongo import get_db
from app.domain.enums import CLOSED, FINAL_STATE_IDS, PRIORITIES, RESOLVED, STATES, TRANSITIONS
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


async def archive(doc: dict[str, Any], user: dict[str, Any]) -> None:
    """Мягкое удаление: карточка уходит в архив, история остаётся."""
    await archive_incident(doc, source="api", actor=actor_of(user))
    await maybe_write_back()
