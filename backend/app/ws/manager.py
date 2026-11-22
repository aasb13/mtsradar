"""WebSocket-подключения браузеров и шлюз RabbitMQ -> WebSocket.

Каждый процесс API создаёт в RabbitMQ свою временную эксклюзивную очередь, поэтому при
нескольких экземплярах API каждое событие дойдёт до всех подключённых клиентов.
"""

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

from app.bus import rabbit
from app.services import access

log = logging.getLogger(__name__)

# что пересылаем в браузер
WS_BINDINGS = ["incident.#", "import.#", "notification.user.#", "registration.#", "chat.user.#"]


def personalize(user: dict[str, Any], routing_key: str, envelope: dict[str, Any]) -> dict[str, Any] | None:
    """Что отправить конкретному пользователю: событие как есть, урезанное или ничего (None).

    События чата адресные: chat.user.{userId} получает только владелец сессии.
    Сотрудники (admin/coordinator/viewer) получают всё остальное. Разработчик — только
    события по своим инцидентам; если инцидент перестал быть «его» (переназначили, убрали
    из участников), он получает incident.removed, чтобы приложение убрало карточку из списка.
    """
    if routing_key.startswith("chat.user."):
        return envelope if routing_key == f"chat.user.{user['_id']}" else None
    if not access.is_developer(user):
        return envelope
    if not routing_key.startswith("incident."):
        return None  # import.* и прочее — служебное, разработчику не нужно
    payload = envelope.get("payload") or {}
    if routing_key == "incident.removed":
        return envelope
    if access.card_visible(user, payload.get("card")):
        return envelope
    login = user.get("itsmLogin")
    was_mine = user["_id"] in (payload.get("removed") or []) or any(
        c.get("field") == "assignedEmployeeLogin" and login and c.get("old") == login
        for c in payload.get("changes") or []
    )
    if was_mine:
        return {**envelope, "type": "incident.removed", "payload": {"incidentId": payload.get("incidentId")}}
    return None


class ConnectionManager:
    def __init__(self) -> None:
        self._by_user: dict[str, set[WebSocket]] = defaultdict(set)
        self._users: dict[str, dict[str, Any]] = {}

    @property
    def count(self) -> int:
        return sum(len(v) for v in self._by_user.values())

    def add(self, user: dict[str, Any], ws: WebSocket) -> None:
        self._by_user[user["_id"]].add(ws)
        self._users[user["_id"]] = {k: user.get(k) for k in ("_id", "role", "itsmLogin")}

    def remove(self, user_id: str, ws: WebSocket) -> None:
        self._by_user[user_id].discard(ws)
        if not self._by_user[user_id]:
            self._by_user.pop(user_id, None)
            self._users.pop(user_id, None)

    async def _send(self, user_id: str, ws: WebSocket, text: str) -> None:
        try:
            await asyncio.wait_for(ws.send_text(text), timeout=5)
        except Exception:
            self.remove(user_id, ws)  # «мёртвый» сокет

    async def broadcast(self, routing_key: str, message: dict[str, Any]) -> None:
        tasks = []
        for uid, sockets in list(self._by_user.items()):
            personal = personalize(self._users.get(uid, {"_id": uid}), routing_key, message)
            if personal is None:
                continue
            text = rabbit.dumps(personal).decode()
            tasks.extend(self._send(uid, ws, text) for ws in list(sockets))
        await asyncio.gather(*tasks)

    async def send_to_user(self, user_id: str, message: dict[str, Any]) -> None:
        text = rabbit.dumps(message).decode()
        await asyncio.gather(*(self._send(user_id, ws, text) for ws in list(self._by_user.get(user_id, ()))))


manager = ConnectionManager()


async def _on_event(routing_key: str, envelope: dict[str, Any]) -> None:
    if routing_key.startswith("notification.user."):
        await manager.send_to_user(routing_key.removeprefix("notification.user."), envelope)
    else:
        await manager.broadcast(routing_key, envelope)


async def start_gateway() -> None:
    await rabbit.consume(None, WS_BINDINGS, _on_event)
    log.info("ws gateway subscribed", extra={"extra_data": {"bindings": WS_BINDINGS}})


def parse_client_message(text: str) -> dict[str, Any]:
    try:
        msg = json.loads(text)
        return msg if isinstance(msg, dict) else {}
    except json.JSONDecodeError:
        return {}
