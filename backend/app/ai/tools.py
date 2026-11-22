"""Инструменты ИИ-агента: что модель может запросить у бэкенда и чем завершает работу.

Два набора:
  selection  — выбор команды для инцидента: list_teams_overview, get_team_profile,
               find_similar_incidents, итог submit_recommendation;
  analyst    — описания команд для раздела статистики: list_teams_overview,
               get_team_profile, итог submit_team_descriptions.

Инструменты только читают Mongo. Финальные инструменты «submit_*» проверяют ответ
модели (команда из известного списка, заполненность полей) — невалидный ответ
возвращается модели как ошибка инструмента, а не сохраняется.
"""

import logging
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from app.core.config import Settings
from app.db.mongo import get_db
from app.domain.classify import sla_info
from app.domain.enums import RESOLVED_STATE_IDS

RESOLVED_WINDOW_DAYS = 90  # окно истории команды в get_team_profile
OVERVIEW_WINDOW_DAYS = 30  # окно «решено недавно» в list_teams_overview
SOLUTION_SNIPPET_CHARS = 300


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]

    def spec(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description, "parameters": self.parameters},
        }


@dataclass
class ToolContext:
    """Данные, нужные инструментам: окно агрегации и рамки ответа модели."""

    now: datetime
    settings: Settings
    known_groups: list[str]
    incident_id: str | None = None
    # сюда финальные инструменты складывают проверенный ответ модели
    result: dict[str, Any] | None = None
    finished: bool = False


log = logging.getLogger("app.ai")


