"""Контракт с ИИ-частью (её делает коллега).

Как ИИ-сервис работает с бэкендом:
  1. Подписывается на RabbitMQ (exchange incidents.events, своя очередь, ключи
     incident.created, incident.updated, ai.requested).
  2. За полным контекстом ходит в GET /api/internal/incidents/{id}/context (X-Service-Key).
  3. Результат кладёт в PUT /api/internal/incidents/{id}/ai (X-Service-Key).
     Бэкенд сохраняет его и рассылает incident.ai_updated всем браузерам.
ИИ ничего не меняет в самих данных инцидента — только рекомендации.
"""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.api.deps import CoordinatorUser, ServiceAuth
from app.bus import rabbit
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
