"""Экспорт текущего состояния в исходном формате выгрузки (можно сразу импортировать обратно)."""

import asyncio
import csv
import io
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from app.db.mongo import get_db
from app.domain.normalize import format_dt


def _plain(value: Any) -> Any:
    if isinstance(value, datetime):
        return format_dt(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value


async def export_records(include_archived: bool = False) -> list[dict[str, Any]]:
    query: dict[str, Any] = {} if include_archived else {"meta.deletedAt": None}
    cursor = get_db().incidents.find(query, {"data": 1}).sort([("data.stateId", 1), ("data.submitDate", 1)])
    return [_plain(doc["data"]) async for doc in cursor]


def _csv_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def records_to_csv(records: list[dict[str, Any]]) -> str:
    """Разделитель ';' и CRLF — чтобы файл открывался в Excel двойным кликом; кодировка (BOM) на ответе."""
    columns: list[str] = []
    seen: set[str] = set()
    for record in records:
        for key in record:
            if key not in seen:
                seen.add(key)
                columns.append(key)
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    writer.writerow(columns)
    for record in records:
        writer.writerow([_csv_value(record.get(column)) for column in columns])
    return buf.getvalue()


async def export_to_file(path: Path) -> int:
    """Атомарная запись (через временный файл), чтобы вотчер не прочитал полфайла."""
    records = await export_records()
    text = json.dumps(records, ensure_ascii=False, indent=2)

    def _write() -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)

    await asyncio.to_thread(_write)
    return len(records)


async def maybe_write_back() -> None:
    """Вызывается после правок через API/ingest, если WRITE_BACK_TO_FILE=true."""
    from app.core.config import get_settings

    s = get_settings()
    if s.write_back_to_file:
        await export_to_file(s.data_file.resolve())
