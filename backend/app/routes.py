"""HTTP и WebSocket API дашборда инцидентов."""

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from pydantic import BaseModel, ConfigDict

from app.incidents import STAGES, RecordView, Sla, ai_recommend_team, ai_risk, ai_summary
from app.incidents import Snapshot
from app.service import StateTransitionError, Store

router = APIRouter(prefix="/api")


class IncidentOut(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    stateId: int
    groups: list[str]
    sla: Sla


class IncidentsResponse(BaseModel):
    generatedAt: str
    incidents: list[IncidentOut]


class ProductCount(BaseModel):
    name: str
    count: int


class StatusCount(BaseModel):
    stateId: int
    state: str
    count: int


class Kpi(BaseModel):
    open: int
    critical: int
    breached: int
    research: int
    coordinators: int
    resolvedToday: int


class Shift(BaseModel):
    openedToday: int
    resolvedToday: int
    avgResolutionMinutes: int | None
    topProduct: str | None
    byProduct: list[ProductCount]
    byStatus: list[StatusCount]


class SummaryResponse(BaseModel):
    generatedAt: str
    kpi: Kpi
    shift: Shift


class AiSummaryResponse(BaseModel):
    text: str


class AiRiskResponse(BaseModel):
    score: int
    reason: str


class AiRecommendTeamResponse(BaseModel):
    team: str
    reason: str


class StageUpdateRequest(BaseModel):
    stageId: int


def get_store(request: Request) -> Store:
    store: Store | None = getattr(request.app.state, "store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="Хранилище инцидентов ещё не инициализировано")
    return store


StoreDep = Annotated[Store, Depends(get_store)]


def require_snapshot(store: Store) -> Snapshot:
    snapshot = store.snapshot
    if snapshot is None:
        raise HTTPException(status_code=503, detail="Снимок инцидентов ещё не сформирован")
    return snapshot


def require_view(store: Store, incident_id: str) -> RecordView:
    snapshot = require_snapshot(store)
    view = snapshot.views.get(incident_id)
    if view is None:
        raise HTTPException(status_code=404, detail=f"Инцидент {incident_id} не найден")
    return view


@router.get("/incidents", response_model=IncidentsResponse)
async def list_incidents(store: StoreDep) -> IncidentsResponse:
    snapshot = require_snapshot(store)
    return IncidentsResponse(
        generatedAt=snapshot.generated_at.isoformat(),
        incidents=[IncidentOut(**incident) for incident in snapshot.incidents],
    )


@router.get("/incidents/{incident_id}", response_model=IncidentOut)
async def get_incident(incident_id: str, store: StoreDep) -> IncidentOut:
    snapshot = require_snapshot(store)
    incident = next((item for item in snapshot.incidents if item["id"] == incident_id), None)
    if incident is None:
        raise HTTPException(status_code=404, detail=f"Инцидент {incident_id} не найден")
    return IncidentOut(**incident)


@router.get("/summary", response_model=SummaryResponse)
async def get_summary(store: StoreDep) -> SummaryResponse:
    snapshot = require_snapshot(store)
    return SummaryResponse(**snapshot.summary)


@router.get("/ai/incidents/{incident_id}/summary", response_model=AiSummaryResponse)
async def get_ai_summary(incident_id: str, store: StoreDep) -> AiSummaryResponse:
    return AiSummaryResponse(text=ai_summary(require_view(store, incident_id)))


@router.get("/ai/incidents/{incident_id}/risk", response_model=AiRiskResponse)
async def get_ai_risk(incident_id: str, store: StoreDep) -> AiRiskResponse:
    view = require_view(store, incident_id)
    score, reason = ai_risk(view, datetime.now(timezone.utc))
    return AiRiskResponse(score=score, reason=reason)


@router.get("/ai/incidents/{incident_id}/recommend-team", response_model=AiRecommendTeamResponse)
async def get_ai_recommend_team(incident_id: str, store: StoreDep) -> AiRecommendTeamResponse:
    view = require_view(store, incident_id)
    team, reason = ai_recommend_team(view, require_snapshot(store).views)
    return AiRecommendTeamResponse(team=team, reason=reason)


@router.post("/incidents/{incident_id}/stage", response_model=IncidentOut)
async def update_incident_stage(incident_id: str, body: StageUpdateRequest, store: StoreDep) -> IncidentOut:
    if body.stageId not in STAGES:
        allowed = ", ".join(str(s) for s in sorted(STAGES))
        raise HTTPException(status_code=400, detail=f"Колонка {body.stageId} не поддерживается. Допустимые значения: {allowed}.")
    try:
        payload = await store.apply_stage(incident_id, body.stageId)
    except StateTransitionError as exc:
        raise HTTPException(status_code=409, detail=exc.detail) from exc
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if payload is None:
        raise HTTPException(status_code=404, detail=f"Инцидент {incident_id} не найден")
    return IncidentOut(**payload)


@router.websocket("/ws")
async def incidents_ws(websocket: WebSocket) -> None:
    store: Store | None = getattr(websocket.app.state, "store", None)
    if store is None:
        await websocket.close(code=1013)
        return
    await websocket.accept()
    await store.register_client(websocket)
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
    finally:
        await store.unregister_client(websocket)
