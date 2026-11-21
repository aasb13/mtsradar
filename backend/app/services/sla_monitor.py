"""Контроль сроков: раз в SLA_CHECK_INTERVAL_SEC проверяет активные инциденты важных групп и
публикует incident.sla, когда срок входит в danger или нарушается. Каждое состояние по
каждому дедлайну — ровно одно оповещение (ключ в Redis). Если дедлайн перенесли, ключ другой —
оповещение придёт заново.

При старте воркера уже просроченные инциденты только «запоминаются» без оповещений,
иначе каждый перезапуск засыпал бы координаторов старыми просрочками.
"""

import asyncio
import logging
from datetime import UTC, datetime

from app.bus import rabbit
from app.core.config import get_settings
from app.db.mongo import get_db
from app.db.redis import get_redis
from app.domain.classify import sla_info
from app.domain.enums import Group
from app.services import presenter

log = logging.getLogger(__name__)

WATCHED_GROUPS = [Group.CRITICAL, Group.HIGH, Group.COORDINATORS]


async def check_once(*, prime: bool = False) -> int:
    s, now, r = get_settings(), datetime.now(UTC), get_redis()
    query = {
        "meta.deletedAt": None,
        "meta.isActive": True,
        "data.deadline": {"$ne": None},
        "meta.groups": {"$in": [g.value for g in WATCHED_GROUPS]},
    }
    sent = 0
    async for doc in get_db().incidents.find(query):
        info = sla_info(doc["data"], now, s)
        if info["state"] not in ("danger", "breached"):
            continue
        key = f"sla:notified:{doc['_id']}:{info['state']}:{int(doc['data']['deadline'].timestamp())}"
        if not await r.set(key, "1", nx=True, ex=14 * 24 * 3600):
            continue
        if prime:
            continue
        await rabbit.publish(
            "incident.sla",
            {
                "incidentId": doc["_id"],
                "slaState": info["state"],
                "timeLeftSeconds": info["timeLeftSeconds"],
                "card": presenter.card(doc, now, s),
            },
        )
        sent += 1
    return sent


async def run(stop: asyncio.Event) -> None:
    await check_once(prime=True)
    interval = get_settings().sla_check_interval_sec
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            pass
        if stop.is_set():
            break
        try:
            if sent := await check_once():
                log.info("sla alerts", extra={"extra_data": {"sent": sent}})
        except Exception:
            log.exception("sla check failed")
