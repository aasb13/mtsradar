"""Инструменты чат-агента BigDad: чтение дашборда и действия от имени пользователя.

Матрица прав can() зеркалит зависимости REST-маршрутов (по построению — маршруты и агент
исполняют один слой app/services/incident_actions.py):
  читать инциденты              — все роли; разработчику только свои (access.mongo_filter/can_view);
  справочник сотрудников        — admin+coordinator+viewer (как StaffUser на GET /users);
  правки/ack/архив              — admin+coordinator (как CoordinatorUser на REST-мутациях);
  назначение исполнителя        — то же право; сотрудник берётся из справочника, а без ITSM-логина
                                  добавляется в участники (как POST /incidents/{id}/members);
  переходы                      — admin+coordinator; в REST разработчик может ещё отметить исправленным (7)
                                  свой инцидент (access.can_view) — агенту это действие не выдаётся;
  комментарии                   — admin+coordinator+viewer (как StaffUser на POST /comments).

Отказ по правам — это {"error": ...} в ответ модели, действие не выполняется: агент не
сможет сделать ничего сверх того, что разрешено самому пользователю.
"""

import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from app.ai.tools import Tool, ToolContext, _find_similar_incidents, _get_team_profile, _list_teams_overview
from app.domain.classify import sla_info
from app.domain.enums import PRIORITIES, STAFF_ROLES, STATES, TRANSITIONS, Role
from app.services import access, incident_actions
from app.services.incident_query import build_filters
from app.services.store import get_db, get_doc

WRITE_DENIED = (
    "Недостаточно прав: изменять инциденты могут координаторы и администраторы. "
    "Выполнять это действие за пользователя нельзя — сообщите ему об этом."
)
COMMENT_DENIED = (
    "Недостаточно прав: комментарии могут оставлять координаторы, администраторы и тестировщики. "
    "Сообщите пользователю, что это действие вам недоступно."
)
STATES_NAMES = "; ".join(f"{sid} = {name}" for sid, (name, _) in sorted(STATES.items()))
SLA_STATES = {"ok", "warning", "danger", "breached"}


def can(user: dict[str, Any], action: str) -> bool:
    """Что агенту разрешено от имени пользователя — ровно то, что разрешено ему в REST."""
    role = Role(user["role"])
    if action == "incident_write":
        return role in {Role.ADMIN, Role.COORDINATOR}
    if action == "comment":
        return role in STAFF_ROLES
    return False


