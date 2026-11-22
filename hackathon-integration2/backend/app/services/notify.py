"""Правила уведомлений: из события об инциденте -> список уведомлений.

Правила — чистая функция (rules_for), отправка — отдельно. Каналы:
  in-app   всегда: запись в notifications + личное событие notification.user.{id} -> WebSocket
  telegram если пользователь привязал Telegram через мини-апп бота (services/telegram.py)
  email    заглушка (логируем) — подключить SMTP, если останется время
"""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from app.bus import rabbit
from app.db.mongo import get_db
from app.domain.enums import Group
from app.services import push, telegram
from app.services.presenter import public
from app.services.users import admins_for, developers_for, recipients

log = logging.getLogger(__name__)


def _fmt_duration(seconds: float) -> str:
    minutes = int(seconds // 60)
    h, m = divmod(minutes, 60)
    d, h = divmod(h, 24)
    parts = [f"{d} д" if d else "", f"{h} ч" if h else "", f"{m} мин"]
    return " ".join(p for p in parts if p)


def rules_for(event_type: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    card = payload.get("card") or {}
    inc_id = payload.get("incidentId")
    where = f"{card.get('productName') or ''} · {card.get('header') or ''}".strip(" ·")
    entered = set(payload.get("groupsEntered") or [])
    kinds = set(payload.get("kinds") or [])
    out: list[dict[str, Any]] = []
    if payload.get("silent"):
        return out

    def add(kind: str, severity: str, title: str, body: str, audience: dict[str, Any] | None = None) -> None:
        # audience=None — координаторы и админы; {"logins": [...], "userIds": [...]} — разработчики;
        # {"admins": True} — только админы
        out.append(
            {
                "kind": kind,
                "severity": severity,
                "title": title,
                "body": body,
                "incidentId": inc_id,
                "audience": audience,
            }
        )

    # --- разработчикам: «вас добавили в инцидент» ---
    dev_logins: list[str] = []
    if event_type == "incident.created" and card.get("assignedEmployeeLogin"):
        dev_logins = [card["assignedEmployeeLogin"]]
    elif event_type == "incident.updated":
        dev_logins = [
            c["new"] for c in payload.get("changes") or [] if c.get("field") == "assignedEmployeeLogin" and c.get("new")
        ]
    if dev_logins and card.get("isActive", True):
        add("incident.assigned_to_me", "high", f"Вас назначили на инцидент {inc_id}", where, {"logins": dev_logins})
    if event_type == "incident.members_changed" and payload.get("added"):
        add(
            "incident.assigned_to_me", "high", f"Вас добавили в инцидент {inc_id}", where, {"userIds": payload["added"]}
        )

    if event_type == "incident.created":
        # одно сообщение о новом инциденте, а не пачка (новый + высокий + на координаторах)
        if Group.CRITICAL in entered:
            add("critical.new", "critical", f"Критический инцидент {inc_id}", where)
        else:
            sev = "high" if Group.HIGH in entered else "info"
            add("incident.new", sev, f"Новый инцидент {inc_id}", where)
        if Group.COORDINATORS in entered:
            add("coordinators.assigned", "high", f"{inc_id} назначен на координаторов", where)
    elif event_type == "incident.updated":
        if Group.CRITICAL in entered:
            add("critical.new", "critical", f"Критический инцидент {inc_id}", where)
        if "resolved" in kinds and card.get("isCritical"):
            took = ""
            if card.get("submitDate") and card.get("completionDate"):
                sec = (_dt(card["completionDate"]) - _dt(card["submitDate"])).total_seconds()
                took = f" за {_fmt_duration(sec)}"
            add("critical.resolved", "success", f"Критический {inc_id} решён{took}", where)
        if Group.COORDINATORS in entered:
            add("coordinators.assigned", "high", f"{inc_id} назначен на координаторов", where)
        if Group.HIGH in entered and Group.CRITICAL not in entered:
            add("high.new", "high", f"Высокий приоритет: {inc_id}", where)
    elif event_type == "incident.sla":
        state = payload.get("slaState")
        if state == "breached":
            add("sla.breached", "critical", f"Срок по {inc_id} нарушен", where)
        elif state == "danger":
            add("sla.danger", "high", f"Срок по {inc_id} истекает", where)
    return out


def _dt(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


async def deliver(notification: dict[str, Any], card: dict[str, Any] | None) -> int:
    """Создаёт уведомление каждому получателю. Возвращает число получателей."""
    notification = dict(notification)
    audience = notification.pop("audience", None)
    if audience and audience.get("admins"):
        users = await admins_for(notification["kind"])
    elif audience:
        users = await developers_for(
            notification["kind"], logins=audience.get("logins", []), user_ids=audience.get("userIds", [])
        )
    else:
        users = await recipients(notification["kind"])
    now = datetime.now(UTC)
    for u in users:
        doc = {
            "_id": uuid.uuid4().hex,
            "userId": u["_id"],
            **notification,
            "itsmUrl": (card or {}).get("itsmUrl"),
            "createdAt": now,
            "readAt": None,
        }
        await get_db().notifications.insert_one(doc)
        await rabbit.publish("notification.created", public(doc), routing_key=f"notification.user.{u['_id']}")
        settings = u.get("notificationSettings") or {}
        if settings.get("telegram") and u.get("telegramChatId"):
            try:
                await telegram.send_notification(u["telegramChatId"], notification, card)
            except Exception:  # сбой Telegram не должен мешать уведомлениям остальным
                log.exception("telegram notification failed", extra={"extra_data": {"user": u["_id"]}})
        if settings.get("push", True):
            try:
                await push.send_to_user(u["_id"], notification, card)
            except Exception:
                log.exception("push notification failed", extra={"extra_data": {"user": u["_id"]}})
        if settings.get("email"):
            log.info("email stub", extra={"extra_data": {"to": u["email"], "subject": notification["title"]}})
    return len(users)
