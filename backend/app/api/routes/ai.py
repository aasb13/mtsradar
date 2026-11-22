"""ИИ-часть.

Два пути:
  1. Встроенный ИИ-агент (app/ai/) по требованию: рекомендация команды в модалке
     «Назначить команду» (POST /incidents/{id}/ai/team-recommendation) и описания
     команд в разделе статистики (GET/POST /ai/team-descriptions). Модель — любая
     OpenAI-совместимая, настройки LLM_* в .env.
  2. Контракт с внешним ИИ-сервисом (его делает коллега):
     подписка на RabbitMQ (exchange incidents.events, ключи incident.created,
     incident.updated, ai.requested), контекст через GET /api/internal/incidents/{id}/context
     (X-Service-Key), результат через PUT /api/internal/incidents/{id}/ai (X-Service-Key).
     Бэкенд сохраняет его и рассылает incident.ai_updated всем браузерам.
ИИ ничего не меняет в самих данных инцидента — только рекомендации.
"""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.ai import agent as ai_agent
from app.ai.llm import LlmError, LlmNotConfigured
from app.ai.prompts import TEAM_ANALYST_SYSTEM, TEAM_SELECTOR_SYSTEM, analyst_user_message, selection_user_message
from app.ai.tools import ToolContext, analyst_tools, selection_tools
from app.api.deps import CoordinatorUser, ServiceAuth, StaffUser
from app.bus import rabbit
from app.core.config import get_settings
from app.db.mongo import get_db
from app.services import presenter
from app.services.store import actor_of, get_doc

router = APIRouter(tags=["ai"])


class AiResult(BaseModel):
    summary: str | None = Field(None, description="2–3 предложения: что произошло")
    riskScore: int | None = Field(None, ge=0, le=100, description="риск перерасти в критический")
    riskReason: str | None = None
    recommendedGroup: str | None = Field(None, description="какой команде передать (assignedGroupName)")
    recommendedReason: str | None = None
    breachForecast: dict[str, Any] | None = Field(None, description="прогноз нарушения срока, формат свободный")
    model: str | None = None
    extra: dict[str, Any] | None = None


async def _known_groups() -> list[str]:
    """Команды, известные системе: все assignedGroupName из живых инцидентов."""
    return sorted(x for x in await get_db().incidents.distinct("data.assignedGroupName", {"meta.deletedAt": None}) if x)


def _http_error(e: LlmError) -> HTTPException:
    code = status.HTTP_503_SERVICE_UNAVAILABLE if isinstance(e, LlmNotConfigured) else status.HTTP_502_BAD_GATEWAY
    return HTTPException(code, str(e))


# ---------------- встроенный ИИ-агент: выбор команды ----------------


@router.post("/incidents/{incident_id}/ai/team-recommendation")
async def recommend_team(incident_id: str, user: CoordinatorUser) -> dict[str, Any]:
    """Рекомендация команды для инцидента (модалка «Назначить команду»).

    Прогоняет агента с инструментами и сохраняет результат в ai инцидента
    (recommendedGroup/recommendedReason/…), рассылая incident.ai_updated.
    """
    doc = await get_doc(incident_id)
    if not doc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Инцидент не найден")
    s = get_settings()
    now = datetime.now(UTC)
    ctx = ToolContext(now=now, settings=s, known_groups=await _known_groups(), incident_id=incident_id)
    try:
        message = await selection_user_message(doc, now, s)
        rec = await ai_agent.run_agent(ctx, TEAM_SELECTOR_SYSTEM, message, selection_tools(ctx))
    except LlmError as e:
        raise _http_error(e) from e
    fields = {
        "ai.recommendedGroup": rec["recommendedGroup"],
        "ai.recommendedReason": rec["reason"],
        "ai.recommendedConfidence": rec["confidence"],
        "ai.recommendedAlternatives": rec["alternatives"],
        "ai.recommendedAt": now,
        "ai.recommendedModel": s.llm_model,
        "ai.updatedAt": now,
        "ai.stale": False,
    }
    # если ai ещё null, вложенные поля через $set в null не создать — сначала делаем пустой объект
    await get_db().incidents.update_one({"_id": incident_id, "ai": None}, {"$set": {"ai": {}}})
    await get_db().incidents.update_one({"_id": incident_id}, {"$set": fields})
    updated = await get_doc(incident_id)
    await rabbit.publish(
        "incident.ai_updated",
        {"incidentId": incident_id, "ai": updated["ai"], "card": presenter.card(updated, now)},
    )
    return {"requestedBy": actor_of(user), "model": s.llm_model, **rec}


