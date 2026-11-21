"""Сравнение версий инцидента и вывод «смысловых» видов изменений.

Фронту не нужно разбирать список полей: в событии сразу есть kinds
(resolved, reassigned, priority_changed ...) и groupsEntered/groupsLeft.
"""

from typing import Any

from app.domain.enums import RESOLVED_STATE_IDS

# поля, чьё изменение интересно показывать отдельными «видами»
REASSIGN_FIELDS = ("assignedGroupName", "assignedEmployee", "assignedEmployeeLogin")


def diff(old: dict[str, Any], new: dict[str, Any]) -> list[dict[str, Any]]:
    changes = []
    for key in dict.fromkeys([*old.keys(), *new.keys()]):
        before, after = old.get(key), new.get(key)
        if before != after:
            changes.append({"field": key, "old": before, "new": after})
    return changes


def change_kinds(old: dict[str, Any] | None, new: dict[str, Any], changes: list[dict[str, Any]]) -> list[str]:
    if old is None:
        return ["created"]
    fields = {c["field"] for c in changes}
    kinds: list[str] = []
    if "stateId" in fields:
        kinds.append("state_changed")
        was, now = old.get("stateId") in RESOLVED_STATE_IDS, new.get("stateId") in RESOLVED_STATE_IDS
        if now and not was:
            kinds.append("resolved")
        elif was and not now:
            kinds.append("reopened")
    if "priorityId" in fields:
        kinds.append("priority_changed")
    if fields & set(REASSIGN_FIELDS):
        kinds.append("reassigned")
    if "deadline" in fields:
        kinds.append("deadline_changed")
    if not kinds and fields:
        kinds.append("fields_changed")
    return kinds