def _iso(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _cut(value: Any, limit: int) -> str | None:
    """Длинный текст в ответе инструмента: модель видит начало, промпт не раздувается."""
    if not isinstance(value, str) or not value:
        return None
    return value[:limit] + ("…" if len(value) > limit else "")


def _brief(doc: dict[str, Any]) -> dict[str, Any]:
    data = doc["data"]
    return {
        "id": doc["_id"],
        "header": data.get("header"),
        "stateId": data.get("stateId"),
        "state": data.get("state"),
        "priorityId": data.get("priorityId"),
        "assignedGroupName": data.get("assignedGroupName"),
        "assignedEmployee": data.get("assignedEmployee"),
        "deadline": _iso(data.get("deadline")),
    }


async def _visible_doc(ctx: ToolContext, incident_id: str, *, include_deleted: bool = False) -> dict[str, Any] | None:
    """Живой инцидент, видимый пользователю; None — «не найден или недоступен»."""
    doc = await get_doc(incident_id)
    if not doc or (doc["meta"].get("deletedAt") and not include_deleted):
        return None
    if ctx.user is None or not access.can_view(ctx.user, doc):
        return None
    return doc


async def _write_guard(ctx: ToolContext, args: dict[str, Any]) -> dict[str, Any]:
    """Проверка прав и наличие видимого инцидента. Возвращает {"error"} или {"doc": doc}."""
    assert ctx.user is not None
    if not can(ctx.user, "incident_write"):
        return {"error": WRITE_DENIED}
    incident_id = str(args.get("incident_id") or "").strip()
    if not incident_id:
        return {"error": "Укажите incident_id (номер вида INC…)."}
    doc = await _visible_doc(ctx, incident_id)
    if doc is None:
        return {"error": f"Инцидент {incident_id} не найден или вам недоступен."}
    return {"doc": doc}


async def _finish(act) -> dict[str, Any]:
    """Выполнить действие; доменные ошибки возвращаются модели текстом, а не роняют цикл."""
    try:
        updated, summary = await act()
    except incident_actions.ConflictError:
        return {"error": "Инцидент только что изменился (версия не совпала). Перечитайте карточку и повторите."}
    except (incident_actions.ClosedError, incident_actions.InvalidTransitionError) as e:
        return {"error": str(e)}
    return {"summary": summary, "incident": _brief(updated)}


def _ints(value: Any) -> list[int] | None:
    if value is None:
        return None
    values = value if isinstance(value, list) else [value]
    try:
        return [int(v) for v in values]
    except (TypeError, ValueError):
        return None


async def _find_employee(raw: str) -> tuple[dict[str, Any] | None, str | None]:
    """Сотрудник из справочника по точному совпадению (без регистра) ФИО, email, ITSM-логина
    или «ФИО (логин)» — как исполнитель записан в инцидентах.

    Совпадение должно быть точным: назначение связывает карточку с учёткой разработчика
    (assignedEmployeeLogin), опечатка должна вернуться модели ошибкой, а не попасть в инцидент.
    Возвращает (сотрудник, None) либо (None, текст ошибки с похожими сотрудниками).
    """
    needle = raw.casefold()
    users = await get_db().users.find({"deletedAt": None}).to_list(None)
    for u in users:
        login = u.get("itsmLogin")
        name = u.get("fullName") or u.get("email")
        variants = {(u.get("fullName") or "").casefold(), (u.get("email") or "").casefold(), (login or "").casefold()}
        if login:
            variants.add(f"{name} ({login})".casefold())
        if needle in variants:
            return u, None
    similar = [
        u.get("fullName") or u.get("email")
        for u in users
        if needle in (u.get("fullName") or "").casefold() or needle in (u.get("email") or "").casefold()
    ]
    if not similar:
        # полное имя не совпало ни у кого — подбираем по фамилии, её чаще всего и пишут
        surname = needle.split()[0] if needle.split() else ""
        if len(surname) >= 3:
            similar = [
                u.get("fullName") or u.get("email")
                for u in users
                if surname in (u.get("fullName") or "").casefold()
            ]
    similar = similar[:5]
    hint = f" Похожие: {', '.join(similar)}." if similar else ""
    return None, f"Сотрудник {raw!r} не найден в справочнике.{hint} Список сотрудников — list_employees."


# ---------------- чтение ----------------


def _search_incidents_tool(ctx: ToolContext) -> Tool:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        try:
            limit = min(int(args.get("limit") or 5), 15)
        except (TypeError, ValueError):
            return {"error": "limit — целое число."}
        priority_ids = _ints(args.get("priorityId"))
        state_ids = _ints(args.get("stateId"))
        if args.get("priorityId") is not None and priority_ids is None:
            return {"error": "priorityId — число или список чисел (1..4)."}
        if args.get("stateId") is not None and state_ids is None:
            return {"error": f"stateId — число или список чисел из {sorted(STATES)}."}
        sla_states: set[str] | None = None
        raw_sla = args.get("slaState")
        if raw_sla is not None:
            values = raw_sla if isinstance(raw_sla, list) else [raw_sla]
            if not all(isinstance(v, str) and v in SLA_STATES for v in values):
                return {"error": "slaState — одно или несколько из: ok, warning, danger, breached."}
            sla_states = set(values)
        sort = args.get("sort")
        if sort is not None and sort not in ("submitDate", "deadline", "priority"):
            return {"error": "sort — submitDate (свежие сверху), deadline (близкий срок сверху) или priority."}
        query = build_filters(
            priorityId=priority_ids,
            stateId=state_ids,
            assignedGroupName=args.get("assignedGroupName"),
            productName=args.get("productName"),
            q=args.get("q") if isinstance(args.get("q"), str) and args.get("q").strip() else None,
            active=args.get("active") if isinstance(args.get("active"), bool) else None,
        )
        employee = args.get("employee")
        if employee is not None:
            if not isinstance(employee, str) or not employee.strip():
                return {"error": "employee — подстрока имени исполнителя, например фамилия."}
            query["data.assignedEmployee"] = {"$regex": re.escape(employee.strip()), "$options": "i"}
        scope = access.mongo_filter(ctx.user or {})
        if scope:
            query = {"$and": [query, scope]}  # $or поиска и $or доступа не должны перетирать друг друга
        rows: list[dict[str, Any]] = []
        async for d in get_db().incidents.find(query):
            row = {
                **_brief(d),
                "productName": d["data"].get("productName"),
                "scenarioName": d["data"].get("scenarioName"),
                "submitDate": _iso(d["data"].get("submitDate")),
            }
            sla = sla_info(d["data"], ctx.now, ctx.settings)
            row["slaState"] = sla["state"]
            left = sla["timeLeftSeconds"]
            row["timeLeftHours"] = round(left / 3600, 1) if left is not None else None
            if sla_states is None or row["slaState"] in sla_states:
                rows.append(row)
        if sort == "deadline":
            rows.sort(key=lambda r: r["deadline"] or "")
        elif sort == "priority":
            rows.sort(key=lambda r: -r["priorityId"])
        else:
            rows.sort(key=lambda r: r["submitDate"] or "", reverse=True)
        shown = rows[:limit]
        return {
            "summary": f"Совпало {len(rows)}, показано {len(shown)}",
            "matched": len(rows),
            "incidents": shown,
        }

    return Tool(
        name="search_incidents",
        description="Точный поиск инцидентов. Фильтры: q (номер/текст), priorityId, stateId, assignedGroupName, "
                    "employee (исполнитель), productName, active, slaState (ok/warning/danger/breached). "
                    "Сортировка sort. Видны только инциденты, доступные пользователю.",
        parameters={
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "подстрока: номер, заголовок, описание, сервис"},
                "priorityId": {"type": "integer", "description": "1..4"},
                "stateId": {"type": "integer", "description": "0/2/7/10/20"},
                "assignedGroupName": {"type": "string", "description": "имя команды"},
                "employee": {"type": "string", "description": "подстрока имени исполнителя (assignedEmployee)"},
                "productName": {"type": "string"},
                "active": {"type": "boolean", "description": "true — в работе, false — решённые/закрытые"},
                "slaState": {
                    "type": "string",
                    "description": "ok/warning/danger/breached — фильтр по состоянию срока (breached = просрочен)",
                },
                "sort": {"type": "string", "description": "submitDate | deadline | priority"},
                "limit": {"type": "integer", "description": "по умолчанию 5, максимум 15"},
            },
            "additionalProperties": False,
        },
        handler=handler,
    )