# ---------------- встроенный ИИ-агент: описания команд для статистики ----------------


@router.get("/ai/team-descriptions")
async def team_descriptions(_: StaffUser) -> dict[str, Any]:
    """Сохранённые описания команд (кэш последнего прогона агента)."""
    rows = [
        {"group": d["_id"], "text": d["text"], "model": d.get("model"), "updatedAt": d.get("updatedAt")}
        async for d in get_db().team_descriptions.find()
    ]
    return {"descriptions": sorted(rows, key=lambda r: r["group"])}


@router.post("/ai/team-descriptions")
async def refresh_team_descriptions(_: CoordinatorUser) -> dict[str, Any]:
    """Перегенерация описаний всех команд одним прогоном агента."""
    s = get_settings()
    known = await _known_groups()
    if not known:
        return {"descriptions": []}
    ctx = ToolContext(now=datetime.now(UTC), settings=s, known_groups=known)
    try:
        result = await ai_agent.run_agent(ctx, TEAM_ANALYST_SYSTEM, analyst_user_message(), analyst_tools(ctx))
    except LlmError as e:
        raise _http_error(e) from e
    now = datetime.now(UTC)
    for item in result["descriptions"]:
        await get_db().team_descriptions.replace_one(
            {"_id": item["group"]},
            {"_id": item["group"], "text": item["text"], "model": s.llm_model, "updatedAt": now},
            upsert=True,
        )
    rows = [
        {"group": d["_id"], "text": d["text"], "model": d.get("model"), "updatedAt": d.get("updatedAt")}
        async for d in get_db().team_descriptions.find()
    ]
    return {"descriptions": sorted(rows, key=lambda r: r["group"])}


# ---------------- контракт с внешним ИИ-сервисом ----------------


@router.post("/incidents/{incident_id}/ai/refresh", status_code=202)
async def request_ai(incident_id: str, user: CoordinatorUser) -> dict[str, Any]:
    if not await get_doc(incident_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Инцидент не найден")
    env = await rabbit.publish("ai.requested", {"incidentId": incident_id, "requestedBy": actor_of(user)})
    return {"requested": True, "eventId": env["eventId"]}


@router.get("/internal/incidents/{incident_id}/context", dependencies=[ServiceAuth])
async def ai_context(incident_id: str) -> dict[str, Any]:
    doc = await get_doc(incident_id)
    if not doc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Инцидент не найден")
    data = doc["data"]
    history = [
        {k: e.get(k) for k in ("at", "type", "source", "kinds", "changes")}
        async for e in get_db().incident_events.find({"incidentId": incident_id}).sort("at", -1).limit(20)
    ]
    similar_q = {
        "_id": {"$ne": incident_id},
        "meta.deletedAt": None,
        "data.productName": data.get("productName"),
        "data.scenarioName": data.get("scenarioName"),
    }
    similar = [
        {
            "id": d["_id"],
            "stateId": d["data"]["stateId"],
            "assignedGroupName": d["data"].get("assignedGroupName"),
            "solution": d["data"].get("solution"),
            "submitDate": d["data"].get("submitDate"),
        }
        async for d in get_db().incidents.find(similar_q).sort("data.submitDate", -1).limit(10)
    ]
    groups = sorted(x for x in await get_db().incidents.distinct("data.assignedGroupName") if x)
    return {
        "incident": presenter.detail(doc, datetime.now(UTC)),
        "history": history,
        "similar": similar,
        "knownAssignedGroups": groups,
    }


@router.put("/internal/incidents/{incident_id}/ai", dependencies=[ServiceAuth])
async def save_ai(incident_id: str, body: AiResult) -> dict[str, Any]:
    now = datetime.now(UTC)
    fields = {f"ai.{k}": v for k, v in body.model_dump(exclude_unset=True).items()}
    fields |= {"ai.updatedAt": now, "ai.stale": False}
    # если ai ещё null, вложенные поля через $set в null не создать — сначала делаем пустой объект
    await get_db().incidents.update_one({"_id": incident_id, "ai": None}, {"$set": {"ai": {}}})
    res = await get_db().incidents.update_one({"_id": incident_id}, {"$set": fields})
    if res.matched_count == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Инцидент не найден")
    doc = await get_doc(incident_id)
    card = presenter.card(doc, now)
    await rabbit.publish("incident.ai_updated", {"incidentId": incident_id, "ai": doc["ai"], "card": card})
    return {"ok": True, "ai": doc["ai"]}
