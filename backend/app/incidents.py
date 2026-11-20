"""Чистая логика инцидентов: загрузка, нормализация, производные данные, diff, правила AI."""

import json
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TypedDict

ACTIVE_STATES = frozenset({0, 2})
RESOLVED_STATES = frozenset({7, 10})
RESEARCH_STATE = 20
COORDINATOR_TEAM = "КЦ ИТ Координаторы Массовых Инцидентов"
CLIENT_SERVICE_TYPE = "Клиентский"

GROUP_ORDER = ("critical", "coordinators", "high_priority", "research")

STATE_NAMES = {
    0: "Назначен",
    2: "Выполняется",
    7: "Завершен",
    10: "Закрыт",
    20: "Исследование ситуации",
}

_DIFF_EXCLUDED_KEYS = frozenset({"stateId", "priorityId", "deadline"})
_FRACTION_RE = re.compile(r"\.(\d+)")


class Sla(TypedDict):
    state: str
    timeLeftSeconds: int | None
    totalSeconds: int | None
    overdueSeconds: int | None


class Change(TypedDict):
    id: str
    kind: str


@dataclass(frozen=True)
class RecordView:
    id: str
    state_id: int
    priority_id: int | None
    deadline: str | None
    deadline_dt: datetime | None
    submit_date: datetime
    completion_date: datetime | None
    groups: frozenset[str]
    sla: Sla
    record: dict


@dataclass
class Snapshot:
    generated_at: datetime
    incidents: list[dict]
    summary: dict
    views: dict[str, RecordView]


def parse_datetime(raw: str | None) -> datetime | None:
    if raw is None:
        return None
    text = raw.strip()
    if not text:
        return None
    if text[-1] in {"Z", "z"}:
        text = text[:-1] + "+00:00"
    match = _FRACTION_RE.search(text)
    if match is not None and len(match.group(1)) > 6:
        text = text[: match.start(1)] + match.group(1)[:6] + text[match.end(1) :]
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_records(raw: bytes) -> list[dict]:
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Файл данных не является корректным JSON: {exc}") from exc
    if not isinstance(data, list):
        raise ValueError("Файл данных должен содержать JSON-массив записей")
    records: list[dict] = []
    for index, record in enumerate(data):
        if not isinstance(record, dict):
            raise ValueError(f"Запись {index} не является JSON-объектом")
        incident_id = record.get("id")
        if not isinstance(incident_id, str) or not incident_id:
            raise ValueError(f"Запись {index} не содержит непустого строкового поля id")
        state_id = record.get("stateId")
        if isinstance(state_id, bool) or not isinstance(state_id, int):
            raise ValueError(f"Запись {incident_id}: поле stateId отсутствует или не является целым числом")
        priority_id = record.get("priorityId")
        if priority_id is not None and (isinstance(priority_id, bool) or not isinstance(priority_id, int)):
            raise ValueError(f"Запись {incident_id}: поле priorityId не является целым числом или null")
        for field_name in ("submitDate", "deadline", "completionDate"):
            value = record.get(field_name)
            if value is None:
                continue
            if not isinstance(value, str):
                raise ValueError(f"Запись {incident_id}: поле {field_name} должно быть строкой или null")
            try:
                parse_datetime(value)
            except ValueError as exc:
                raise ValueError(f"Запись {incident_id}: поле {field_name} не является корректной датой: {exc}") from exc
        records.append(record)
    return records


def derive_groups(record: dict, state_id: int, deadline_dt: datetime | None, now: datetime) -> frozenset[str]:
    groups: set[str] = set()
    priority_id = record.get("priorityId")
    breached = deadline_dt is not None and deadline_dt < now
    if state_id in ACTIVE_STATES and (priority_id == 3 or breached):
        groups.add("critical")
    if record.get("assignedGroupName") == COORDINATOR_TEAM and state_id in {0, 2, RESEARCH_STATE}:
        groups.add("coordinators")
    if priority_id == 3 and state_id in {0, 2, RESEARCH_STATE}:
        groups.add("high_priority")
    if state_id == RESEARCH_STATE:
        groups.add("research")
    return frozenset(groups)