def _get_incident_tool(ctx: ToolContext) -> Tool:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        incident_id = args.get("incident_id")
        if not isinstance(incident_id, str) or not incident_id.strip():
            return {"error": "Укажите incident_id (номер вида INC…)."}
        doc = await _visible_doc(ctx, incident_id.strip())
        if doc is None:
            return {"error": f"Инцидент {incident_id} не найден или вам недоступен."}
        data = doc["data"]
        return {
            "summary": f"Карточка {doc['_id']}",
            **_brief(doc),
            "shortDescription": _cut(data.get("shortDescription"), 300),
            "description": _cut(data.get("description"), 800),
            "solution": _cut(data.get("solution"), 400),
            "productName": data.get("productName"),
            "scenarioName": data.get("scenarioName"),
            "initiatorName": data.get("initiatorName"),
            "submitDate": _iso(data.get("submitDate")),
            "allowedTransitions": sorted(TRANSITIONS.get(doc["data"]["stateId"], ())),
        }

    return Tool(
        name="get_incident",
        description="Карточка одного инцидента: описание, решение, статус, срок, SLA, команда. "
                    "Сначала получите её, прежде чем менять что-то.",
        parameters={
            "type": "object",
            "properties": {"incident_id": {"type": "string", "description": "номер инцидента INC…"}},
            "required": ["incident_id"],
            "additionalProperties": False,
        },
        handler=handler,
    )


