"""Распределение новых инцидентов на координаторов: дежурный держит поток, переполнение
уходит следующему; маршрут закрывается назначением команды. Без реальной БД — get_db
и rabbit подменяются (по образцу test_freeze.py)."""

import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.domain.enums import Role
from app.domain.normalize import ItsmIncident, reconcile_codes, to_storage
from app.services import incident_actions, routing, store

DATA = json.loads(
    (Path(__file__).parent.parent.parent / "data" / "character_problems.json").read_text(encoding="utf-8")
)


def dig(doc: dict[str, Any], path: str) -> Any:
    cur: Any = doc
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def matches(doc: dict[str, Any], query: dict[str, Any]) -> bool:
    for key, expected in query.items():
        value = dig(doc, key)
        if isinstance(expected, dict) and "$in" in expected:
            if value not in expected["$in"]:
                return False
        elif value != expected:
            return False
    return True


class FakeIncidents:
    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []

    def find(self, query: dict[str, Any]) -> Any:
        found = [d for d in self.docs if matches(d, query)]

        async def gen():
            for d in found:
                yield d

        return gen()

    async def find_one(self, query: dict[str, Any], sort: list[tuple[str, int]] | None = None) -> dict[str, Any] | None:
        found = [d for d in self.docs if matches(d, query)]
        if sort:
            for key, direction in reversed(sort):
                found.sort(key=lambda d: dig(d, key) or datetime.min.replace(tzinfo=UTC), reverse=direction < 0)
        return found[0] if found else None

    async def count_documents(self, query: dict[str, Any]) -> int:
        return sum(1 for d in self.docs if matches(d, query))

    async def insert_one(self, doc: dict[str, Any]) -> None:
        self.docs.append(doc)

    async def replace_one(self, filt: dict[str, Any], doc: dict[str, Any]) -> SimpleNamespace:
        for i, d in enumerate(self.docs):
            if matches(d, filt):
                self.docs[i] = doc
                return SimpleNamespace(matched_count=1)
        return SimpleNamespace(matched_count=0)


class FakeUsers:
    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    def find(self, query: dict[str, Any]) -> Any:
        found = [d for d in self.docs if matches(d, query)]

        async def gen():
            for d in found:
                yield d

        return gen()


class FakeDB:
    def __init__(self, users: list[dict[str, Any]]) -> None:
        self.users = FakeUsers(users)
        self.incidents = FakeIncidents()
        self.incident_events = FakeIncidents()
        self.published: list[tuple[str, dict[str, Any]]] = []


def coord(uid: str, name: str, created: datetime) -> dict[str, Any]:
    return {
        "_id": uid,
        "email": f"{uid}@mts.ru",
        "fullName": name,
        "role": Role.COORDINATOR,
        "createdAt": created,
        "deletedAt": None,
    }


def routed_doc(uid: str, at: datetime, *, done_at: datetime | None = None, is_active: bool = True) -> dict[str, Any]:
    return {
        "_id": f"INC-{uid}-{at.timestamp()}",
        "data": {"stateId": 0},
        "meta": {"deletedAt": None, "isActive": is_active},
        "route": {"userId": uid, "at": at, "doneAt": done_at},
    }


@pytest.fixture
def db(monkeypatch: pytest.MonkeyPatch) -> FakeDB:
    fake = FakeDB(
        [
            coord("u-a", "Анна Координатор", datetime(2026, 1, 1, tzinfo=UTC)),
            coord("u-b", "Борис Координатор", datetime(2026, 1, 2, tzinfo=UTC)),
        ]
    )
    monkeypatch.setattr(store, "get_db", lambda: fake)
    monkeypatch.setattr(incident_actions, "get_db", lambda: fake)
    monkeypatch.setattr(routing, "get_db", lambda: fake)

    async def fake_publish(event_type: str, payload: dict[str, Any], routing_key: str | None = None) -> None:
        fake.published.append((event_type, payload))

    monkeypatch.setattr(store, "rabbit", SimpleNamespace(publish=fake_publish))
    monkeypatch.setattr(incident_actions, "rabbit", SimpleNamespace(publish=fake_publish))
    return fake


