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


def _iso(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None