def _dashboard_summary_tool(ctx: ToolContext) -> Tool:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        s = ctx.settings
        day_start = ctx.now.astimezone(ZoneInfo(s.business_tz)).replace(hour=0, minute=0, second=0, microsecond=0)
        scope = access.mongo_filter(ctx.user or {})
        base = {"meta.deletedAt": None, "meta.isActive": True}
        query = {"$and": [base, scope]} if scope else base
        kpi = {"active": 0, "critical": 0, "research": 0, "unassigned": 0, "resolvedToday": 0}
        by_group: dict[str, int] = {}
        async for d in get_db().incidents.find(query, {"data": 1, "meta.groups": 1}):
            data = d["data"]
            kpi["active"] += 1
            if data.get("priorityId") == s.critical_priority_id:
                kpi["critical"] += 1
            if data.get("stateId") == 20:
                kpi["research"] += 1
            if not data.get("assignedGroupName"):
                kpi["unassigned"] += 1
            for g in d.get("meta", {}).get("groups", []):
                by_group[g] = by_group.get(g, 0) + 1
        kpi["resolvedToday"] = await get_db().incidents.count_documents(
            {"$and": [{"meta.deletedAt": None, "meta.resolvedAt": {"$gte": day_start}}, scope]}
        )
        return {
            "summary": f"В работе {kpi['active']} инцидентов, из них критических {kpi['critical']}",
            "kpi": kpi,
            "groups": by_group,
            "now": _iso(ctx.now),
        }

    return Tool(
        name="dashboard_summary",
        description="Сводка дашборда: сколько инцидентов в работе, критических, в исследовании, без команды, "
                    "решено сегодня; счётчики по группам внимания. Для списков инцидентов — search_incidents.",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        handler=handler,
    )


def _team_overview_tool(ctx: ToolContext) -> Tool:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        result = await _list_teams_overview(ctx)
        return {"summary": f"Сводка по {len(result['teams'])} командам", **result}

    return Tool(
        name="list_teams_overview",
        description="Сводка по всем командам: активные/критические/просроченные (SLA) инциденты, решено за "
                    "30 дней, среднее время решения, доля SLA. Плюс общий средний уровень.",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        handler=handler,
    )


def _team_stats_tool(ctx: ToolContext) -> Tool:
    """Компактная статистика команды: те же данные, что и get_team_profile в tools.py,
    но без списков инцидентов — счётчики считаются по полному набору, наружу идёт агрегат."""

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        group = args.get("group")
        if not isinstance(group, str) or not group:
            return {"error": "Укажите group — точное имя команды из list_teams_overview."}
        result = await _get_team_profile(ctx, {"group": group})
        if "error" in result:
            return result
        active = result["active"]
        breached = sum(1 for r in active if r.get("slaState") == "breached")
        return {
            "summary": f"Команда «{group}»: активных {result['activeCount']}, просроченных {breached}",
            "group": group,
            "activeCount": result["activeCount"],
            "criticalActive": sum(1 for r in active if r.get("priorityId") == ctx.settings.critical_priority_id),
            "breachedActive": breached,
            "resolvedLast90DaysCount": result["resolvedLast90DaysCount"],
            "avgResolutionMinutes": result["avgResolutionMinutes"],
            "slaMetRate": result["slaMetRate"],
            "topProducts": result["topProducts"],
            "topExecutors": result["topExecutors"],
        }

    return Tool(
        name="team_stats",
        description="Статистика одной команды: сколько активных/критических/просроченных инцидентов, "
                    "решено за 90 дней, средняя скорость, доля SLA, топ продуктов и исполнителей.",
        parameters={
            "type": "object",
            "properties": {"group": {"type": "string", "description": "точное имя команды из list_teams_overview"}},
            "required": ["group"],
            "additionalProperties": False,
        },
        handler=handler,
    )