def _dt(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _snippet(text: Any) -> str | None:
    if not isinstance(text, str) or not text:
        return None
    return text[:SOLUTION_SNIPPET_CHARS] + ("…" if len(text) > SOLUTION_SNIPPET_CHARS else "")


def _minutes(data: dict[str, Any]) -> float | None:
    """Время решения в минутах; None, если даты неполные или порядок нарушен."""
    done, start = data.get("completionDate"), data.get("submitDate")
    if not isinstance(done, datetime) or not isinstance(start, datetime) or done < start:
        return None
    return (done - start).total_seconds() / 60


def _avg(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 1) if values else None


def _met_rate(rows: list[tuple[Any, Any]]) -> float | None:
    """Доля решённых в срок среди решённых с дедлайном; rows — пары (completionDate, deadline)."""
    with_deadline = [(done, dl) for done, dl in rows if isinstance(done, datetime) and isinstance(dl, datetime)]
    if not with_deadline:
        return None
    met = sum(1 for done, dl in with_deadline if done <= dl)
    return round(met / len(with_deadline), 3)


def _finished_result() -> dict[str, Any]:
    return {"status": "accepted"}


# ---------------- инструменты с данными ----------------


def _alive_query() -> dict[str, Any]:
    return {"meta.deletedAt": None}


async def _list_teams_overview(ctx: ToolContext) -> dict[str, Any]:
    """Сводка по всем командам и общий уровень: нагрузка, критические, просрочки, скорость."""
    window = ctx.now - timedelta(days=OVERVIEW_WINDOW_DAYS)
    stats: dict[str, dict[str, Any]] = {}
    unassigned_active = 0
    overall_minutes: list[float] = []
    overall_met: list[tuple[Any, Any]] = []
    async for d in get_db().incidents.find(_alive_query(), {"data": 1, "meta.isActive": 1}):
        data = d["data"]
        group = data.get("assignedGroupName")
        active = bool(d.get("meta", {}).get("isActive"))
        if active and not group:
            unassigned_active += 1
        st = stats.setdefault(
            group,
            {"active": 0, "critical": 0, "breached": 0, "research": 0, "resolvedRecent": 0, "minutes": [], "met": []},
        )
        if active:
            st["active"] += 1
            if data.get("priorityId") == ctx.settings.critical_priority_id:
                st["critical"] += 1
            if data.get("stateId") == 20:
                st["research"] += 1
            if sla_info(data, ctx.now, ctx.settings)["state"] == "breached":
                st["breached"] += 1
        elif group and data.get("stateId") in RESOLVED_STATE_IDS:
            done = data.get("completionDate")
            if isinstance(done, datetime) and done >= window:
                st["resolvedRecent"] += 1
                m = _minutes(data)
                if m is not None:
                    st["minutes"].append(m)
                st["met"].append((done, data.get("deadline")))
                overall_minutes.append(m)
                overall_met.append((done, data.get("deadline")))
    teams = {}
    for group, st in stats.items():
        if not group:
            continue
        teams[group] = {
            "active": st["active"],
            "criticalActive": st["critical"],
            "breachedActive": st["breached"],
            "researchActive": st["research"],
            f"resolvedLast{OVERVIEW_WINDOW_DAYS}Days": st["resolvedRecent"],
            "avgResolutionMinutes": _avg(st["minutes"]),
            "slaMetRate": _met_rate(st["met"]),
        }
    return {
        "teams": dict(sorted(teams.items(), key=lambda kv: -kv[1]["active"])),
        "overall": {
            "avgResolutionMinutes": _avg(overall_minutes),
            "slaMetRate": _met_rate(overall_met),
            "activeWithoutGroup": unassigned_active,
            "now": _dt(ctx.now),
        },
    }


async def _get_team_profile(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    """Подробный профиль команды: активные инциденты, история, продукты, исполнители."""
    group = args.get("group")
    if group not in ctx.known_groups:
        return {"error": f"Неизвестная команда: {group!r}. Вызывайте list_teams_overview для списка."}
    window = ctx.now - timedelta(days=RESOLVED_WINDOW_DAYS)
    db = get_db()
    active_rows, resolved_rows = [], []
    async for d in db.incidents.find({"meta.deletedAt": None, "data.assignedGroupName": group},
                                     {"data": 1, "meta.isActive": 1}):
        data = d["data"]
        if d.get("meta", {}).get("isActive"):
            sla = sla_info(data, ctx.now, ctx.settings)
            active_rows.append({
                "id": d["_id"],
                "header": data.get("header"),
                "productName": data.get("productName"),
                "scenarioName": data.get("scenarioName"),
                "priorityId": data.get("priorityId"),
                "stateId": data.get("stateId"),
                "state": data.get("state"),
                "slaState": sla["state"],
                "deadline": _dt(data.get("deadline")),
                "assignedEmployee": data.get("assignedEmployee"),
            })
        elif data.get("stateId") in RESOLVED_STATE_IDS:
            done = data.get("completionDate")
            if isinstance(done, datetime) and done >= window:
                resolved_rows.append({
                    "completedAt": _dt(done),
                    "submittedAt": _dt(data.get("submitDate")),
                    "resolutionMinutes": _minutes(data),
                    "metDeadline": (done <= data["deadline"]) if isinstance(data.get("deadline"), datetime) else None,
                    "header": data.get("header"),
                    "productName": data.get("productName"),
                    "scenarioName": data.get("scenarioName"),
                    "priorityId": data.get("priorityId"),
                    "assignedEmployee": data.get("assignedEmployee"),
                    "solution": _snippet(data.get("solution")),
                })
    resolved_rows.sort(key=lambda r: r["completedAt"] or "", reverse=True)
    minutes = [r["resolutionMinutes"] for r in resolved_rows if r["resolutionMinutes"] is not None]
    with_deadline = [r for r in resolved_rows if r["metDeadline"] is not None]
    sla_met = None
    if with_deadline:
        sla_met = round(sum(1 for r in with_deadline if r["metDeadline"]) / len(with_deadline), 3)
    products = Counter(r["productName"] for r in resolved_rows if r["productName"])
    executors = Counter(r["assignedEmployee"] for r in resolved_rows if r["assignedEmployee"])
    return {
        "group": group,
        "active": active_rows,
        "activeCount": len(active_rows),
        "resolvedLast90DaysCount": len(resolved_rows),
        "avgResolutionMinutes": _avg(minutes),
        "slaMetRate": sla_met,
        "topProducts": dict(products.most_common(5)),
        "topExecutors": dict(executors.most_common(5)),
        "recentlyResolved": resolved_rows[:15],
    }


async def _find_similar_incidents(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    """Прошлые инциденты того же продукта/сценария: кто решал, чем закончилось."""
    product = args.get("product")
    if not isinstance(product, str) or not product:
        return {"error": "Укажите product (productName инцидента)."}
    limit = min(int(args.get("limit") or 8), 20)
    query: dict[str, Any] = {
        "meta.deletedAt": None,
        "data.productName": product,
    }
    scenario = args.get("scenario")
    if isinstance(scenario, str) and scenario:
        query["data.scenarioName"] = scenario
    if ctx.incident_id:
        query["_id"] = {"$ne": ctx.incident_id}
    rows = []
    async for d in get_db().incidents.find(query, {"data": 1}).sort("data.submitDate", -1).limit(limit):
        data = d["data"]
        rows.append({
            "id": d["_id"],
            "header": data.get("header"),
            "productName": data.get("productName"),
            "scenarioName": data.get("scenarioName"),
            "priorityId": data.get("priorityId"),
            "stateId": data.get("stateId"),
            "state": data.get("state"),
            "assignedGroupName": data.get("assignedGroupName"),
            "assignedEmployee": data.get("assignedEmployee"),
            "resolutionMinutes": _minutes(data),
            "submitDate": _dt(data.get("submitDate")),
            "solution": _snippet(data.get("solution")),
        })
    return {"count": len(rows), "incidents": rows}


# ---------------- финальные инструменты ----------------


async def _submit_recommendation(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    group = args.get("recommendedGroup")
    if group not in ctx.known_groups:
        return {"error": f"recommendedGroup={group!r} не входит в список известных команд. "
                         f"Доступны: {ctx.known_groups}"}
    reason = args.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        return {"error": "reason обязателен: 1–2 предложения, почему эта команда."}
    confidence = args.get("confidence")
    if not isinstance(confidence, int) or not 0 <= confidence <= 100:
        return {"error": "confidence — целое число 0–100."}
    alternatives = args.get("alternatives") or []
    if not isinstance(alternatives, list) or len(alternatives) > 2:
        return {"error": "alternatives — список не более двух объектов {group, reason}."}
    for alt in alternatives:
        if not isinstance(alt, dict) or alt.get("group") not in ctx.known_groups or alt.get("group") == group:
            return {"error": f"Каждая альтернатива — известная команда, отличная от {group!r}."}
        if not isinstance(alt.get("reason"), str) or not alt["reason"].strip():
            return {"error": "У каждой альтернативы нужен reason."}
    ctx.result = {
        "recommendedGroup": group,
        "reason": reason.strip(),
        "confidence": confidence,
        "alternatives": [{"group": a["group"], "reason": a["reason"].strip()} for a in alternatives],
    }
    ctx.finished = True
    return _finished_result()


async def _submit_team_descriptions(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    descriptions = args.get("descriptions")
    if not isinstance(descriptions, list) or not descriptions:
        return {"error": "descriptions — список объектов {group, text} для всех команд."}
    seen: set[str] = set()
    clean: list[dict[str, str]] = []
    for item in descriptions:
        if not isinstance(item, dict):
            return {"error": "Каждый элемент descriptions — объект {group, text}."}
        group, text = item.get("group"), item.get("text")
        if group not in ctx.known_groups:
            return {"error": f"Неизвестная команда {group!r}. Доступны: {ctx.known_groups}"}
        if group in seen:
            return {"error": f"Для {group!r} передано два описания."}
        if not isinstance(text, str) or not text.strip() or len(text) > 1000:
            return {"error": f"text для {group!r} — непустая строка до 1000 символов."}
        seen.add(group)
        clean.append({"group": group, "text": text.strip()})
    missing = sorted(set(ctx.known_groups) - seen)
    if missing:
        return {"error": f"Нет описания для команд: {missing}. Опишите каждую команду."}
    ctx.result = {"descriptions": clean}
    ctx.finished = True
    return _finished_result()


# ---------------- наборы инструментов ----------------


def selection_tools(ctx: ToolContext) -> list[Tool]:
    """Инструменты агента выбора команды (модалка «Назначить команду»)."""
    async def overview(_: dict[str, Any]) -> dict[str, Any]:
        return await _list_teams_overview(ctx)

    return [
        Tool(
            name="list_teams_overview",
            description="Сводка по всем командам: активные/критические/просроченные инциденты, "
                        "решено за 30 дней, среднее время решения, SLA. Плюс общий средний уровень.",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            handler=overview,
        ),
        Tool(
            name="get_team_profile",
            description="Профиль одной команды: активные инциденты, чем занималась за 90 дней "
                        "(продукты, сценарии, решения), средняя скорость и исполнители.",
            parameters={
                "type": "object",
                "properties": {"group": {"type": "string", "description": "точное имя команды из list_teams_overview"}},
                "required": ["group"],
                "additionalProperties": False,
            },
            handler=lambda args: _get_team_profile(ctx, args),
        ),
        Tool(
            name="find_similar_incidents",
            description="Прошлые инциденты того же продукта (и опционально сценария): кто решал, "
                        "сколько это заняло и каким было решение.",
            parameters={
                "type": "object",
                "properties": {
                    "product": {"type": "string", "description": "productName инцидента"},
                    "scenario": {"type": "string", "description": "scenarioName, если нужен более узкий поиск"},
                    "limit": {"type": "integer", "description": "сколько вернуть, по умолчанию 8, максимум 20"},
                },
                "required": ["product"],
                "additionalProperties": False,
            },
            handler=lambda args: _find_similar_incidents(ctx, args),
        ),
        Tool(
            name="submit_recommendation",
            description="Итог анализа: рекомендация команды для инцидента. Вызовите ровно один раз и завершите работу.",
            parameters={
                "type": "object",
                "properties": {
                    "recommendedGroup": {"type": "string", "description": "ровно одна команда из известных"},
                    "reason": {
                        "type": "string",
                        "description": "1–2 предложения по-русски: почему эта команда, только факты",
                    },
                    "confidence": {"type": "integer", "description": "уверенность 0–100"},
                    "alternatives": {
                        "type": "array",
                        "maxItems": 2,
                        "description": "до двух запасных команд",
                        "items": {
                            "type": "object",
                            "properties": {"group": {"type": "string"}, "reason": {"type": "string"}},
                            "required": ["group", "reason"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["recommendedGroup", "reason", "confidence"],
                "additionalProperties": False,
            },
            handler=lambda args: _submit_recommendation(ctx, args),
        ),
    ]


def analyst_tools(ctx: ToolContext) -> list[Tool]:
    """Инструменты агента описания команд (раздел «Статистика»)."""
    async def overview(_: dict[str, Any]) -> dict[str, Any]:
        return await _list_teams_overview(ctx)

    return [
        Tool(
            name="list_teams_overview",
            description="Сводка по всем командам: активные/критические/просроченные инциденты, "
                        "решено за 30 дней, среднее время решения, SLA. Плюс общий средний уровень.",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            handler=overview,
        ),
        Tool(
            name="get_team_profile",
            description="Профиль одной команды: активные инциденты, чем занималась за 90 дней "
                        "(продукты, сценарии, решения), средняя скорость и исполнители.",
            parameters={
                "type": "object",
                "properties": {"group": {"type": "string", "description": "точное имя команды из list_teams_overview"}},
                "required": ["group"],
                "additionalProperties": False,
            },
            handler=lambda args: _get_team_profile(ctx, args),
        ),
        Tool(
            name="submit_team_descriptions",
            description="Итог анализа: описание каждой команды. Передайте все команды сразу и завершите работу.",
            parameters={
                "type": "object",
                "properties": {
                    "descriptions": {
                        "type": "array",
                        "description": "по одному объекту на каждую команду из list_teams_overview",
                        "items": {
                            "type": "object",
                            "properties": {"group": {"type": "string"}, "text": {"type": "string"}},
                            "required": ["group", "text"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["descriptions"],
                "additionalProperties": False,
            },
            handler=lambda args: _submit_team_descriptions(ctx, args),
        ),
    ]


async def run_tool(tool: Tool, args: dict[str, Any]) -> dict[str, Any]:
    """Запуск инструмента с защитой: сбой не роняет агента, а возвращается модели ошибкой."""
    try:
        return await tool.handler(args)
    except Exception as e:  # noqa: BLE001 — модель получит короткое описание, детали в логах
        log.exception("Инструмент %s упал", tool.name)
        return {"error": f"Инструмент {tool.name} временно недоступен: {e.__class__.__name__}"}


def tool_specs(tools: list[Tool]) -> list[dict[str, Any]]:
    return [t.spec() for t in tools]


def tool_index(tools: list[Tool]) -> dict[str, Tool]:
    return {t.name: t for t in tools}
