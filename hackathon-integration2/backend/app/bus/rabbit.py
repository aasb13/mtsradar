"""Шина событий на RabbitMQ.

Один topic-exchange `incidents.events`. Конверт сообщения:
    {"eventId": uuid, "type": "incident.updated", "ts": iso, "payload": {...}}
Routing key = type, поэтому каждый потребитель подписывается только на нужное:

  incident.created | incident.updated | incident.removed      — изменения данных
  incident.acknowledged | incident.comment_added | incident.ai_updated
  incident.sla                                                 — срок подходит / нарушен
  import.completed | import.failed                             — отчёты импорта
  ai.requested                                                 — запрос пересчёта ИИ
  notification.user.{userId}                                   — личное уведомление
  user.changed                                                 — состав пользователей (счётчик координаторов)

Потребители:
  * API (WS-шлюз): эксклюзивная временная очередь на каждый процесс API -> рассылка в браузеры
  * worker: durable-очередь `worker.notifications` -> правила уведомлений
  * ИИ-сервис (коллега): своя durable-очередь, например `ai.incidents`
"""

import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import aio_pika
from aio_pika.abc import AbstractExchange, AbstractIncomingMessage, AbstractRobustConnection

from app.core.config import get_settings

log = logging.getLogger(__name__)

_connection: AbstractRobustConnection | None = None
_exchange: AbstractExchange | None = None


def _json_default(o: Any) -> Any:
    if isinstance(o, datetime):
        return o.astimezone(UTC).isoformat().replace("+00:00", "Z")
    raise TypeError(f"not serializable: {type(o)}")


def dumps(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, default=_json_default).encode()


async def connect() -> AbstractExchange:
    global _connection, _exchange
    if _exchange is None:
        s = get_settings()
        # connect_robust сам переподключается и восстанавливает очереди/подписки
        _connection = await aio_pika.connect_robust(s.rabbit_url)
        channel = await _connection.channel()
        await channel.set_qos(prefetch_count=50)
        _exchange = await channel.declare_exchange(s.events_exchange, aio_pika.ExchangeType.TOPIC, durable=True)
    return _exchange


async def close() -> None:
    global _connection, _exchange
    if _connection is not None:
        await _connection.close()
    _connection = _exchange = None


def make_envelope(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "eventId": uuid.uuid4().hex,
        "type": event_type,
        "ts": datetime.now(UTC),
        "payload": payload,
    }


async def publish(event_type: str, payload: dict[str, Any], routing_key: str | None = None) -> dict[str, Any]:
    envelope = make_envelope(event_type, payload)
    try:
        exchange = await connect()
        await exchange.publish(
            aio_pika.Message(
                body=dumps(envelope),
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                message_id=envelope["eventId"],
            ),
            routing_key=routing_key or event_type,
        )
    except Exception:  # шина недоступна — данные уже в Mongo, фронт подтянет их при переподключении
        log.exception("publish failed", extra={"extra_data": {"type": event_type}})
    return envelope


Handler = Callable[[str, dict[str, Any]], Awaitable[None]]


async def consume(queue_name: str | None, bindings: list[str], handler: Handler) -> None:
    """queue_name=None -> эксклюзивная временная очередь (для WS-шлюза каждого процесса API)."""
    exchange = await connect()
    channel = exchange.channel
    if queue_name:
        queue = await channel.declare_queue(queue_name, durable=True)
    else:
        queue = await channel.declare_queue(exclusive=True, auto_delete=True)
    for key in bindings:
        await queue.bind(exchange, routing_key=key)

    async def on_message(message: AbstractIncomingMessage) -> None:
        # requeue=False: «ядовитое» сообщение не крутится бесконечно
        async with message.process(requeue=False, ignore_processed=True):
            try:
                envelope = json.loads(message.body)
                await handler(message.routing_key or envelope.get("type", ""), envelope)
            except Exception:
                log.exception("handler failed", extra={"extra_data": {"queue": queue_name, "rk": message.routing_key}})

    await queue.consume(on_message)
