"""WebSocket: /api/ws?token=<access token>

Сервер -> клиент: {"eventId", "type", "ts", "payload"}; type = routing key события
  (incident.created, incident.updated, incident.removed, incident.acknowledged,
   incident.comment_added, incident.ai_updated, incident.sla, import.completed,
   import.failed, notification.created).
Клиент -> сервер: {"type": "ping"} -> {"type": "pong"}.
После (пере)подключения фронт должен заново запросить GET /api/dashboard: события,
пришедшие, пока сокет был отключён, не повторяются.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect, status

from app.api.deps import user_from_token
from app.ws.manager import manager, parse_client_message

router = APIRouter(tags=["websocket"])


@router.websocket("/ws")
async def ws_endpoint(websocket: WebSocket, token: str | None = Query(None)) -> None:
    try:
        user = await user_from_token(token)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await websocket.accept()
    manager.add(user, websocket)
    await websocket.send_json(
        {"type": "hello", "ts": datetime.now(UTC).isoformat(), "payload": {"userId": user["_id"]}}
    )
    try:
        while True:
            msg = parse_client_message(await websocket.receive_text())
            if msg.get("type") == "ping":
                await websocket.send_json({"type": "pong", "ts": datetime.now(UTC).isoformat()})
    except WebSocketDisconnect:
        pass
    finally:
        manager.remove(user["_id"], websocket)