def incident_data(inc_id: str = "INC000021931151") -> dict[str, Any]:
    raw = next(r for r in DATA if r["id"] == inc_id)
    data = to_storage(ItsmIncident.model_validate(raw))
    reconcile_codes(data, None)
    return data


async def test_new_route_without_coordinators(db: FakeDB) -> None:
    db.users.docs = []
    assert await routing.new_route() is None


async def test_duty_keeps_flow_until_full(db: FakeDB, monkeypatch: pytest.MonkeyPatch) -> None:
    # очередь пусты у обоих: дежурным становится заведённый раньше — Анна
    route = await routing.new_route()
    assert route is not None and route["userId"] == "u-a"
    # у Бориса очереди меньше, но поток остаётся у дежурного Анны
    db.incidents.docs.append(routed_doc("u-a", datetime(2026, 2, 1, tzinfo=UTC)))
    route = await routing.new_route()
    assert route is not None and route["userId"] == "u-a"
    # переполнение капа — поток уходит Борису
    monkeypatch.setattr(routing, "DUTY_CAP", 1)
    route = await routing.new_route()
    assert route is not None and route["userId"] == "u-b"


async def test_route_ignores_dispatched_and_archived(db: FakeDB, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routing, "DUTY_CAP", 1)
    now = datetime.now(UTC)
    # у Анны очередь переполнена только по видимости: одна разобрана, одна в архиве — фактически пуста
    db.incidents.docs.append(routed_doc("u-a", now, done_at=now))
    db.incidents.docs.append(routed_doc("u-a", now))
    db.incidents.docs[-1]["meta"]["deletedAt"] = now
    route = await routing.new_route()
    assert route is not None and route["userId"] == "u-a"


async def test_created_incident_is_routed(db: FakeDB) -> None:
    data = incident_data()
    result = await store.save_incident(data, source="file")
    assert result.status == "created"
    doc = db.incidents.docs[0]
    assert doc["route"] is not None and doc["route"]["userId"] == "u-a"
    event_type, payload = db.published[-1]
    assert event_type == "incident.created" and payload["route"]["userId"] == "u-a"
    assert payload["card"]["routedTo"]["userId"] == "u-a"


async def test_initial_seed_is_not_routed(db: FakeDB) -> None:
    data = incident_data()
    await store.save_incident(data, source="file", silent=True)
    assert db.incidents.docs[0]["route"] is None


async def test_update_keeps_route(db: FakeDB) -> None:
    data = incident_data()
    await store.save_incident(data, source="file")
    prev = db.incidents.docs[0]
    data["priority"] = "Высокий"
    data["priorityId"] = 3
    await store.save_incident(data, source="file", prev_doc=prev)
    assert db.incidents.docs[0]["route"]["userId"] == "u-a"


async def test_patch_completes_route_even_for_same_team(db: FakeDB) -> None:
    data = incident_data()
    await store.save_incident(data, source="file")
    doc = db.incidents.docs[0]
    user = {"_id": "u-a", "fullName": "Анна Координатор"}
    # подтверждение команды, уже стоявшей в данных, тоже закрывает маршрут
    await incident_actions.apply_patch(doc, {"assignedGroupName": data["assignedGroupName"]}, user)
    saved = await store.get_doc(doc["_id"])
    assert saved["route"]["doneAt"] is not None
    event_type, payload = db.published[-1]
    assert event_type == "incident.updated" and payload["card"]["routedTo"]["doneAt"] is not None


async def test_patch_without_team_keeps_route_open(db: FakeDB) -> None:
    data = incident_data()
    await store.save_incident(data, source="file")
    doc = db.incidents.docs[0]
    user = {"_id": "u-a", "fullName": "Анна Координатор"}
    await incident_actions.apply_patch(doc, {"header": "Другое название"}, user)
    saved = await store.get_doc(doc["_id"])
    assert saved["route"]["doneAt"] is None
