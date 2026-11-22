"""Управление пользователями: HTTP-сценарии на подменной Mongo (по образцу test_invites.py).

Админ не может сменить роль самому себе — иначе, понизив себя, он блокирует доступ
к управлению ролями до ручной правки базы.
"""

from types import SimpleNamespace
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.security import create_token
from app.main import app

ADMIN = {"_id": "u-admin", "email": "admin@mts.ru", "role": "admin", "fullName": "Администратор", "deletedAt": None}
VIEWER = {"_id": "u-viewer", "email": "viewer@mts.ru", "role": "viewer", "fullName": "Тестировщик", "deletedAt": None}


class FakeUsers:
    """Коллекция users: find_one/update_one по _id и deletedAt."""

    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    @staticmethod
    def _matches(doc: dict[str, Any], query: dict[str, Any]) -> bool:
        return all(doc.get(field) == expected for field, expected in query.items())

    async def find_one(self, query: dict[str, Any]) -> dict[str, Any] | None:
        return next((doc for doc in self.docs if self._matches(doc, query)), None)

    async def count_documents(self, query: dict[str, Any]) -> int:
        return sum(1 for doc in self.docs if self._matches(doc, query))

    async def update_one(self, query: dict[str, Any], update: dict[str, Any]) -> SimpleNamespace:
        doc = next((doc for doc in self.docs if self._matches(doc, query)), None)
        if doc is not None:
            doc.update(update["$set"])
        return SimpleNamespace(matched_count=0 if doc is None else 1)


class FakeClient:
    """AsyncMongoClient в объёме get_db(): client[имя_базы].users."""

    def __init__(self, users: FakeUsers) -> None:
        self._users = users

    def __getitem__(self, _name: str) -> SimpleNamespace:
        return SimpleNamespace(users=self._users)


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    users = FakeUsers()
    users.docs.extend([dict(ADMIN), dict(VIEWER)])
    monkeypatch.setattr("app.db.mongo._client", FakeClient(users))
    return SimpleNamespace(users=users)


@pytest.fixture
async def client() -> AsyncClient:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


def bearer(user_id: str, role: str) -> dict[str, str]:
    token, _, _ = create_token(user_id, role, "access")
    return {"Authorization": f"Bearer {token}"}


async def test_admin_cannot_change_own_role(client: AsyncClient, env: SimpleNamespace) -> None:
    res = await client.patch("/api/users/u-admin", json={"role": "viewer"}, headers=bearer("u-admin", "admin"))
    assert res.status_code == 400 and "роль" in res.json()["detail"]
    assert next(d for d in env.users.docs if d["_id"] == "u-admin")["role"] == "admin"


async def test_admin_can_change_other_user_role(client: AsyncClient, env: SimpleNamespace) -> None:
    res = await client.patch("/api/users/u-viewer", json={"role": "coordinator"}, headers=bearer("u-admin", "admin"))
    assert res.status_code == 200 and res.json()["role"] == "coordinator"
    assert next(d for d in env.users.docs if d["_id"] == "u-viewer")["role"] == "coordinator"


async def test_admin_can_edit_own_profile_without_role(client: AsyncClient, env: SimpleNamespace) -> None:
    res = await client.patch("/api/users/u-admin", json={"fullName": "Админ А. Д."}, headers=bearer("u-admin", "admin"))
    assert res.status_code == 200 and res.json()["fullName"] == "Админ А. Д."
