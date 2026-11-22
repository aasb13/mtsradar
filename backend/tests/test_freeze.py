"""Серверная заморозка SLA: карточка «стоит» на паузе, unfreeze сдвигает дедлайн,
sla_monitor не берёт замороженные в работу. Без реальной БД — get_db и rabbit подменяются."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.core.config import Settings
from app.domain.classify import sla_info
from app.domain.normalize import ItsmIncident, reconcile_codes, to_storage
from app.services import incident_actions, presenter, sla_monitor

S = Settings(_env_file=None)
DATA = json.loads(
    (Path(__file__).parent.parent.parent / "data" / "character_problems.json").read_text(encoding="utf-8")
)


def make_doc() -> dict[str, Any]:
    raw = next(r for r in DATA if r["id"] == "INC000021931151")  # Назначен, deadline 22.11
    data = to_storage(ItsmIncident.model_validate(raw))
    reconcile_codes(data, None)
    return {
        "_id": data["id"],
        "data": data,
        "meta": {"groups": ["coordinators"], "isActive": True, "isResolved": False, "isCritical": False, "version": 1},
        "ack": None,
        "members": [],
    }


def freeze_meta(started_at: datetime, ends_at: datetime | None = None) -> dict[str, Any]:
    return {"startedAt": started_at, "endsAt": ends_at, "reason": "Ждём ответа подрядчика", "actor": None}


def ait(docs: list[dict[str, Any]]):
    async def gen():
        for d in docs:
            yield d

    return gen()


class FakeCollection:
    def __init__(self, docs: list[dict[str, Any]] | None = None) -> None:
        self.docs = docs or []
        self.queries: list[dict] = []
        self.updates: list[tuple] = []
        self.inserted: list[dict] = []

    def find(self, query: dict) -> Any:
        self.queries.append(query)
        return ait(self.docs)

    async def update_one(self, filt: dict, update: dict) -> Any:
        self.updates.append((filt, update))
        return SimpleNamespace(matched_count=1, modified_count=1)

    async def insert_one(self, doc: dict) -> None:
        self.inserted.append(doc)


class FakeDB:
    def __init__(self, docs: list[dict[str, Any]] | None = None) -> None:
        self.incidents = FakeCollection(docs)
        self.incident_events = FakeCollection()
        self.comments = FakeCollection()
        self.published: list[tuple[str, dict]] = []


@pytest.fixture
def fake_db(monkeypatch: pytest.MonkeyPatch) -> FakeDB:
    db = FakeDB()
    monkeypatch.setattr(incident_actions, "get_db", lambda: db)
    monkeypatch.setattr(sla_monitor, "get_db", lambda: db)

    async def fake_publish(event_type: str, payload: dict, routing_key: str | None = None) -> None:
        db.published.append((event_type, payload))

    async def fake_set(*args: Any, **kwargs: Any) -> bool:
        return True

    monkeypatch.setattr(incident_actions, "rabbit", SimpleNamespace(publish=fake_publish))
    monkeypatch.setattr(sla_monitor, "get_redis", lambda: SimpleNamespace(set=fake_set))
    return db


# ---------------- presenter.card: SLA «стоит» ----------------


def test_frozen_card_sla_is_frozen_at_started_at():
    doc = make_doc()
    now = datetime(2026, 11, 20, 12, tzinfo=UTC)
    started_at = now - timedelta(hours=2)
    doc["meta"]["freeze"] = freeze_meta(started_at)
    card = presenter.card(doc, now, S)
    assert card["freeze"]["startedAt"] == started_at
    assert card["sla"] == sla_info(doc["data"], started_at, S)
    assert card["sla"]["timeLeftSeconds"] == int((doc["data"]["deadline"] - started_at).total_seconds())


def test_card_without_freeze_has_null_and_uses_now():
    doc = make_doc()
    now = datetime(2026, 11, 20, 12, tzinfo=UTC)
    card = presenter.card(doc, now, S)
    assert card["freeze"] is None
    assert card["sla"] == sla_info(doc["data"], now, S)


# ---------------- импорт не затирает заморозку ----------------


def test_import_rebuild_keeps_freeze():
    from app.services.store import _build_meta

    doc = make_doc()
    doc["meta"]["freeze"] = freeze_meta(datetime(2026, 11, 20, 10, tzinfo=UTC))
    data = dict(doc["data"], priorityId=3)  # пришла правка из файла
    meta, _, _ = _build_meta(data, doc, "file", datetime(2026, 11, 20, 12, tzinfo=UTC))
    assert meta["freeze"] == doc["meta"]["freeze"]
    fresh, _, _ = _build_meta(data, None, "file", datetime(2026, 11, 20, 12, tzinfo=UTC))
    assert fresh["freeze"] is None


# ---------------- unfreeze: сдвиг дедлайна ----------------


def test_unfreeze_deadline_shifts_by_pause_length():
    deadline = datetime(2026, 11, 22, 12, 2, 29, 472000, tzinfo=UTC)
    started_at = datetime(2026, 11, 20, 10, tzinfo=UTC)
    now = datetime(2026, 11, 20, 12, 30, 15, 500000, tzinfo=UTC)
    assert incident_actions.unfreeze_deadline(deadline, started_at, now) == datetime(
        2026, 11, 22, 14, 32, 44, 972000, tzinfo=UTC
    )
    assert incident_actions.unfreeze_deadline(None, started_at, now) is None


async def test_unfreeze_updates_deadline_and_unsets_freeze(fake_db: FakeDB):
    doc = make_doc()
    old_deadline = doc["data"]["deadline"]
    started_at = datetime.now(UTC) - timedelta(hours=1)
    doc["meta"]["freeze"] = freeze_meta(started_at)
    await incident_actions.unfreeze(doc, user={"_id": "u1", "fullName": "Мария"})

    (filt, update), *_ = fake_db.incidents.updates
    assert filt == {"_id": doc["_id"], "meta.freeze.startedAt": {"$exists": True}}
    assert update["$unset"] == {"meta.freeze": ""}  # целиком, не null — иначе $exists сломается

    event = fake_db.incident_events.inserted[0]
    assert event["type"] == "unfrozen" and event["kinds"] == ["unfrozen"]
    change = event["changes"][0]
    assert change["field"] == "deadline" and change["old"] == old_deadline
    assert update["$set"]["data.deadline"] == change["new"]
    # пауза длилась примерно час — дедлайн сдвинулся на неё
    assert change["new"] - old_deadline == pytest.approx(timedelta(hours=1), abs=timedelta(seconds=5))

    event_type, payload = fake_db.published[0]
    assert event_type == "incident.unfrozen" and payload["auto"] is False
    # после сдвига осталось ровно столько же, сколько было при заморозке
    assert payload["card"]["sla"]["timeLeftSeconds"] == pytest.approx(
        (old_deadline - started_at).total_seconds(), abs=1
    )
    assert payload["card"]["freeze"] is None


async def test_unfreeze_due_runs_with_auto_flag(fake_db: FakeDB):
    doc = make_doc()
    doc["meta"]["freeze"] = freeze_meta(
        datetime.now(UTC) - timedelta(hours=2), ends_at=datetime.now(UTC) - timedelta(minutes=1)
    )
    fake_db.incidents.docs = [doc]
    assert await incident_actions.unfreeze_due() == 1

    query = fake_db.incidents.queries[0]
    assert query["meta.deletedAt"] is None
    assert "$lte" in query["meta.freeze.endsAt"] and "$ne" in query["meta.freeze.endsAt"]

    event = fake_db.incident_events.inserted[0]
    assert event["auto"] is True and event["source"] == "system"
    assert fake_db.published[0][1]["auto"] is True


# ---------------- границы: двойная заморозка, финальный статус, архив, нет срока ----------------


async def test_freeze_writes_meta_and_publishes(fake_db: FakeDB):
    doc = make_doc()
    await incident_actions.freeze(
        doc, reason="Ждём ответа подрядчика", comment="тикет #88412", user={"_id": "u1", "fullName": "Мария"}
    )
    (filt, update), *_ = fake_db.incidents.updates
    assert filt["meta.freeze.startedAt"] == {"$exists": False}
    assert update["$set"]["meta.freeze"]["reason"] == "Ждём ответа подрядчика"
    event = fake_db.incident_events.inserted[0]
    assert event["type"] == "frozen" and event["kinds"] == ["frozen"] and event["reason"] == "Ждём ответа подрядчика"
    assert fake_db.comments.inserted[0]["text"] == "тикет #88412"  # комментарий уходит как обычный
    event_type, payload = fake_db.published[0]
    assert event_type == "incident.frozen" and payload["auto"] is False
    assert payload["card"]["freeze"]["reason"] == "Ждём ответа подрядчика"


async def test_double_freeze_and_unfreeze_without_freeze_conflict():
    doc = make_doc()
    doc["meta"]["freeze"] = freeze_meta(datetime.now(UTC))
    with pytest.raises(incident_actions.ConflictError):
        await incident_actions.freeze(doc, reason="снова")
    with pytest.raises(incident_actions.ConflictError):
        await incident_actions.unfreeze(make_doc())


async def test_freeze_rejects_final_state_and_archive():
    doc = make_doc()
    doc["data"]["stateId"] = 10
    with pytest.raises(incident_actions.ClosedError):
        await incident_actions.freeze(doc, reason="x")
    archived = make_doc()
    archived["meta"]["deletedAt"] = datetime.now(UTC)
    with pytest.raises(incident_actions.ConflictError):
        await incident_actions.freeze(archived, reason="x")


async def test_freeze_rejects_without_deadline():
    doc = make_doc()
    doc["data"]["deadline"] = None
    with pytest.raises(incident_actions.NoDeadlineError):
        await incident_actions.freeze(doc, reason="x")


# ---------------- sla_monitor: замороженные не берутся в работу ----------------


async def test_sla_monitor_query_excludes_frozen(fake_db: FakeDB):
    assert await sla_monitor.check_once() == 0
    assert fake_db.incidents.queries[0]["meta.freeze.startedAt"] == {"$exists": False}
    assert await sla_monitor.check_once(prime=True) == 0
