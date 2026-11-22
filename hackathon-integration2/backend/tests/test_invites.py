"""Одноразовые приглашения на ветку: HTTP-сценарии на подменных Redis и Mongo, без сервисов.

Фейками подменяются глобальные клиенты app.db.redis._redis и app.db.mongo._client —
роуты вызывают get_redis()/get_db() на каждый запрос, поэтому патч по месту действия.
"""

import fnmatch
import json
from collections.abc import AsyncIterator
from datetime import timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from pymongo.errors import DuplicateKeyError

from app.core.config import get_settings
from app.core.security import create_token
from app.main import app

ADMIN = {"_id": "u-admin", "email": "admin@mts.ru", "role": "admin", "fullName": "Администратор", "deletedAt": None}
VIEWER = {"_id": "u-viewer", "email": "viewer@mts.ru", "role": "viewer", "fullName": "Тестировщик", "deletedAt": None}


class FakeRedis:
    """Минимальный асинхронный Redis: приглашения, лимитеры, TTL без настоящих часов."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    async def get(self, key: str) -> str | None:
        return self.data.get(key)

    async def set(self, key: str, value: str, ex: timedelta | int | None = None) -> None:
        self.data[key] = value
        if ex is not None:
            self.ttls[key] = int(ex.total_seconds()) if isinstance(ex, timedelta) else int(ex)

    async def getdel(self, key: str) -> str | None:
        return self.data.pop(key, None)

    async def delete(self, *keys: str) -> int:
        deleted = 0
        for key in keys:
            if self.data.pop(key, None) is not None:
                deleted += 1
        return deleted

    async def incr(self, key: str) -> int:
        value = int(self.data.get(key, "0")) + 1
        self.data[key] = str(value)
        return value

    async def expire(self, key: str, seconds: int) -> None:
        if key in self.data:
            self.ttls[key] = seconds

    async def ttl(self, key: str) -> int:
        if key not in self.data:
            return -2
        return self.ttls.get(key, -1)

    async def scan_iter(self, match: str = "*") -> AsyncIterator[str]:
        for key in list(self.data):
            if fnmatch.fnmatchcase(key, match):
                yield key


class FakeUsers:
    """Коллекция users: find_one/insert_one с уникальным индексом по email."""

    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    @staticmethod
    def _matches(doc: dict[str, Any], query: dict[str, Any]) -> bool:
        for field, expected in query.items():
            actual = doc.get(field)
            if isinstance(expected, dict):
                if actual not in expected.get("$in", []):
                    return False
            elif expected is None:
                if actual is not None:
                    return False
            elif actual != expected:
                return False
        return True

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        return next((doc for doc in self.docs if self._matches(doc, query)), None)

    async def insert_one(self, doc: dict[str, Any]) -> None:
        if any(d["email"] == doc["email"] for d in self.docs):
            raise DuplicateKeyError("E11000 duplicate key collection: users index: email dup key")
        self.docs.append(dict(doc))


class FakeClient:
    """AsyncMongoClient в объёме get_db(): client[имя_базы].users."""

    def __init__(self, users: FakeUsers) -> None:
        self._users = users

    def __getitem__(self, _name: str) -> SimpleNamespace:
        return SimpleNamespace(users=self._users)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    redis, users = FakeRedis(), FakeUsers()
    users.docs.extend([dict(ADMIN), dict(VIEWER)])
    monkeypatch.setattr("app.db.redis._redis", redis)
    monkeypatch.setattr("app.db.mongo._client", FakeClient(users))
    return SimpleNamespace(redis=redis, users=users)


@pytest.fixture
async def client() -> AsyncClient:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def bearer(user_id: str, role: str) -> dict[str, str]:
    token, _, _ = create_token(user_id, role, "access")
    return {"Authorization": f"Bearer {token}"}


def reg_body(token: str, email: str) -> dict[str, str]:
    return {"token": token, "fullName": "Иванов А. С.", "email": email, "password": "пароль-12345"}


async def create_invite(client: AsyncClient, role: str, itsm_login: str | None = None) -> dict[str, Any]:
    res = await client.post(
        "/api/invites", json={"role": role, "itsmLogin": itsm_login}, headers=bearer("u-admin", "admin")
    )
    assert res.status_code == 201
    return res.json()


async def test_create_invite_requires_admin(client: AsyncClient, env: SimpleNamespace) -> None:
    res = await client.post("/api/invites", json={"role": "coordinator"})
    assert res.status_code == 401
    res = await client.post("/api/invites", json={"role": "coordinator"}, headers=bearer("u-viewer", "viewer"))
    assert res.status_code == 403
    res = await client.get("/api/invites", headers=bearer("u-viewer", "viewer"))
    assert res.status_code == 403
    assert not any(key.startswith("invite:") for key in env.redis.data)


async def test_invite_roles_are_limited(client: AsyncClient, env: SimpleNamespace) -> None:
    res = await client.post("/api/invites", json={"role": "admin"}, headers=bearer("u-admin", "admin"))
    assert res.status_code == 422
    res = await client.post("/api/invites", json={"role": "developer"}, headers=bearer("u-admin", "admin"))
    assert res.status_code == 422
    assert not any(key.startswith("invite:") for key in env.redis.data)


async def test_created_invite_lives_in_redis_with_ttl(client: AsyncClient, env: SimpleNamespace) -> None:
    invite = await create_invite(client, "coordinator")
    assert invite["role"] == "coordinator" and invite["itsmLogin"] is None
    raw = env.redis.data[f"invite:{invite['token']}"]
    stored = json.loads(raw)
    assert stored["role"] == "coordinator" and stored["createdBy"] == "u-admin"
    assert env.redis.ttls[f"invite:{invite['token']}"] == get_settings().invite_ttl_hours * 3600
    assert "T" in invite["expiresAt"]


async def test_register_by_invite_creates_active_user_and_session(client: AsyncClient, env: SimpleNamespace) -> None:
    invite = await create_invite(client, "coordinator")
    res = await client.post(
        "/api/registration/invite",
        json={
            "token": invite["token"],
            "fullName": "Иванов Алексей Сергеевич",
            "email": "a.ivanov@mts.ru",
            "password": "пароль-12345",
        },
    )
    assert res.status_code == 200
    pair = res.json()
    assert pair["user"]["role"] == "coordinator" and pair["user"]["itsmLogin"] is None
    user = next(doc for doc in env.users.docs if doc["email"] == "a.ivanov@mts.ru")
    assert user["deletedAt"] is None and user["role"] == "coordinator"
    # сессия настоящая: access-токен проходит авторизацию
    me = await client.get("/api/me", headers={"Authorization": f"Bearer {pair['accessToken']}"})
    assert me.status_code == 200 and me.json()["email"] == "a.ivanov@mts.ru"
    # токен сгорел
    assert f"invite:{invite['token']}" not in env.redis.data


async def test_register_by_invite_developer_takes_itsm_login(client: AsyncClient, env: SimpleNamespace) -> None:
    invite = await create_invite(client, "developer", "a.ivanov")
    res = await client.post(
        "/api/registration/invite",
        json={"token": invite["token"], "fullName": "Иванов А. С.", "email": "dev@mts.ru", "password": "пароль-12345"},
    )
    assert res.status_code == 200
    assert res.json()["user"]["itsmLogin"] == "a.ivanov"


async def test_register_by_invite_token_is_single_use(client: AsyncClient, env: SimpleNamespace) -> None:
    invite = await create_invite(client, "viewer")
    body = {"token": invite["token"], "fullName": "Тест Тестов", "email": "qa@mts.ru", "password": "пароль-12345"}
    assert (await client.post("/api/registration/invite", json=body)).status_code == 200
    other = {**body, "email": "qa2@mts.ru"}
    res = await client.post("/api/registration/invite", json=other)
    assert res.status_code == 410 and "уже использована" in res.json()["detail"]
    assert len(env.users.docs) == 3  # второй аккаунт не создался


async def test_revoked_invite_is_dead(client: AsyncClient, env: SimpleNamespace) -> None:
    invite = await create_invite(client, "coordinator")
    res = await client.delete(f"/api/invites/{invite['token']}", headers=bearer("u-admin", "admin"))
    assert res.status_code == 204
    # регистрация по отозванной ссылке не проходит
    res = await client.post("/api/registration/invite", json=reg_body(invite["token"], "a.ivanov@mts.ru"))
    assert res.status_code == 410
    # отзывать нечего
    res = await client.delete(f"/api/invites/{invite['token']}", headers=bearer("u-admin", "admin"))
    assert res.status_code == 404
    res = await client.delete(f"/api/invites/{invite['token']}", headers=bearer("u-admin", "admin"))
    assert res.status_code == 404


async def test_duplicate_email_keeps_token_alive(client: AsyncClient, env: SimpleNamespace) -> None:
    env.users.docs.append({"_id": "u-busy", "email": "busy@mts.ru", "role": "viewer", "deletedAt": None})
    invite = await create_invite(client, "coordinator")
    body = {"token": invite["token"], "fullName": "Иванов А. С.", "email": "busy@mts.ru", "password": "пароль-12345"}
    res = await client.post("/api/registration/invite", json=body)
    assert res.status_code == 409 and "такой почтой" in res.json()["detail"]
    # ошибка формы не сожгла ссылку — второй заход с той же ссылкой работает
    assert f"invite:{invite['token']}" in env.redis.data
    res = await client.post("/api/registration/invite", json={**body, "email": "free@mts.ru"})
    assert res.status_code == 200 and res.json()["user"]["role"] == "coordinator"


async def test_list_invites_shows_active_only(client: AsyncClient, env: SimpleNamespace) -> None:
    first = await create_invite(client, "coordinator")
    second = await create_invite(client, "developer", "a.ivanov")
    res = await client.get("/api/invites", headers=bearer("u-admin", "admin"))
    assert res.status_code == 200
    items = {item["token"]: item for item in res.json()}
    assert set(items) == {first["token"], second["token"]}
    assert items[second["token"]]["itsmLogin"] == "a.ivanov"
    assert "T" in items[first["token"]]["expiresAt"]
    await client.delete(f"/api/invites/{first['token']}", headers=bearer("u-admin", "admin"))
    res = await client.get("/api/invites", headers=bearer("u-admin", "admin"))
    assert [item["token"] for item in res.json()] == [second["token"]]


async def test_unknown_invite_link_is_dead(client: AsyncClient, env: SimpleNamespace) -> None:
    res = await client.post("/api/registration/invite", json=reg_body("нет-такого", "a.ivanov@mts.ru"))
    assert res.status_code == 410
