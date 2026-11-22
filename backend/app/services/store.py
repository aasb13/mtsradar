"""Единственная точка записи инцидентов.

Неважно, откуда пришло изменение (файл, REST, внешняя ITSM, канбан) — всё идёт через
save_incident(): diff -> meta -> запись с проверкой версии -> история -> событие в RabbitMQ.
Благодаря этому:
  * история и уведомления одинаковы для всех источников;
  * повторный импорт того же файла ничего не меняет (идемпотентность);
  * два одновременных писателя не затрут друг друга (optimistic locking по meta.version).
"""

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from pymongo.errors import DuplicateKeyError

from app.bus import rabbit
from app.core.config import get_settings
from app.db.mongo import get_db
from app.domain.classify import flags, structural_groups
from app.domain.diff import change_kinds, diff
from app.domain.enums import Group
from app.services import presenter

log = logging.getLogger(__name__)

Source = Literal["file", "api", "ingest", "system"]
_UNSET: Any = object()


class ConflictError(Exception):
    """Документ изменился между чтением и записью."""


@dataclass
class SaveResult:
    status: Literal["created", "updated", "restored", "unchanged"]
    incident_id: str
    kinds: list[str] = field(default_factory=list)
    changes: list[dict[str, Any]] = field(default_factory=list)
    groups_entered: list[str] = field(default_factory=list)
    groups_left: list[str] = field(default_factory=list)


def actor_of(user: dict[str, Any] | None) -> dict[str, Any] | None:
    if not user:
        return None
    return {"id": user["_id"], "name": user.get("fullName") or user.get("email")}


async def get_doc(incident_id: str) -> dict[str, Any] | None:
    return await get_db().incidents.find_one({"_id": incident_id})


def _build_meta(
    data: dict[str, Any],
    prev_doc: dict[str, Any] | None,
    source: Source,
    now: datetime,
) -> tuple[dict[str, Any], list[str], list[str]]:
    s = get_settings()
    prev_meta = (prev_doc or {}).get("meta", {})
    was_deleted = prev_meta.get("deletedAt") is not None
    old_groups = [] if (prev_doc is None or was_deleted) else prev_meta.get("groups", [])
    new_groups = structural_groups(data, s)
    f = flags(data, s)

    if not f.is_resolved:
        resolved_at = None
    elif prev_doc is None:
        resolved_at = data.get("completionDate")  # уже был решён до появления у нас
    elif prev_meta.get("resolvedAt") is not None and flags(prev_doc["data"], s).is_resolved:
        resolved_at = prev_meta["resolvedAt"]  # 7 -> 10 и т.п.: момент решения не меняется
    else:
        resolved_at = now  # видим решение прямо сейчас

    if Group.CRITICAL in new_groups:
        critical_since = prev_meta.get("criticalSince") if Group.CRITICAL in old_groups else now
    else:
        critical_since = None

    meta = {
        "groups": new_groups,
        "isActive": f.is_active,
        "isResolved": f.is_resolved,
        "isCritical": f.is_critical,
        "firstSeenAt": prev_meta.get("firstSeenAt", now),
        "updatedAt": now,
        "resolvedAt": resolved_at,
        "criticalSince": critical_since,
        # заморозка ставится поверх данных (update_one, без версии) и должна переживать
        # любую перезапись документа — импорт из файла, правку карточки, восстановление
        "freeze": prev_meta.get("freeze"),
        "source": source,
        "version": prev_meta.get("version", 0) + 1,
        "deletedAt": None,
        "removedFromSource": False,
    }
    entered = [g for g in new_groups if g not in old_groups]
    left = [g for g in old_groups if g not in new_groups]
    return meta, entered, left


async def save_incident(
    data: dict[str, Any],
    *,
    source: Source,
    actor: dict[str, Any] | None = None,
    prev_doc: dict[str, Any] | None = _UNSET,
    dry_run: bool = False,
    silent: bool = False,
    now: datetime | None = None,
) -> SaveResult:
    now = now or datetime.now(UTC)
    incident_id = data["id"]
    if prev_doc is _UNSET:
        prev_doc = await get_doc(incident_id)

    prev_data = prev_doc["data"] if prev_doc else None
    was_deleted = bool(prev_doc and prev_doc.get("meta", {}).get("deletedAt"))
    changes = diff(prev_data, data) if prev_data is not None else []
    if prev_doc is not None and not changes and not was_deleted:
        return SaveResult("unchanged", incident_id)

    kinds = change_kinds(prev_data, data, changes)
    if was_deleted:
        kinds = ["restored", *kinds]
    status: Literal["created", "updated", "restored"] = (
        "created" if prev_doc is None else "restored" if was_deleted else "updated"
    )
    meta, entered, left = _build_meta(data, prev_doc, source, now)
    result = SaveResult(status, incident_id, kinds, changes, entered, left)
    if dry_run:
        return result

    ai = (prev_doc or {}).get("ai")
    if ai and changes:
        ai = {**ai, "stale": True}  # данные поменялись — ИИ-выводы надо пересчитать
    ack = None if Group.CRITICAL in entered else (prev_doc or {}).get("ack")
    members = (prev_doc or {}).get("members") or []
    doc = {"_id": incident_id, "data": data, "meta": meta, "ai": ai, "ack": ack, "members": members}

    incidents = get_db().incidents
    if prev_doc is None:
        try:
            await incidents.insert_one(doc)
        except DuplicateKeyError as e:
            raise ConflictError(incident_id) from e
    else:
        res = await incidents.replace_one({"_id": incident_id, "meta.version": prev_doc["meta"]["version"]}, doc)
        if res.matched_count == 0:
            raise ConflictError(incident_id)

    await get_db().incident_events.insert_one(
        {
            "incidentId": incident_id,
            "at": now,
            "type": status,
            "source": source,
            "actor": actor,
            "kinds": kinds,
            "changes": changes,
            "groupsEntered": entered,
            "groupsLeft": left,
        }
    )
    await rabbit.publish(
        "incident.created" if status == "created" else "incident.updated",
        {
            "incidentId": incident_id,
            "source": source,
            "actor": actor,
            "kinds": kinds,
            "changes": changes,
            "groupsEntered": entered,
            "groupsLeft": left,
            "silent": silent,
            "card": presenter.card(doc, now),
        },
    )
    return result


async def archive_incident(
    doc: dict[str, Any], *, source: Source, actor: dict[str, Any] | None = None, now: datetime | None = None
) -> None:
    """Логическое удаление (физического удаления в API нет)."""
    now = now or datetime.now(UTC)
    version = doc["meta"]["version"]
    res = await get_db().incidents.update_one(
        {"_id": doc["_id"], "meta.version": version},
        {
            "$set": {
                "meta.deletedAt": now,
                "meta.removedFromSource": source == "file",
                "meta.updatedAt": now,
                "meta.version": version + 1,
            }
        },
    )
    if res.matched_count == 0:
        raise ConflictError(doc["_id"])
    await get_db().incident_events.insert_one(
        {
            "incidentId": doc["_id"],
            "at": now,
            "type": "removed",
            "source": source,
            "actor": actor,
            "kinds": ["removed"],
            "changes": [],
            "groupsEntered": [],
            "groupsLeft": doc["meta"].get("groups", []),
        }
    )
    await rabbit.publish("incident.removed", {"incidentId": doc["_id"], "source": source, "actor": actor})
