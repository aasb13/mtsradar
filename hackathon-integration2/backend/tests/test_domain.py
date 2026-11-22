import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.domain.classify import display_groups, sla_info, structural_groups
from app.domain.diff import change_kinds, diff
from app.domain.normalize import ItsmIncident, format_dt, reconcile_codes, sanitize, to_storage

S = Settings(_env_file=None)
# базовая выгрузка организаторов; демо-файл data/incidents.json — её развитие
DATA = json.loads(
    (Path(__file__).parent.parent.parent / "data" / "character_problems.json").read_text(encoding="utf-8")
)


def load(raw: dict) -> dict:
    data = to_storage(ItsmIncident.model_validate(raw))
    reconcile_codes(data, None)
    sanitize(data)
    return data


def by_id(inc_id: str) -> dict:
    return next(x for x in DATA if x["id"] == inc_id)


def test_whole_file_parses():
    assert len([load(r) for r in DATA]) == len(DATA)


def test_dates_normalized_to_ms_and_sentinel_is_null():
    d = load(by_id("INC000021930418"))  # deadline "2026-11-10T12:40:02.472263Z"
    assert d["deadline"] == datetime(2026, 11, 10, 12, 40, 2, 472000, tzinfo=UTC)
    assert d["waitingExitDate"] is None  # "0001-01-01T00:00:00"
    assert format_dt(d["deadline"]) == "2026-11-10T12:40:02.472Z"


def test_solution_cleared_for_open_states():
    d = load(by_id("INC000021931151"))  # Назначен + solution
    assert d["solution"] is None
    resolved = load(by_id("INC000021929735"))  # Завершен
    assert resolved["solution"]


def test_groups_on_baseline_file():
    groups = {g: [] for g in ("critical", "coordinators", "high", "research")}
    for raw in DATA:
        d = load(raw)
        for g in structural_groups(d, S):
            groups[g].append(d["id"])
    assert groups["critical"] == []  # в выгрузке нет ни одного priorityId=4
    assert sorted(groups["coordinators"]) == ["INC000021931151", "INC000021938960"]
    assert groups["high"] == ["INC000021938167"]
    assert len(groups["research"]) == 5


def test_incident_can_be_in_several_groups():
    raw = dict(by_id("INC000021931151"), priorityId=4)
    assert structural_groups(load(raw), S) == ["critical", "coordinators"]


def test_resolved_critical_visible_for_a_while():
    d = load(dict(by_id("INC000021931151"), priorityId=4, stateId=7, state="Завершен"))
    now = datetime(2026, 11, 20, 12, tzinfo=UTC)
    assert structural_groups(d, S) == []
    assert display_groups(d, {"resolvedAt": now - timedelta(minutes=5)}, now, S) == ["critical"]
    assert display_groups(d, {"resolvedAt": now - timedelta(hours=5)}, now, S) == []


def test_reconcile_text_only_edit_wins():
    prev = load(by_id("INC000021931151"))
    edited = dict(prev, state="Завершен")  # человек поменял только текст
    warnings = reconcile_codes(edited, prev)
    assert edited["stateId"] == 7 and warnings
    edited2 = dict(prev, stateId=2)  # поменял только id -> текст подтягивается
    reconcile_codes(edited2, prev)
    assert edited2["state"] == "Выполняется"


def test_priority_text_alias():
    prev = load(by_id("INC000021931151"))
    edited = dict(prev, priority="Критический")
    reconcile_codes(edited, prev)
    assert edited["priorityId"] == 4 and edited["priority"] == "Наивысший"


def test_sla_states():
    d = load(by_id("INC000021931151"))  # submit 08.11 12:02, deadline 22.11 12:02 (14 дней)
    assert sla_info(d, datetime(2026, 11, 10, tzinfo=UTC), S)["state"] == "ok"
    assert sla_info(d, datetime(2026, 11, 19, 12, tzinfo=UTC), S)["state"] == "warning"
    assert sla_info(d, datetime(2026, 11, 22, 0, tzinfo=UTC), S)["state"] == "danger"
    assert sla_info(d, datetime(2026, 11, 23, tzinfo=UTC), S)["state"] == "breached"
    no_deadline = load(by_id("INC000021932868"))
    assert sla_info(no_deadline, datetime(2026, 11, 20, tzinfo=UTC), S)["state"] == "none"


def test_diff_and_kinds():
    old = load(by_id("INC000021931151"))
    new = dict(old, stateId=7, state="Завершен", assignedGroupName="ОГЭ Приморье")
    changes = diff(old, new)
    assert {c["field"] for c in changes} == {"stateId", "state", "assignedGroupName"}
    assert change_kinds(old, new, changes) == ["state_changed", "resolved", "reassigned"]
    assert diff(old, load(by_id("INC000021931151"))) == []  # повторный импорт ничего не меняет


@pytest.mark.parametrize("bad", [{"id": "X"}, {"id": "INC1", "stateId": "abc", "priorityId": 1, "submitDate": "x"}])
def test_invalid_records_raise(bad):
    with pytest.raises(ValidationError):
        ItsmIncident.model_validate(bad)


def test_itsm_mock_updates():
    from app.services.itsm_mock import build_updates

    rec = dict(by_id("INC000021931151"))  # Назначен, priority 1
    upd = build_updates(rec, {"stateId": 7, "priorityId": 4, "assignedGroupName": rec["assignedGroupName"]})
    assert upd["state"] == "Завершен" and upd["stateEnum"] == "Resolved" and upd["completionDate"]
    assert upd["priority"] == "Наивысший" and "assignedGroupName" not in upd
    same = build_updates(rec, {"stateId": 0, "priorityId": 1, "solution": rec["solution"]})
    assert same == {}
    reopened = build_updates(dict(rec, stateId=7, completionDate="2026-11-09T00:00:00Z"), {"stateId": 2})
    assert reopened["completionDate"] is None
