"""Фоновый процесс: uv run python -m app.worker

  * следит за файлом с данными и импортирует изменения;
  * слушает RabbitMQ и создаёт уведомления;
  * контролирует сроки (SLA).

Запускается ОДИН экземпляр (вотчер файла не должен работать дважды; импорт и так под
Redis-блокировкой и идемпотентен, так что второй экземпляр не сломает данные).
"""

import asyncio
import logging
import signal
from typing import Any

from app.bus import rabbit
from app.core.config import get_settings
from app.core.logging import setup_logging
from app.db.mongo import close_client, ensure_indexes
from app.db.redis import close_redis, seen_before
from app.services import sla_monitor
from app.services.importer import import_file
from app.services.notify import deliver, rules_for
from app.services.watcher import watch_data_file

log = logging.getLogger("worker")

QUEUE = "worker.notifications"
BINDINGS = ["incident.created", "incident.updated", "incident.sla", "incident.members_changed"]


async def on_incident_event(routing_key: str, envelope: dict[str, Any]) -> None:
    if await seen_before(QUEUE, envelope["eventId"]):  # RabbitMQ гарантирует at-least-once
        return
    payload = envelope.get("payload", {})
    for n in rules_for(envelope["type"], payload):
        count = await deliver(n, payload.get("card"))
        log.info("notification", extra={"extra_data": {"kind": n["kind"], "incident": n["incidentId"], "users": count}})


async def main() -> None:
    s = get_settings()
    setup_logging(s.log_level)
    await ensure_indexes()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows
            pass

    await rabbit.consume(QUEUE, BINDINGS, on_incident_event)
    if s.watch_data_file:
        # стартовая загрузка («точка начала») — ДО контроля сроков, иначе он стартует на пустой базе.
        # Повторный запуск идемпотентен: неизменившиеся инциденты не трогаются.
        primary = s.data_file.resolve()
        await import_file(primary, force=True)
        for extra in sorted(primary.parent.glob("*.json")):
            if extra != primary:
                await import_file(extra, force=True, mode="upsert")
    tasks = [asyncio.create_task(sla_monitor.run(stop), name="sla")]
    if s.watch_data_file:
        tasks.append(asyncio.create_task(watch_data_file(stop), name="watcher"))

    def _on_done(t: asyncio.Task) -> None:  # упавшая задача не должна умирать молча
        if not t.cancelled() and t.exception():
            log.error("task crashed", exc_info=t.exception(), extra={"extra_data": {"task": t.get_name()}})
            stop.set()

    for t in tasks:
        t.add_done_callback(_on_done)
    log.info("worker started", extra={"extra_data": {"data_file": str(s.data_file), "watch": s.watch_data_file}})
    try:
        await stop.wait()
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await rabbit.close()
        await close_redis()
        await close_client()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