def compute_sla(state_id: int, deadline_dt: datetime | None, submit_date: datetime, now: datetime) -> Sla:
    if state_id in RESOLVED_STATES:
        return {"state": "done", "timeLeftSeconds": None, "totalSeconds": None, "overdueSeconds": None}
    if deadline_dt is None:
        return {"state": "none", "timeLeftSeconds": None, "totalSeconds": None, "overdueSeconds": None}
    time_left = int((deadline_dt - now).total_seconds())
    total = int((deadline_dt - submit_date).total_seconds())
    ratio = time_left / total if total > 0 else 0.0
    if time_left < 0:
        return {
            "state": "breach",
            "timeLeftSeconds": time_left,
            "totalSeconds": total,
            "overdueSeconds": -time_left,
        }
    if ratio < 0.10:
        state = "danger"
    elif ratio < 0.30:
        state = "warning"
    else:
        state = "ok"
    return {"state": state, "timeLeftSeconds": time_left, "totalSeconds": total, "overdueSeconds": None}


def make_view(record: dict, now: datetime) -> RecordView:
    state_id = record["stateId"]
    deadline_raw = record.get("deadline")
    deadline_dt = parse_datetime(deadline_raw)
    submit_date = parse_datetime(record["submitDate"])
    completion_date = parse_datetime(record.get("completionDate"))
    return RecordView(
        id=record["id"],
        state_id=state_id,
        priority_id=record.get("priorityId"),
        deadline=deadline_raw,
        deadline_dt=deadline_dt,
        submit_date=submit_date,
        completion_date=completion_date,
        groups=derive_groups(record, state_id, deadline_dt, now),
        sla=compute_sla(state_id, deadline_dt, submit_date, now),
        record=record,
    )


def status_name(state_id: int, views: list[RecordView]) -> str:
    known = STATE_NAMES.get(state_id)
    if known is not None:
        return known
    for view in views:
        if view.state_id == state_id:
            value = view.record.get("state")
            if isinstance(value, str) and value:
                return value
    return str(state_id)


def compute_summary(views: dict[str, RecordView], now: datetime) -> dict:
    all_views = list(views.values())
    active = [v for v in all_views if v.state_id in ACTIVE_STATES]
    resolved = [v for v in all_views if v.state_id in RESOLVED_STATES]
    today = now.date()
    resolved_today = [v for v in resolved if v.completion_date is not None and v.completion_date.date() == today]
    opened_today = [v for v in all_views if v.submit_date.date() == today]
    durations_minutes = [
        (v.completion_date - v.submit_date).total_seconds() / 60
        for v in resolved
        if v.completion_date is not None
    ]
    avg_resolution = round(sum(durations_minutes) / len(durations_minutes)) if durations_minutes else None
    product_counts = Counter(
        v.record["productName"] for v in active if isinstance(v.record.get("productName"), str) and v.record["productName"]
    )
    by_product = [{"name": name, "count": count} for name, count in product_counts.most_common(3)]
    status_counter = Counter(v.state_id for v in all_views)
    by_status = [
        {"stateId": state_id, "state": status_name(state_id, all_views), "count": count}
        for state_id, count in sorted(status_counter.items())
    ]
    return {
        "generatedAt": now.isoformat(),
        "kpi": {
            "open": len(active),
            "critical": sum(1 for v in all_views if "critical" in v.groups),
            "breached": sum(1 for v in active if v.deadline_dt is not None and v.deadline_dt < now),
            "research": sum(1 for v in all_views if v.state_id == RESEARCH_STATE),
            "coordinators": sum(1 for v in all_views if "coordinators" in v.groups),
            "resolvedToday": len(resolved_today),
        },
        "shift": {
            "openedToday": len(opened_today),
            "resolvedToday": len(resolved_today),
            "avgResolutionMinutes": avg_resolution,
            "topProduct": by_product[0]["name"] if by_product else None,
            "byProduct": by_product,
            "byStatus": by_status,
        },
    }


