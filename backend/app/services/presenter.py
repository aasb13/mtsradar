"""Превращает документ из Mongo в ответы API (карточка для дашборда/доски и полная карточка).

Единый формат карточки используется и в REST, и в WebSocket-событиях — фронт просто
заменяет карточку по id в своём состоянии.
"""

from datetime import datetime, timedelta
from typing import Any

from app.core.config import Settings, get_settings
from app.domain.classify import display_groups, flags, sla_info
from app.domain.enums import SLA_RANK, Group


def public(doc: dict[str, Any]) -> dict[str, Any]:
    """Единое имя идентификатора во всех ответах: `id` вместо монговского `_id`."""
    return {"id": str(doc["_id"]), **{k: v for k, v in doc.items() if k != "_id"}}


def itsm_url(incident_id: str, s: Settings) -> str:
    return f"{s.itsm_base_url}{incident_id}"


def card(doc: dict[str, Any], now: datetime, s: Settings | None = None) -> dict[str, Any]:
    s = s or get_settings()
    data, meta = doc["data"], doc.get("meta", {})
    f = flags(data, s)
    groups = display_groups(data, meta, now, s)
    ack = doc.get("ack")
    critical_since = meta.get("criticalSince")
    is_new_critical = (
        Group.CRITICAL in groups
        and not f.is_resolved
        and ack is None
        and critical_since is not None
        and now - critical_since <= timedelta(minutes=s.critical_new_minutes)
    )
    ai = doc.get("ai") or None
    freeze = meta.get("freeze") or None
    # у замороженного активного инцидента SLA фиксируется на момент начала паузы:
    # таймер, сортировки и kpi «стоят», пока идёт заморозка
    sla = (
        sla_info(data, freeze["startedAt"], s)
        if freeze is not None and freeze.get("startedAt") is not None and f.is_active
        else sla_info(data, now, s)
    )
    return {
        "id": doc["_id"],
        "header": data.get("header"),
        "shortDescription": data.get("shortDescription"),
        "productName": data.get("productName"),
        "service": data.get("service"),
        "scenarioName": data.get("scenarioName"),
        "submitDate": data.get("submitDate"),
        "deadline": data.get("deadline"),
        "completionDate": data.get("completionDate"),
        "stateId": data.get("stateId"),
        "state": data.get("state"),
        "priorityId": data.get("priorityId"),
        "priority": data.get("priority"),
        "assignedGroupName": data.get("assignedGroupName"),
        "assignedEmployee": data.get("assignedEmployee"),
        "assignedEmployeeLogin": data.get("assignedEmployeeLogin"),
        "members": doc.get("members") or [],
        "serviceType": data.get("serviceType"),
        "groups": groups,
        "isCritical": f.is_critical,
        "isActive": f.is_active,
        "isResolved": f.is_resolved,
        "isNewCritical": is_new_critical,
        "sla": sla,
        "freeze": freeze,
        "acknowledged": ack,
        # координатор, на которого распределён инцидент при появлении («Ваши инциденты»)
        "routedTo": doc.get("route"),
        "ai": {
            "summary": ai.get("summary"),
            "riskScore": ai.get("riskScore"),
            "stale": ai.get("stale", False),
        }
        if ai
        else None,
        "itsmUrl": itsm_url(doc["_id"], s),
        "updatedAt": meta.get("updatedAt"),
        "version": meta.get("version", 0),
        "deleted": meta.get("deletedAt") is not None,
    }


def detail(doc: dict[str, Any], now: datetime, s: Settings | None = None) -> dict[str, Any]:
    out = card(doc, now, s)
    out["data"] = doc["data"]  # полная запись в формате выгрузки
    out["meta"] = {k: v for k, v in doc.get("meta", {}).items() if k != "groups"}
    out["ai"] = doc.get("ai")
    return out


def sort_key(c: dict[str, Any]) -> tuple:
    """Критические и близкие к просрочке — сверху."""
    left = c["sla"]["timeLeftSeconds"]
    return (
        c["isResolved"],
        not c["isCritical"],
        SLA_RANK.get(c["sla"]["state"], 9),
        left if left is not None else float("inf"),
    )