def _employees_tool(ctx: ToolContext) -> Tool:
    """Справочник сотрудников системы (как GET /users у StaffUser): кто есть, чем занят сейчас.

    Загрузка — активные инциденты, где сотрудник исполнитель по ITSM-логину или добавлен
    в участники; карточка считается один раз, даже если совпали и логин, и участие.
    """

    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        try:
            limit = min(int(args.get("limit") or 25), 50)
        except (TypeError, ValueError):
            return {"error": "limit — целое число."}
        query: dict[str, Any] = {"deletedAt": None}
        raw_role = args.get("role")
        if raw_role is not None:
            try:
                query["role"] = Role(raw_role).value
            except ValueError:
                return {"error": "role — одно из: admin, coordinator, viewer, developer."}
        users = await get_db().users.find(query).sort("fullName", 1).to_list(None)
        q = args.get("q")
        q = q.strip().casefold() if isinstance(q, str) and q.strip() else None
        if q:
            users = [
                u
                for u in users
                if q in (u.get("fullName") or "").casefold()
                or q in (u.get("email") or "").casefold()
                or q in (u.get("itsmLogin") or "").casefold()
            ]
        team = args.get("team")
        team = team.strip() if isinstance(team, str) and team.strip() else None
        if team:
            users = [u for u in users if (u.get("team") or "") == team]
        cards: list[tuple[str | None, list[str]]] = []
        async for d in get_db().incidents.find(
            {"meta.deletedAt": None, "meta.isActive": True}, {"members": 1, "data.assignedEmployeeLogin": 1}
        ):
            cards.append((d["data"].get("assignedEmployeeLogin"), d.get("members") or []))

        def load(u: dict[str, Any]) -> int:
            login = u.get("itsmLogin")
            return sum(1 for card_login, members in cards if (login and card_login == login) or u["_id"] in members)

        shown = users[:limit]
        employees = [
            {
                "id": u["_id"],
                "fullName": u.get("fullName"),
                "email": u.get("email"),
                "role": u.get("role"),
                "team": u.get("team"),
                "itsmLogin": u.get("itsmLogin"),
                "activeIncidents": load(u),
            }
            for u in shown
        ]
        summary = f"Сотрудников: {len(users)}"
        if len(users) > len(shown):
            summary += f", показано {len(shown)}"
        return {"summary": summary, "employees": employees}

    return Tool(
        name="list_employees",
        description="Справочник сотрудников системы: ФИО, email, роль, команда, ITSM-логин и текущая загрузка "
                    "(число активных инцидентов). Фильтры: q (подстрока ФИО/email/логина), role, team. "
                    "Ищите здесь, прежде чем назначать исполнителя.",
        parameters={
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "подстрока ФИО, email или ITSM-логина"},
                "role": {"type": "string", "description": "admin | coordinator | viewer | developer"},
                "team": {"type": "string", "description": "точное имя команды разработчика"},
                "limit": {"type": "integer", "description": "по умолчанию 25, максимум 50"},
            },
            "additionalProperties": False,
        },
        handler=handler,
    )


def _similar_tool(ctx: ToolContext) -> Tool:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        payload = {**args, "limit": args.get("limit") or 5}
        result = await _find_similar_incidents(ctx, payload)
        if "error" in result:
            return result
        result["incidents"] = [{**r, "solution": _cut(r.get("solution"), 160)} for r in result["incidents"]]
        return {"summary": f"Похожих инцидентов: {result['count']}", **result}

    return Tool(
        name="find_similar_incidents",
        description="Прошлые инциденты того же продукта (и опционально сценария): кто решал, сколько заняло, "
                    "каким было решение.",
        parameters={
            "type": "object",
            "properties": {
                "product": {"type": "string", "description": "productName инцидента"},
                "scenario": {"type": "string", "description": "scenarioName для более узкого поиска"},
                "limit": {"type": "integer", "description": "по умолчанию 5, максимум 20"},
            },
            "required": ["product"],
            "additionalProperties": False,
        },
        handler=handler,
    )


# ---------------- действия ----------------


