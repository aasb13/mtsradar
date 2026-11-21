import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import pytest

from app.services.notify import rules_for
from app.services.telegram import InitDataError, format_notification, verify_init_data

TOKEN = "123456:TEST-token"


def make_init_data(token: str = TOKEN, auth_date: int | None = None, user: dict | None = None) -> str:
    fields = {
        "query_id": "AAH",
        "user": json.dumps(user or {"id": 42, "first_name": "Анна", "username": "anna"}, ensure_ascii=False),
        "auth_date": str(auth_date or int(time.time())),
    }
    dcs = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def test_valid_init_data():
    assert verify_init_data(make_init_data(), TOKEN, 3600)["id"] == 42


@pytest.mark.parametrize(
    "init_data",
    [
        make_init_data(token="999:other"),  # подписан чужим ботом
        make_init_data(auth_date=int(time.time()) - 7200),  # устарел
        make_init_data().replace("42", "43"),  # подменили id
        "",
    ],
)
def test_invalid_init_data(init_data):
    with pytest.raises(InitDataError):
        verify_init_data(init_data, TOKEN, 3600)


def test_new_incident_gives_single_notification():
    card = {"productName": "Вечная зажигалка", "header": "Проблема"}
    kinds = [
        n["kind"]
        for n in rules_for("incident.created", {"incidentId": "INC1", "card": card, "groupsEntered": ["high"]})
    ]
    assert kinds == ["incident.new"]
    kinds = [
        n["kind"]
        for n in rules_for(
            "incident.created", {"incidentId": "INC1", "card": card, "groupsEntered": ["critical", "coordinators"]}
        )
    ]
    assert kinds == ["critical.new", "coordinators.assigned"]
    assert rules_for("incident.created", {"incidentId": "INC1", "card": card, "silent": True}) == []


def test_format_escapes_html_and_hides_local_links():
    n = {"severity": "critical", "title": "Критический INC1", "body": "Продукт <script>"}
    card = {
        "priority": "Наивысший",
        "state": "Назначен",
        "itsmUrl": "http://localhost:8000/itsm/incident/INC1",
        "deadline": "2026-11-20T12:00:00Z",
        "sla": {"timeLeftSeconds": 5400},
    }
    text, markup = format_notification(n, card)
    assert "&lt;script&gt;" in text and "15:00 МСК" in text and "осталось 1 ч 30 мин" in text
    assert markup is None  # localhost-ссылки Telegram не примет
    text, markup = format_notification(n, {**card, "itsmUrl": "https://abc.trycloudflare.com/itsm/incident/INC1"})
    assert markup["inline_keyboard"][0][0]["url"].startswith("https://")