def build_snapshot(records: list[dict], now: datetime) -> Snapshot:
    views: dict[str, RecordView] = {}
    incidents: list[dict] = []
    for record in records:
        view = make_view(record, now)
        views[view.id] = view
        incidents.append(
            {
                **record,
                "groups": [group for group in GROUP_ORDER if group in view.groups],
                "sla": dict(view.sla),
            }
        )
    return Snapshot(
        generated_at=now,
        incidents=incidents,
        summary=compute_summary(views, now),
        views=views,
    )


def diff_snapshots(previous: Snapshot, current: Snapshot) -> list[Change]:
    changes: list[Change] = []
    for view in current.views.values():
        old = previous.views.get(view.id)
        kinds: list[str] = []
        if old is None:
            kinds.append("created")
            if "critical" in view.groups:
                kinds.append("critical_new")
            if "coordinators" in view.groups:
                kinds.append("coordinator_assigned")
            if view.state_id == RESEARCH_STATE:
                kinds.append("research_new")
        else:
            transition_emitted = False
            if old.state_id in ACTIVE_STATES and view.state_id in RESOLVED_STATES:
                kinds.append("resolved")
                transition_emitted = True
            elif old.state_id in RESOLVED_STATES and view.state_id in ACTIVE_STATES:
                kinds.append("reopened")
                transition_emitted = True
            if old.state_id != RESEARCH_STATE and view.state_id == RESEARCH_STATE:
                kinds.append("research_new")
                transition_emitted = True
            if "critical" in view.groups and "critical" not in old.groups:
                kinds.append("critical_new")
            if "coordinators" in view.groups and "coordinators" not in old.groups:
                kinds.append("coordinator_assigned")
            if old.priority_id != view.priority_id:
                kinds.append("priority_changed")
            if old.deadline != view.deadline:
                kinds.append("deadline_changed")
            keys = old.record.keys() | view.record.keys()
            other_changed = any(
                key not in _DIFF_EXCLUDED_KEYS and old.record.get(key) != view.record.get(key) for key in keys
            )
            if (old.state_id != view.state_id and not transition_emitted) or other_changed:
                kinds.append("updated")
        for kind in kinds:
            changes.append({"id": view.id, "kind": kind})
    return changes


def pluralize(count: int, one: str, few: str, many: str) -> str:
    if count % 10 == 1 and count % 100 != 11:
        return f"{count} {one}"
    if 2 <= count % 10 <= 4 and not 12 <= count % 100 <= 14:
        return f"{count} {few}"
    return f"{count} {many}"


