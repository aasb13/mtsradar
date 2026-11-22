"""Push-уведомления в мобильное приложение через Firebase Cloud Messaging (HTTP v1 API).

Включается, если задан FCM_SERVICE_ACCOUNT_FILE — JSON-ключ сервисного аккаунта Firebase
(Firebase console -> Project settings -> Service accounts -> Generate new private key).
Без него канал выключен, приложение получает уведомления только по WebSocket, пока открыто.

Токены устройств лежат в коллекции devices ({_id: token, userId, platform}).
Протухшие токены (приложение удалено, переустановлено) FCM возвращает как UNREGISTERED — удаляем.
"""

import asyncio
import json
import logging
from typing import Any

import httpx

from app.core.config import get_settings
from app.db.mongo import get_db

log = logging.getLogger(__name__)

SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
_credentials = None
_project_id: str | None = None


def enabled() -> bool:
    return bool(get_settings().fcm_service_account_file)


def _load() -> None:
    global _credentials, _project_id
    if _credentials is None:
        from google.oauth2 import service_account  # импорт только если push включён

        path = get_settings().fcm_service_account_file
        with open(path, encoding="utf-8") as f:
            _project_id = json.load(f)["project_id"]
        _credentials = service_account.Credentials.from_service_account_file(path, scopes=[SCOPE])


def _fresh_token() -> str:
    from google.auth.transport.requests import Request

    _load()
    if not _credentials.valid:
        _credentials.refresh(Request())  # синхронный вызов — выполняем в потоке
    return _credentials.token


def build_message(token: str, n: dict[str, Any], card: dict[str, Any] | None) -> dict[str, Any]:
    data = {"kind": n["kind"], "severity": n["severity"], "incidentId": n.get("incidentId") or ""}
    if card and card.get("priorityId") is not None:
        data["priorityId"] = str(card["priorityId"])
    return {
        "message": {
            "token": token,
            "notification": {"title": n["title"], "body": n.get("body") or ""},
            "data": data,  # в data все значения — строки (требование FCM)
            "android": {"priority": "high", "notification": {"color": "#DF263D", "tag": data["incidentId"] or None}},
            "apns": {"payload": {"aps": {"sound": "default"}}},
        }
    }


async def send_to_user(user_id: str, n: dict[str, Any], card: dict[str, Any] | None) -> int:
    if not enabled():
        return 0
    tokens = [d["_id"] async for d in get_db().devices.find({"userId": user_id})]
    if not tokens:
        return 0
    try:
        access_token = await asyncio.to_thread(_fresh_token)
    except Exception:
        log.exception("fcm auth failed — проверьте FCM_SERVICE_ACCOUNT_FILE")
        return 0
    url = f"{get_settings().fcm_api_base}/v1/projects/{_project_id}/messages:send"
    sent = 0
    async with httpx.AsyncClient(timeout=10, headers={"Authorization": f"Bearer {access_token}"}) as client:
        for token in tokens:
            try:
                r = await client.post(url, json=build_message(token, n, card))
            except httpx.HTTPError:
                log.warning("fcm unreachable")
                return sent
            if r.status_code == 200:
                sent += 1
            elif r.status_code in (400, 404) and (
                "UNREGISTERED" in r.text or "registration-token-not-registered" in r.text
            ):
                await get_db().devices.delete_one({"_id": token})
            else:
                log.warning("fcm send failed", extra={"extra_data": {"status": r.status_code, "body": r.text[:300]}})
    return sent