def action_tools(ctx: ToolContext) -> dict[str, Tool]:
    """Все инструменты-действия; какие из них выдавать агенту, решает chat_tools по правам."""
    user = ctx.user or {}

    def assign_tool() -> Tool:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            guard = await _write_guard(ctx, args)
            if "error" in guard:
                return guard
            group = args.get("group")
            if group is not None and (not isinstance(group, str) or not group.strip()):
                return {"error": "group — точное имя команды."}
            employee_raw = args.get("employee")
            if employee_raw is not None and (not isinstance(employee_raw, str) or not employee_raw.strip()):
                return {"error": "employee — ФИО, email или ITSM-логин сотрудника из справочника (list_employees)."}
            if group is None and employee_raw is None:
                return {"error": "Укажите хотя бы одно: group (команда) или employee (сотрудник)."}
            matched: dict[str, Any] | None = None
            fields: dict[str, Any] = {}
            if employee_raw is not None:
                matched, error = await _find_employee(employee_raw.strip())
                if matched is None:
                    return {"error": error}
                login = matched.get("itsmLogin")
                name = matched.get("fullName") or matched.get("email")
                if login:
                    # формат записи исполнителя в ITSM — «ФИО (логин)»; логин связывает карточку
                    # с учёткой разработчика (уведомление, доступ)
                    fields["assignedEmployee"] = f"{name} ({login})"
                    fields["assignedEmployeeLogin"] = login
                else:
                    fields["assignedEmployee"] = name
                    # прежний исполнитель мог быть назначен по логину — сбрасываем его, иначе
                    # у старого разработчика остаются доступ и уведомления по чужой карточке
                    fields["assignedEmployeeLogin"] = None
            if group is not None:
                group = group.strip()
                if group not in ctx.known_groups:
                    return {"error": f"Команда {group!r} не входит в список известных команд. Доступны: {ctx.known_groups}"}
                fields["assignedGroupName"] = group

            async def act() -> tuple[dict[str, Any], str]:
                updated = await incident_actions.apply_patch(guard["doc"], fields, user)
                if matched is not None and not matched.get("itsmLogin"):
                    # доступ и уведомление разработчику без ITSM-логина даёт участие в инциденте —
                    # так же делает назначение из интерфейса
                    await incident_actions.add_member(updated["_id"], matched, user)
                if fields.get("assignedGroupName") is not None:
                    summary = f"{updated['_id']}: назначена команда «{updated['data']['assignedGroupName']}»"
                    if matched is not None:
                        summary += f", исполнитель {updated['data'].get('assignedEmployee')}"
                else:
                    summary = f"{updated['_id']}: назначен исполнитель {updated['data'].get('assignedEmployee')}"
                return updated, summary

            return await _finish(act)

        return Tool(
            name="assign_team",
            description="Назначить инцидент команде и/или исполнителю. Исполнитель — сотрудник из справочника "
                        "(сначала найдите его через list_employees), ему придёт уведомление. Выполняется сразу.",
            parameters={
                "type": "object",
                "properties": {
                    "incident_id": {"type": "string", "description": "номер инцидента INC…"},
                    "group": {"type": "string", "description": "точное имя команды из известных"},
                    "employee": {
                        "type": "string",
                        "description": "сотрудник: точное ФИО, email или ITSM-логин из list_employees",
                    },
                },
                "required": ["incident_id"],
                "additionalProperties": False,
            },
            handler=handler,
        )

    def set_priority_tool() -> Tool:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            guard = await _write_guard(ctx, args)
            if "error" in guard:
                return guard
            ids = _ints(args.get("priority_id"))
            if ids is None or len(ids) != 1 or not 1 <= ids[0] <= 4:
                return {"error": "priority_id — целое число 1 (низкий), 2 (средний), 3 (высокий), 4 (наивысший)."}
            priority_id = ids[0]

            async def act() -> tuple[dict[str, Any], str]:
                updated = await incident_actions.apply_patch(guard["doc"], {"priorityId": priority_id}, user)
                return updated, f"{updated['_id']}: приоритет изменён на «{PRIORITIES[priority_id]}»"

            return await _finish(act)

        return Tool(
            name="set_priority",
            description="Изменить приоритет инцидента. Выполняется сразу.",
            parameters={
                "type": "object",
                "properties": {
                    "incident_id": {"type": "string", "description": "номер инцидента INC…"},
                    "priority_id": {"type": "integer", "description": "1 низкий, 2 средний, 3 высокий, 4 наивысший"},
                },
                "required": ["incident_id", "priority_id"],
                "additionalProperties": False,
            },
            handler=handler,
        )

    def set_deadline_tool() -> Tool:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            guard = await _write_guard(ctx, args)
            if "error" in guard:
                return guard
            raw = args.get("deadline")
            if not isinstance(raw, str) or not raw.strip():
                return {"error": "deadline — дата и время в ISO-8601, например 2026-11-22T18:00:00+03:00."}
            try:
                deadline = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
            except ValueError:
                return {"error": f"Не удалось разобрать deadline={raw!r}. Нужен ISO-8601."}

            async def act() -> tuple[dict[str, Any], str]:
                updated = await incident_actions.apply_patch(guard["doc"], {"deadline": deadline}, user)
                return updated, f"{updated['_id']}: новый срок {_iso(updated['data'].get('deadline'))}"

            return await _finish(act)

        return Tool(
            name="set_deadline",
            description="Изменить срок (дедлайн) инцидента. Выполняется сразу.",
            parameters={
                "type": "object",
                "properties": {
                    "incident_id": {"type": "string", "description": "номер инцидента INC…"},
                    "deadline": {"type": "string", "description": "ISO-8601, например 2026-11-22T18:00:00+03:00"},
                },
                "required": ["incident_id", "deadline"],
                "additionalProperties": False,
            },
            handler=handler,
        )

    def change_state_tool() -> Tool:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            guard = await _write_guard(ctx, args)
            if "error" in guard:
                return guard
            ids = _ints(args.get("to_state_id"))
            if ids is None or len(ids) != 1 or ids[0] not in STATES:
                return {"error": f"to_state_id — целое число из списка статусов ({STATES_NAMES})."}
            to_state_id = ids[0]
            state_reason = args.get("state_reason") if isinstance(args.get("state_reason"), str) else None
            solution = args.get("solution") if isinstance(args.get("solution"), str) else None

            async def act() -> tuple[dict[str, Any], str]:
                updated = await incident_actions.apply_transition(
                    guard["doc"], to_state_id, state_reason=state_reason, solution=solution, user=user
                )
                return updated, f"{updated['_id']}: статус → «{STATES[to_state_id][0]}»"

            return await _finish(act)

        return Tool(
            name="change_state",
            description=f"Перевести инцидент в новый статус по процессу. Статусы: {STATES_NAMES}. "
                        "Закрытый (10) изменить нельзя. Выполняется сразу.",
            parameters={
                "type": "object",
                "properties": {
                    "incident_id": {"type": "string", "description": "номер инцидента INC…"},
                    "to_state_id": {"type": "integer", "description": "0/2/7/10/20"},
                    "state_reason": {"type": "string", "description": "необязательно: причина"},
                    "solution": {"type": "string", "description": "необязательно: текст решения при завершении"},
                },
                "required": ["incident_id", "to_state_id"],
                "additionalProperties": False,
            },
            handler=handler,
        )

    def ack_tool() -> Tool:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            guard = await _write_guard(ctx, args)
            if "error" in guard:
                return guard
            await incident_actions.acknowledge(guard["doc"], user)
            return {
                "summary": f"{guard['doc']['_id']}: принят в работу (подтверждено)",
                "incident": _brief(guard["doc"]),
            }

        return Tool(
            name="ack_incident",
            description="«Принять в работу» инцидент: у координаторов гаснет баннер нового критического. "
                        "Выполняется сразу.",
            parameters={
                "type": "object",
                "properties": {"incident_id": {"type": "string", "description": "номер инцидента INC…"}},
                "required": ["incident_id"],
                "additionalProperties": False,
            },
            handler=handler,
        )

    def comment_tool() -> Tool:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            assert ctx.user is not None
            if not can(ctx.user, "comment"):
                return {"error": COMMENT_DENIED}
            incident_id = str(args.get("incident_id") or "").strip()
            if not incident_id:
                return {"error": "Укажите incident_id (номер вида INC…)."}
            doc = await _visible_doc(ctx, incident_id)
            if doc is None:
                return {"error": f"Инцидент {incident_id} не найден или вам недоступен."}
            text = args.get("text")
            if not isinstance(text, str) or not text.strip() or len(text) > 5000:
                return {"error": "text — непустая строка до 5000 символов."}
            created = await incident_actions.add_comment(doc["_id"], text.strip(), ctx.user)
            return {"summary": f"{doc['_id']}: добавлен комментарий", "comment": {"id": created["_id"]}}

        return Tool(
            name="add_comment",
            description="Оставить комментарий к инциденту от имени пользователя. Выполняется сразу.",
            parameters={
                "type": "object",
                "properties": {
                    "incident_id": {"type": "string", "description": "номер инцидента INC…"},
                    "text": {"type": "string", "description": "текст комментария по-русски"},
                },
                "required": ["incident_id", "text"],
                "additionalProperties": False,
            },
            handler=handler,
        )

    def archive_tool() -> Tool:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            guard = await _write_guard(ctx, args)
            if "error" in guard:
                return guard
            await incident_actions.archive(guard["doc"], user)
            return {"summary": f"{guard['doc']['_id']}: перемещён в архив (мягкое удаление)"}

        return Tool(
            name="archive_incident",
            description="Переместить инцидент в архив (мягкое удаление, история сохраняется). Выполняется сразу: "
                        "используйте только когда пользователь явно попросил убрать/отменить инцидент.",
            parameters={
                "type": "object",
                "properties": {"incident_id": {"type": "string", "description": "номер инцидента INC…"}},
                "required": ["incident_id"],
                "additionalProperties": False,
            },
            handler=handler,
        )

    def restore_tool() -> Tool:
        async def handler(args: dict[str, Any]) -> dict[str, Any]:
            assert ctx.user is not None
            if not can(ctx.user, "incident_write"):
                return {"error": WRITE_DENIED}
            incident_id = str(args.get("incident_id") or "").strip()
            if not incident_id:
                return {"error": "Укажите incident_id (номер вида INC…)."}
            doc = await _visible_doc(ctx, incident_id, include_deleted=True)  # в архиве — не «живой», но видимый
            if doc is None:
                return {"error": f"Инцидент {incident_id} не найден или вам недоступен."}
            if not doc["meta"].get("deletedAt"):
                return {"error": f"Инцидент {incident_id} не в архиве — восстанавливать нечего."}

            async def act() -> tuple[dict[str, Any], str]:
                updated = await incident_actions.apply_patch(doc, dict(doc["data"]), user)
                return updated, f"{updated['_id']}: восстановлен из архива"

            return await _finish(act)

        return Tool(
            name="restore_incident",
            description="Восстановить инцидент из архива. Выполняется сразу.",
            parameters={
                "type": "object",
                "properties": {"incident_id": {"type": "string", "description": "номер инцидента INC…"}},
                "required": ["incident_id"],
                "additionalProperties": False,
            },
            handler=handler,
        )

    return {
        "assign_team": assign_tool(),
        "set_priority": set_priority_tool(),
        "set_deadline": set_deadline_tool(),
        "change_state": change_state_tool(),
        "ack_incident": ack_tool(),
        "add_comment": comment_tool(),
        "archive_incident": archive_tool(),
        "restore_incident": restore_tool(),
    }


