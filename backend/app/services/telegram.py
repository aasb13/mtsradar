"""Telegram: проверка входа из мини-аппа, привязка аккаунта, отправка уведомлений.

Как устроена привязка:
  1. Пользователь жмёт в боте кнопку «Войти» -> Telegram открывает мини-апп (наша страница /tg/app).
  2. Telegram передаёт странице initData — строку с данными пользователя Telegram, подписанную
     токеном бота. Подделать её без токена нельзя.
  3. Страница отправляет на POST /api/tg/link: initData + логин и пароль с сайта.
  4. Бэкенд проверяет подпись initData и пароль, затем сохраняет у пользователя telegramChatId
     и включает канал telegram. Для личного чата chat_id совпадает с id пользователя Telegram.
"""

import hashlib
import hmac
import json
import logging
import time
from datetime import UTC, datetime
from html import escape
from typing import Any
from urllib.parse import parse_qsl
from zoneinfo import ZoneInfo

import httpx

from app.core.config import get_settings
from app.db.mongo import get_db

log = logging.getLogger(__name__)

SEVERITY_EMOJI = {"critical": "🔴", "high": "🟠", "info": "🔵", "success": "✅"}


class InitDataError(ValueError):
    pass


def verify_init_data(init_data: str, bot_token: str, max_age_sec: int, now: float | None = None) -> dict[str, Any]:
    """Проверка по документации Telegram (Validating data received via the Mini App).

    secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
    hash       = HMAC_SHA256(key=secret_key, msg=data_check_string)
    data_check_string — все поля, кроме hash, в виде key=value, отсортированные по ключу, через \\n.
    Возвращает словарь user ({id, first_name, username, ...}).
    """
    if not init_data:
        raise InitDataError("пустой initData — страница открыта не из Telegram")
    fields = dict(parse_qsl(init_data, keep_blank_values=True, strict_parsing=False))
    received_hash = fields.pop("hash", None)
    if not received_hash:
        raise InitDataError("в initData нет подписи")
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, received_hash):
        raise InitDataError("подпись initData неверна")
    auth_date = int(fields.get("auth_date", "0"))
    if (now or time.time()) - auth_date > max_age_sec:
        raise InitDataError("initData устарел — откройте мини-апп заново")
    try:
        user = json.loads(fields["user"])
    except (KeyError, json.JSONDecodeError) as e:
        raise InitDataError("в initData нет пользователя") from e
    if not isinstance(user, dict) or "id" not in user:
        raise InitDataError("в initData нет id пользователя")
    return user


# ---------------- привязка ----------------


async def link(user_id: str, tg_user: dict[str, Any]) -> None:
    chat_id = str(tg_user["id"])
    users = get_db().users
    # один Telegram-аккаунт — один пользователь сайта
    await users.update_many(
        {"telegramChatId": chat_id, "_id": {"$ne": user_id}},
        {"$set": {"telegramChatId": None, "notificationSettings.telegram": False}},
    )
    await users.update_one(
        {"_id": user_id},
        {
            "$set": {
                "telegramChatId": chat_id,
                "telegramUsername": tg_user.get("username"),
                "telegramLinkedAt": datetime.now(UTC),
                "notificationSettings.telegram": True,
            }
        },
    )


async def unlink_chat(chat_id: str) -> int:
    res = await get_db().users.update_many(
        {"telegramChatId": str(chat_id)},
        {"$set": {"telegramChatId": None, "notificationSettings.telegram": False}},
    )
    return res.modified_count


async def user_by_chat(chat_id: str) -> dict[str, Any] | None:
    return await get_db().users.find_one({"telegramChatId": str(chat_id), "deletedAt": None})


# ---------------- отправка ----------------


def _is_public_url(url: str | None) -> bool:
    # Telegram не принимает в кнопках localhost и внутренние адреса
    return bool(url) and url.startswith("https://") and "localhost" not in url and "127.0.0.1" not in url


def _fmt_left(seconds: int | None) -> str:
    if seconds is None:
        return ""
    sign, seconds = ("просрочен на " if seconds < 0 else "осталось "), abs(seconds)
    d, rem = divmod(seconds // 60, 24 * 60)
    h, m = divmod(rem, 60)
    parts = [f"{d} д" if d else "", f"{h} ч" if h else "", f"{m} мин" if not d else ""]
    return sign + " ".join(p for p in parts if p)


def format_notification(n: dict[str, Any], card: dict[str, Any] | None) -> tuple[str, dict | None]:
    """Текст (HTML-разметка Telegram) и инлайн-кнопки."""
    s = get_settings()
    lines = [f"{SEVERITY_EMOJI.get(n['severity'], '')} <b>{escape(n['title'])}</b>"]
    if n.get("body"):
        lines.append(escape(n["body"]))
    if card:
        meta = [
            card.get("priority") and f"Приоритет: {card['priority']}",
            card.get("state") and f"Статус: {card['state']}",
        ]
        lines.append(escape(" · ".join(x for x in meta if x)))
        if card.get("assignedGroupName"):
            lines.append(escape(f"Команда: {card['assignedGroupName']}"))
        deadline = card.get("deadline")
        if deadline:
            dt = (
                deadline
                if isinstance(deadline, datetime)
                else datetime.fromisoformat(str(deadline).replace("Z", "+00:00"))
            )
            local = dt.astimezone(ZoneInfo(s.business_tz)).strftime("%d.%m %H:%M")
            left = _fmt_left((card.get("sla") or {}).get("timeLeftSeconds"))
            lines.append(escape(f"Срок: {local} МСК" + (f" ({left})" if left else "")))
    buttons = []
    itsm = (card or {}).get("itsmUrl") or n.get("itsmUrl")
    if _is_public_url(itsm):
        buttons.append({"text": "Открыть в ITSM", "url": itsm})
    if _is_public_url(s.dashboard_url):
        buttons.append({"text": "Дашборд", "url": s.dashboard_url})
    markup = {"inline_keyboard": [buttons]} if buttons else None
    return "\n".join(lines), markup


async def send_message(chat_id: str, text: str, reply_markup: dict | None = None) -> bool:
    """True — доставлено. Если бот заблокирован или чат не найден, отвязываем Telegram у пользователя."""
    token = get_settings().telegram_bot_token
    if not token:
        return False
    body: dict[str, Any] = {"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
    if reply_markup:
        body["reply_markup"] = reply_markup
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{get_settings().telegram_api_base}/bot{token}/sendMessage", json=body)
    except httpx.HTTPError:
        log.warning("telegram unreachable")
        return False
    if r.status_code == 200:
        return True
    if r.status_code in (400, 403) and ("blocked" in r.text or "chat not found" in r.text):
        await unlink_chat(chat_id)
        log.info("telegram chat unlinked (bot blocked)", extra={"extra_data": {"chat": chat_id}})
    else:
        log.warning("telegram send failed", extra={"extra_data": {"status": r.status_code, "body": r.text[:200]}})
    return False


async def send_notification(chat_id: str, n: dict[str, Any], card: dict[str, Any] | None) -> bool:
    text, markup = format_notification(n, card)
    return await send_message(chat_id, text, markup)
