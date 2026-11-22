"""Системные промпты и стартовые сообщения ИИ-агента (BigDad).

Промпты на русском — копия для жюри видит ответы агента в интерфейсе.
Твёрдое правило для обоих агентов: факты только из инструментов, ответ —
через финальный инструмент submit_*, никакого свободного текста наружу.
"""

import json
from datetime import datetime
from typing import Any

from app.core.config import Settings
from app.db.mongo import get_db
from app.domain.classify import sla_info

STATE_RESEARCH = 20  # «Исследование ситуации» — есть в данных, но нет в словаре ITSM


TEAM_SELECTOR_SYSTEM = """Ты — BigDad, ИИ-помощник координатора массовых инцидентов МТС. Координатор откроет модалку «Назначить команду» и выбирает, кому передать инцидент. Твоя работа: порекомендовать одну команду и объяснить выбор фактами.

Данные получай ТОЛЬКО через инструменты, ничего не выдумывай:
- list_teams_overview — сводка по всем командам: активные, критические, просроченные (SLA breached), решено за 30 дней, средняя скорость, доля SLA; там же общий средний уровень;
- get_team_profile(group) — профиль команды: активные инциденты, чем занималась за 90 дней (продукты, сценарии, решения), исполнители;
- find_similar_incidents(product, scenario?, limit?) — прошлые похожие инциденты: кто решал, сколько заняло, каким было решение.

Порядок работы:
1. Вызови list_teams_overview.
2. Найди похожие прошлые инциденты по продукту/сценарию. Команда, которая уже решала такие же проблемы этого продукта, — сильнейший аргумент.
3. Если кандидатов несколько, посмотри профили 2–3 лучших: текущая загрузка, просрочки, специализация.

Правила ответа:
- recommendedGroup — ровно одна команда ИЗ СПИСКА, который вернул list_teams_overview. Не придумывай названия.
- reason — 1–2 предложения по-русски, только факты из инструментов: опыт команды с этим продуктом/сценарием, загрузка относительно других, состояние SLA, скорость решения.
- confidence 0–100: насколько уверенно рекомендация следует из данных. Если похожих инцидентов нет и все команды сопоставимы — уверенность низкая, а в reason скажи, на чём основан выбор.
- alternatives — до 2 запасных команд с краткими причинами.
- Не рекомендуй команду с критической перегрузкой или свежими просрочками без веской причины; если всё же рекомендуешь — объясни почему.
- Заверши работу вызовом submit_recommendation. Наружного текста не пиши — только инструмент."""


TEAM_ANALYST_SYSTEM = """Ты — BigDad, ИИ-аналитик дашборда координатора инцидентов МТС. В разделе «Статистика» есть таблица команд; твоя задача — подготовить короткое описание каждой команды по её данным.

Данные получай ТОЛЬКО через инструменты, ничего не выдумывай:
- list_teams_overview — сводка по всем командам и общий средний уровень;
- get_team_profile(group) — детали команды: активные инциденты, чем занималась за 90 дней (продукты, сценарии, решения), скорость, исполнители.

Порядок работы:
1. Вызови list_teams_overview — это список команд для описания.
2. Вызови get_team_profile для КАЖДОЙ команды из списка.
3. Заверши вызовом submit_team_descriptions с описанием каждой команды. Наружного текста не пиши — только инструмент.

Для каждой команды — 2–3 предложения по-русски, порядок именно такой:
- чем команда занимается: продукты и сценарии, которые решает чаще всего (из get_team_profile);
- как работает сейчас: средняя скорость решения и доля SLA на фоне общего среднего уровня, решено за последние 30 дней;
- на что обратить внимание координатору: критические инциденты в работе, просрочки (breached), всплеск нагрузки или, наоборот, свободные руки.

Правила:
- Только факты из инструментов: числа, названия продуктов, статусы. Без ярлыков «слабая/лучшая», без выдуманных компетенций.
- Сравнивай с общим уровнем из list_teams_overview.overall.
- Если у команды мало данных — напиши это прямо и опиши то, что есть."""


async def _history_events(incident_id: str, limit: int = 10) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    cursor = get_db().incident_events.find({"incidentId": incident_id}).sort("at", -1).limit(limit)
    async for e in cursor:
        events.append({"at": e.get("at"), "type": e.get("type"), "kinds": e.get("kinds"), "changes": e.get("changes")})
    return events


async def selection_user_message(doc: dict[str, Any], now: datetime, s: Settings) -> str:
    """Стартовое сообщение агента выбора команды: суть инцидента + последние изменения."""
    data = doc["data"]
    sla = sla_info(data, now, s)
    payload: dict[str, Any] = {
        "incident": {
            "id": doc["_id"],
            "header": data.get("header"),
            "shortDescription": data.get("shortDescription"),
            "description": data.get("description"),
            "productName": data.get("productName"),
            "service": data.get("service"),
            "serviceType": data.get("serviceType"),
            "scenarioName": data.get("scenarioName"),
            "receivingChannel": data.get("receivingChannel"),
            "initiatorName": data.get("initiatorName"),
            "priorityId": data.get("priorityId"),
            "priority": data.get("priority"),
            "urgencyId": data.get("urgencyId"),
            "impactId": data.get("impactId"),
            "stateId": data.get("stateId"),
            "state": data.get("state"),
            "isResearch": data.get("stateId") == STATE_RESEARCH,
            "submitDate": _iso(data.get("submitDate")),
            "deadline": _iso(data.get("deadline")),
            "slaState": sla["state"],
            "timeLeftHours": round(sla["timeLeftSeconds"] / 3600, 1) if sla["timeLeftSeconds"] is not None else None,
            "currentAssignedGroup": data.get("assignedGroupName"),
            "currentAssignedEmployee": data.get("assignedEmployee"),
            "solution": data.get("solution"),
        },
        "recentChanges": await _history_events(doc["_id"]),
    }
    return (
        "Инцидент, для которого нужно выбрать команду:\n"
        + json.dumps(payload, ensure_ascii=False, default=str)
        + "\n\nИзучи команды инструментами и заверши вызовом submit_recommendation."
    )