WRITE_ACTIONS = (
    "assign_team",
    "set_priority",
    "set_deadline",
    "change_state",
    "ack_incident",
    "archive_incident",
    "restore_incident",
)


def chat_tools(ctx: ToolContext) -> list[Tool]:
    """Набор инструментов чат-агента: зависит от роли пользователя в ctx.user.

    Агент получает только те инструменты, которые ему реально разрешено исполнить,
    плюс каждый инструмент повторно проверяет права (защита от рассинхрона матрицы).
    """
    assert ctx.user is not None
    if access.is_developer(ctx.user):
        # в REST у разработчика единственная мутация — «исправлен» на своём инциденте;
        # агенту выдаётся только чтение его инцидентов
        return [_search_incidents_tool(ctx), _get_incident_tool(ctx), _dashboard_summary_tool(ctx)]
    tools: list[Tool] = [
        _search_incidents_tool(ctx),
        _get_incident_tool(ctx),
        _dashboard_summary_tool(ctx),
        _employees_tool(ctx),
        _team_overview_tool(ctx),
        _team_stats_tool(ctx),
        _similar_tool(ctx),
    ]
    actions = action_tools(ctx)
    if can(ctx.user, "incident_write"):
        tools += [actions[name] for name in WRITE_ACTIONS]
    if can(ctx.user, "comment"):
        tools.append(actions["add_comment"])
    return tools
