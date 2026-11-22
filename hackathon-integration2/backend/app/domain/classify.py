"""Распределение по группам и расчёт SLA. Только чистые функции — их легко тестировать.

Группы (по кейсу; один инцидент может попасть в несколько):
* critical     — priorityId == CRITICAL и проблема не устранена;
                 + решённые критические ещё N минут после решения (с флагом isResolved),
                   чтобы «было сразу видно, когда такой инцидент решён».
* coordinators — назначен на группу координаторов и активен (в т.ч. в Research:
                 «его тоже могут назначить на координаторов»).
* high         — priorityId == HIGH и проблема не устранена («может перерасти в критический»).
* research     — stateId == 20.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from app.core.config import Settings
from app.domain.enums import (
    INACTIVE_STATE_IDS,
    RESEARCH,
    RESOLVED_STATE_IDS,
    Group,
)


@dataclass(frozen=True, slots=True)
class Flags:
    is_active: bool
    is_resolved: bool
    is_critical: bool


def flags(data: dict[str, Any], s: Settings) -> Flags:
    state = data.get("stateId")
    return Flags(
        is_active=state not in INACTIVE_STATE_IDS,
        is_resolved=state in RESOLVED_STATE_IDS,
        is_critical=data.get("priorityId") == s.critical_priority_id,
    )


def structural_groups(data: dict[str, Any], s: Settings) -> list[str]:
    """Членство, не зависящее от текущего времени. Хранится в meta.groups (для индексов/фильтров)."""
    f = flags(data, s)
    groups: list[str] = []
    if f.is_critical and not f.is_resolved:
        groups.append(Group.CRITICAL)
    if f.is_active and data.get("assignedGroupName") == s.coordinators_group_name:
        groups.append(Group.COORDINATORS)
    if data.get("priorityId") == s.high_priority_id and not f.is_resolved:
        groups.append(Group.HIGH)
    if data.get("stateId") == RESEARCH:
        groups.append(Group.RESEARCH)
    return groups


def display_groups(data: dict[str, Any], meta: dict[str, Any], now: datetime, s: Settings) -> list[str]:
    """Структурные группы + «недавно решённый критический»."""
    groups = structural_groups(data, s)
    f = flags(data, s)
    resolved_at = meta.get("resolvedAt")
    if (
        f.is_critical
        and f.is_resolved
        and resolved_at is not None
        and now - resolved_at <= timedelta(minutes=s.critical_resolved_visible_minutes)
        and Group.CRITICAL not in groups
    ):
        groups.insert(0, Group.CRITICAL)
    return groups


def sla_info(data: dict[str, Any], now: datetime, s: Settings) -> dict[str, Any]:
    """Срок берём из поля deadline выгрузки (а не считаем сами, как предполагало ТЗ).

    state: ok | warning | danger | breached | none (нет срока) | resolved
    ratio: доля оставшегося времени от всего отведённого (deadline - submitDate).
    """
    deadline: datetime | None = data.get("deadline")
    submit: datetime | None = data.get("submitDate")
    state_id = data.get("stateId")

    if state_id in INACTIVE_STATE_IDS:
        completion = data.get("completionDate")
        met = None
        if deadline and completion:
            met = completion <= deadline
        return {"state": "resolved", "timeLeftSeconds": None, "ratio": None, "met": met}

    if deadline is None:
        return {"state": "none", "timeLeftSeconds": None, "ratio": None, "met": None}

    left = (deadline - now).total_seconds()
    total = (deadline - submit).total_seconds() if submit else 0
    ratio = max(left, 0) / total if total > 0 else 0.0
    if left < 0:
        state = "breached"
    elif ratio < s.sla_danger_ratio:
        state = "danger"
    elif ratio < s.sla_warning_ratio:
        state = "warning"
    else:
        state = "ok"
    return {"state": state, "timeLeftSeconds": int(left), "ratio": round(ratio, 3), "met": None}