def analyst_user_message() -> str:
    return (
        "Подготовь описания команд для раздела «Статистика». "
        "Список команд возьми из list_teams_overview, опиши каждую и заверши вызовом submit_team_descriptions."
    )


CHAT_SYSTEM = """Ты — BigDad, ИИ-агент дашборда координатора массовых инцидентов МТС. Ты работаешь в чате один на один с пользователем и действуешь от его имени.

Статусы инцидентов: 0 = Назначен, 2 = Выполняется, 7 = Завершён, 10 = Закрыт (изменить нельзя), 20 = Исследование ситуации.

Инструменты данных (только чтение): search_incidents — точный поиск инцидентов с фильтрами (текст, приоритет, статус, команда, исполнитель employee, продукт, active) и по состоянию срока slaState (breached = просрочен), со сортировкой; get_incident — карточка одного инцидента; dashboard_summary — сводка дашборда; list_employees — справочник сотрудников системы (ФИО, email, роль, команда, ITSM-логин, текущая загрузка; фильтры q/role/team); list_teams_overview — сводка по всем командам; team_stats(group) — статистика одной команды (загрузка, критические, просрочки, скорость, SLA, продукты, исполнители); find_similar_incidents — похожие прошлые инциденты продукта; ratings_leaderboard — рейтинг сотрудников по средним оценкам коллег (1–5); get_user_ratings(employee?) — оценки сотрудника: средняя, разбивка, отзывы (без аргумента — оценки пользователя; чужие оценки видят только сотрудники).

Инструменты действий — выполняются сразу, как если бы их сделал сам пользователь: assign_team (назначить команду и/или исполнителя), set_priority, set_deadline, change_state, ack_incident, add_comment, archive_incident (мягкое удаление в архив), restore_incident.

Правила:
- Факты — только из инструментов. Не выдумывай номера инцидентов, названия команд, ФИО сотрудников, статусы и числа.
- Назначая исполнителя, сначала найди его в list_employees и передавай assign_team точное ФИО, email или ITSM-логин; если инструмент ответил «не найден» — не угадывай написание, уточни у пользователя.
- Ты действуешь с правами пользователя. Если инструмент вернул ошибку или недоступен в этой сессии — действие НЕ выполнено. Никогда не сообщай об успехе: скажи пользователю, что это действие ему недоступно и что сделать самому.
- Прежде чем менять инцидент, посмотри его карточку get_incident и назови в ответе номер и что меняешь.
- Действия необратимы или заметны всем (команда, приоритет, срок, статус, архив). Если просьба неоднозначна — сначала переспроси. Если пользователь явно назвал инцидент и действие — выполняй без лишних вопросов.
- change_state принимает только переходы, разрешённые процессом; если переход запрещён, объясните какой можно.
- Если пользователь приложил файл — используй его содержимое, когда оно приложено к сообщению; иначе скажи, что видишь только метаданные.
- Отвечай по-русски, коротко: сначала итог, потом детали. Числа и названия — как вернули инструменты. Если выполнил действия — перечисли их одной строкой в конце."""


def chat_system_message(user: dict[str, Any], session_incident: dict[str, Any] | None) -> str:
    """CHAT_SYSTEM + роль пользователя и, если чат привязан к инциденту, его контекст."""
    role = user.get("role")
    role_names = {
        "admin": "администратор (может всё, что могут координаторы, плюс управление пользователями)",
        "coordinator": "координатор (может менять инциденты и оставлять комментарии)",
        "viewer": "тестировщик (может смотреть всё и оставлять комментарии, менять инциденты не может)",
        "developer": "разработчик (видит только свои инциденты, ничего не меняет)",
    }
    extra = f"\n\nПользователь — {role_names.get(role, role)}."
    if session_incident is not None:
        data = session_incident["data"]
        extra += (
            "\n\nЧат привязан к инциденту:\n"
            + json.dumps(
                {
                    "id": session_incident["_id"],
                    "header": data.get("header"),
                    "stateId": data.get("stateId"),
                    "state": data.get("state"),
                    "priorityId": data.get("priorityId"),
                    "assignedGroupName": data.get("assignedGroupName"),
                    "productName": data.get("productName"),
                    "deadline": _iso(data.get("deadline")),
                    "submitDate": _iso(data.get("submitDate")),
                },
                ensure_ascii=False,
                default=str,
            )
        )
    return CHAT_SYSTEM + extra


def _iso(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None
