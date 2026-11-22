"""Муляж ITSM-системы (организаторы разрешили муляж перехода).

Правка в муляже меняет не базу, а ФАЙЛ ВЫГРУЗКИ — так же, как реальная ITSM меняла бы
свою выгрузку. Дальше обычный путь: импорт файла -> diff -> история -> события -> дашборд.
Поэтому на защите видно цепочку «ITSM -> выгрузка -> дашборд», а файл и база не расходятся.
"""

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

from app.core.config import get_settings
from app.db.redis import get_redis
from app.domain.enums import CLOSED, IN_PROGRESS, PRIORITIES, RESOLVED, STATES
from app.domain.normalize import format_dt
from app.services.exporter import _plain
from app.services.importer import import_file
from app.services.store import get_doc


class MockItsmError(Exception):
    pass


def build_updates(current: dict[str, Any], form: dict[str, Any]) -> dict[str, Any]:
    """Из полей формы -> изменения записи в формате файла (даты строками, тексты по id)."""
    now = format_dt(datetime.now(UTC).replace(microsecond=0))
    upd: dict[str, Any] = {}

    state_id = form.get("stateId")
    if state_id is not None and state_id != current.get("stateId"):
        upd["stateId"] = state_id
        upd["state"], upd["stateEnum"] = STATES[state_id]
        if state_id in (RESOLVED, CLOSED) and not current.get("completionDate"):
            upd["completionDate"] = now
        if state_id == IN_PROGRESS and current.get("stateId") == RESOLVED:  # вернули в работу
            upd["completionDate"] = None

    priority_id = form.get("priorityId")
    if priority_id is not None and priority_id != current.get("priorityId"):
        upd["priorityId"], upd["priority"] = priority_id, PRIORITIES[priority_id]

    group = (form.get("assignedGroupName") or "").strip()
    if group and group != current.get("assignedGroupName"):
        upd["assignedGroupName"] = group
        upd["lastAssignmentToTeamDateTime"] = now

    for key in ("assignedEmployee", "stateReason", "solution"):
        if key in form:
            value = (form[key] or "").strip() or None
            if value != current.get(key):
                upd[key] = value

    if form.get("deadline") is not None:
        deadline = format_dt(form["deadline"])
        if deadline != current.get("deadline"):
            upd["deadline"] = deadline
    return upd


async def edit_incident(incident_id: str, form: dict[str, Any]) -> list[str]:
    """Вносит правку в файл выгрузки и сразу импортирует его. Возвращает список изменённых полей."""
    path = get_settings().data_file.resolve()
    async with get_redis().lock("lock:datafile", timeout=30, blocking_timeout=10):
        try:
            text = await asyncio.to_thread(path.read_text, encoding="utf-8-sig")
            records = json.loads(text)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            raise MockItsmError(f"файл выгрузки сейчас недоступен или некорректен: {e}") from e
        if not isinstance(records, list):
            raise MockItsmError("файл выгрузки должен быть JSON-массивом")

        record = next((r for r in records if isinstance(r, dict) and r.get("id") == incident_id), None)
        if record is None:  # пришёл не из файла (например, через ingest) — добавим в выгрузку
            doc = await get_doc(incident_id)
            if not doc:
                raise MockItsmError("инцидент не найден")
            record = _plain(doc["data"])
            records.append(record)

        updates = build_updates(record, form)
        if not updates:
            return []
        record.update(updates)

        def _write() -> None:
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(path)

        await asyncio.to_thread(_write)
    # не ждём вотчер: импортируем сразу (вотчер потом увидит тот же хэш и пропустит)
    await import_file(path)
    return list(updates)
