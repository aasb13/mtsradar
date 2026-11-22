"""Справочники для фронта и агрегаты для виджетов/ИИ-панели."""

from collections import Counter
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter

from app.api.deps import StaffUser
from app.core.config import get_settings
from app.db.mongo import get_db
from app.domain.classify import sla_info
from app.domain.enums import GROUP_TITLES, INACTIVE_STATE_IDS, PRIORITIES, RESOLVED_STATE_IDS, STATES, TRANSITIONS

router = APIRouter(tags=["meta"])


@router.get("/dictionaries")
async def dictionaries(_: StaffUser) -> dict[str, Any]:
    s = get_settings()
    db = get_db()
    alive = {"meta.deletedAt": None}
    return {
        "states": [
            {
                "id": sid,
                "name": name,
                "enum": enum,
                "isActive": sid not in INACTIVE_STATE_IDS,
                "isResolved": sid in RESOLVED_STATE_IDS,
            }
            for sid, (name, enum) in STATES.items()
        ],
        "priorities": [{"id": pid, "name": name} for pid, name in PRIORITIES.items()],
        "groups": [{"id": g.value, "title": t} for g, t in GROUP_TITLES.items()],
        "transitions": {str(k): sorted(v) for k, v in TRANSITIONS.items()},
        "coordinatorsGroupName": s.coordinators_group_name,
        "criticalPriorityId": s.critical_priority_id,
        # фронт красит BigDad в красный, если ИИ не настроен (LLM_API_BASE/LLM_MODEL)
        "aiEnabled": bool(s.llm_api_base and s.llm_model),
        "assignedGroups": sorted(x for x in await db.incidents.distinct("data.assignedGroupName", alive) if x),
        "products": sorted(x for x in await db.incidents.distinct("data.productName", alive) if x),
        "serviceTypes": sorted(x for x in await db.incidents.distinct("data.serviceType", alive) if x),
        "receivingChannels": sorted(x for x in await db.incidents.distinct("data.receivingChannel", alive) if x),
    }


@router.get("/stats")
async def stats(_: StaffUser) -> dict[str, Any]:
    """Сводка для виджетов (и как вход для ИИ-сводки смены)."""
    s, now = get_settings(), datetime.now(UTC)
    by_product, by_group, by_priority, by_state, by_sla = Counter(), Counter(), Counter(), Counter(), Counter()
    resolution_minutes: list[float] = []
    met = total_with_deadline = 0
    async for d in get_db().incidents.find({"meta.deletedAt": None}, {"data": 1, "meta": 1}):
        data = d["data"]
        by_state[data["stateId"]] += 1
        if d["meta"].get("isActive"):
            by_product[data.get("productName")] += 1
            by_group[data.get("assignedGroupName")] += 1
            by_priority[data.get("priorityId")] += 1
            by_sla[sla_info(data, now, s)["state"]] += 1
        if data.get("completionDate") and data.get("submitDate") and data["stateId"] in RESOLVED_STATE_IDS:
            resolution_minutes.append((data["completionDate"] - data["submitDate"]).total_seconds() / 60)
            if data.get("deadline"):
                total_with_deadline += 1
                met += data["completionDate"] <= data["deadline"]
    return {
        "serverTime": now,
        "byState": {STATES.get(k, (str(k),))[0]: v for k, v in by_state.items()},
        "active": {
            "byProduct": dict(by_product.most_common()),
            "byAssignedGroup": dict(by_group.most_common()),
            "byPriority": {PRIORITIES.get(k, str(k)): v for k, v in sorted(by_priority.items())},
            "bySla": dict(by_sla),
        },
        "resolved": {
            "count": len(resolution_minutes),
            "avgResolutionMinutes": round(sum(resolution_minutes) / len(resolution_minutes), 1)
            if resolution_minutes
            else None,
            "slaMetRate": round(met / total_with_deadline, 3) if total_with_deadline else None,
        },
    }