def humanize_duration(seconds: int) -> str:
    value = abs(seconds)
    days, remainder = divmod(value, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes = remainder // 60
    parts = []
    if days:
        parts.append(pluralize(days, "день", "дня", "дней"))
    if hours:
        parts.append(pluralize(hours, "час", "часа", "часов"))
    if minutes or not parts:
        parts.append(pluralize(minutes, "минута", "минуты", "минут"))
    return " ".join(parts)


def deadline_clause(view: RecordView) -> str:
    if view.state_id in RESOLVED_STATES:
        return "инцидент решён"
    time_left = view.sla["timeLeftSeconds"]
    if time_left is None:
        return "срок не задан"
    overdue = view.sla["overdueSeconds"]
    if view.sla["state"] == "breach" and overdue is not None:
        return f"срок просрочен на {humanize_duration(overdue)}"
    return f"до срока осталось {humanize_duration(time_left)}"


def ai_summary(view: RecordView) -> str:
    record = view.record
    header = record.get("header") or "Описание инцидента недоступно"
    product = record.get("productName") or "не указан"
    service = record.get("service") or "не указан"
    scenario = record.get("scenarioName") or "не указан"
    state = STATE_NAMES.get(view.state_id) or record.get("state") or "неизвестен"
    priority = record.get("priority") or "не указан"
    assignee = record.get("assignedEmployee") or record.get("assignedGroupName") or "не назначен"
    return (
        f"Инцидент: {header}."
        f" Продукт «{product}», сервис «{service}», сценарий «{scenario}»."
        f" Статус «{state}», приоритет «{priority}», назначен: {assignee}; {deadline_clause(view)}."
    )


def ai_risk(view: RecordView, now: datetime) -> tuple[int, str]:
    record = view.record
    score = 0
    factors: list[str] = []
    if view.priority_id == 3:
        score += 45
        factors.append("высокий приоритет")
    elif view.priority_id == 2:
        score += 25
        factors.append("средний приоритет")
    elif view.priority_id == 1:
        score += 10
        factors.append("низкий приоритет")
    if record.get("urgencyId") == 4:
        score += 10
        factors.append("наивысшая срочность")
    if record.get("impactId") == 4:
        score += 10
        factors.append("наивысшее влияние")
    if view.state_id in ACTIVE_STATES and view.deadline_dt is not None:
        time_left = int((view.deadline_dt - now).total_seconds())
        total = int((view.deadline_dt - view.submit_date).total_seconds())
        ratio = time_left / total if total > 0 else 0.0
        if time_left < 0:
            score += 30
            factors.append("срок просрочен")
        elif ratio < 0.10:
            score += 20
            factors.append("до срока менее 10 % времени")
        elif ratio < 0.30:
            score += 10
            factors.append("до срока менее 30 % времени")
    is_effect = record.get("isEffect") is True
    is_master = record.get("isMaster") is True
    if is_effect or is_master:
        score += 10
        if is_effect:
            factors.append("инцидент является эффектом")
        if is_master:
            factors.append("инцидент является master-инцидентом")
    if record.get("serviceType") == CLIENT_SERVICE_TYPE:
        score += 10
        factors.append("клиентский сервис")
    if view.state_id == RESEARCH_STATE:
        score += 5
        factors.append("этап исследования ситуации")
    score = min(100, max(0, score))
    if factors:
        reason = "Оценка риска обусловлена: " + ", ".join(factors) + "."
    else:
        reason = "Факторы риска не выявлены."
    return score, reason


def ai_recommend_team(view: RecordView, views: dict[str, RecordView]) -> tuple[str, str]:
    record = view.record
    resolved = [v for v in views.values() if v.state_id in RESOLVED_STATES]
    product = record.get("productName")
    team_counts = Counter(
        v.record["assignedGroupName"]
        for v in resolved
        if isinstance(v.record.get("assignedGroupName"), str)
        and v.record["assignedGroupName"]
        and v.record.get("productName") == product
    )
    if team_counts:
        team, count = team_counts.most_common(1)[0]
        total = sum(team_counts.values())
        return team, (
            f"Команда «{team}» решила {count} из {total} решённых инцидентов по продукту «{product}»; "
            "рекомендуется назначить её."
        )
    service_type = record.get("serviceType")
    team_counts = Counter(
        v.record["assignedGroupName"]
        for v in resolved
        if isinstance(v.record.get("assignedGroupName"), str)
        and v.record["assignedGroupName"]
        and v.record.get("serviceType") == service_type
    )
    if team_counts:
        team, count = team_counts.most_common(1)[0]
        total = sum(team_counts.values())
        return team, (
            f"Решённых инцидентов по продукту «{product}» нет; команда «{team}» решила {count} из {total} "
            f"инцидентов с типом обслуживания «{service_type}»."
        )
    team = record.get("assignedGroupName")
    if not isinstance(team, str) or not team:
        team = "Команда не назначена"
    return team, f"Подходящих решённых инцидентов не найдено; предлагается текущая команда «{team}»."


def ws_snapshot_message(snapshot: Snapshot) -> dict:
    return {
        "type": "snapshot",
        "payload": {
            "incidents": snapshot.incidents,
            "summary": snapshot.summary,
            "ts": snapshot.generated_at.isoformat(),
        },
    }


def ws_update_message(snapshot: Snapshot, changes: list[Change]) -> dict:
    return {
        "type": "update",
        "payload": {
            "incidents": snapshot.incidents,
            "summary": snapshot.summary,
            "changes": changes,
            "ts": snapshot.generated_at.isoformat(),
        },
    }
