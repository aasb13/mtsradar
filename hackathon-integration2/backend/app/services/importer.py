"""Импорт выгрузки инцидентов (файл / загрузка через API / пуш из внешней ITSM).

Режимы:
  snapshot — файл это «выписка на текущий момент»: всё, чего в нём больше нет, архивируется
             (если IMPORT_MISSING_POLICY=archive). Используется для файла и загрузки файла.
  upsert   — пришли только изменённые инциденты, остальные не трогаем. Для пуша из ITSM.

Импорт устойчив к ошибкам: битая запись пропускается и попадает в отчёт, остальные применяются.
Битый JSON (файл сохранили на полпути) — импорт не выполняется, публикуется import.failed.
"""

import asyncio
import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import ValidationError

from app.bus import rabbit
from app.core.config import get_settings
from app.db.mongo import get_db
from app.db.redis import get_redis
from app.domain.normalize import ItsmIncident, reconcile_codes, sanitize, to_storage
from app.services.store import ConflictError, archive_incident, get_doc, save_incident

log = logging.getLogger(__name__)

Mode = Literal["snapshot", "upsert"]


class ImportFormatError(ValueError):
    pass


def extract_records(payload: Any) -> list[Any]:
    """Принимаем [..], {"incidents": [..]} или один объект."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        if isinstance(payload.get("incidents"), list):
            return payload["incidents"]
        if "id" in payload:
            return [payload]
    raise ImportFormatError("ожидается JSON-массив инцидентов")


def _short_error(e: ValidationError) -> str:
    return "; ".join(f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors()[:5])


def looks_like_incident_dump(payload: Any) -> bool:
    """Выгрузка инцидентов, а не соседний справочник (incidents_attributes.json) или другой json."""
    try:
        records = extract_records(payload)
    except ImportFormatError:
        return False
    return bool(records) and all(
        isinstance(r, dict) and isinstance(r.get("id"), str) and "stateId" in r for r in records
    )


async def import_records(
    records: list[Any],
    *,
    mode: Mode,
    source: Literal["file", "api", "ingest"],
    actor: dict[str, Any] | None = None,
    dry_run: bool = False,
    file_hash: str | None = None,
    silent: bool = False,
) -> dict[str, Any]:
    """silent=True — первичная загрузка в пустую базу: события публикуются (экран обновится),
    но уведомления по ним не создаются — это не «новые» инциденты, а точка начала."""
    s = get_settings()
    started = datetime.now(UTC)
    report: dict[str, Any] = {
        "_id": uuid.uuid4().hex,
        "source": source,
        "mode": mode,
        "dryRun": dry_run,
        "actor": actor,
        "fileHash": file_hash,
        "startedAt": started,
        "total": len(records),
        "created": 0,
        "updated": 0,
        "restored": 0,
        "unchanged": 0,
        "archived": 0,
        "errors": [],
        "warnings": [],
        "changedIds": [],
    }

    # Импорты строго по одному: файл-вотчер и ручная загрузка могут совпасть по времени
    async with get_redis().lock("lock:import", timeout=120, blocking_timeout=60):
        seen_ids: set[str] = set()
        mentioned_ids: set[str] = set()  # включая битые записи — их не архивируем из-за опечатки
        parsed: dict[str, dict[str, Any]] = {}

        for idx, raw in enumerate(records):
            if isinstance(raw, dict) and isinstance(raw.get("id"), str):
                mentioned_ids.add(raw["id"].strip())
            try:
                model = ItsmIncident.model_validate(raw)
            except ValidationError as e:
                rid = raw.get("id") if isinstance(raw, dict) else None
                report["errors"].append({"index": idx, "id": rid, "error": _short_error(e)})
                continue
            if model.id in seen_ids:
                report["warnings"].append({"id": model.id, "msg": "дубликат id в файле — взята последняя запись"})
            seen_ids.add(model.id)
            parsed[model.id] = to_storage(model)

        existing = {d["_id"]: d async for d in get_db().incidents.find({"_id": {"$in": list(parsed)}})}
        for inc_id, data in parsed.items():
            prev = existing.get(inc_id)
            for w in reconcile_codes(data, prev["data"] if prev else None) + sanitize(data):
                report["warnings"].append({"id": inc_id, "msg": w})
            for attempt in (1, 2):
                try:
                    res = await save_incident(
                        data, source=source, actor=actor, prev_doc=prev, dry_run=dry_run, silent=silent
                    )
                    break
                except ConflictError:
                    if attempt == 2:
                        raise
                    prev = await get_doc(inc_id)  # кто-то успел изменить — перечитываем
            report[res.status] += 1
            if res.status != "unchanged":
                report["changedIds"].append(inc_id)

        if mode == "snapshot" and s.import_missing_policy == "archive":
            if not parsed:
                report["warnings"].append(
                    {"id": None, "msg": "в снимке нет ни одной валидной записи — архивация пропущена"}
                )
            else:
                query = {"meta.deletedAt": None, "_id": {"$nin": list(mentioned_ids)}}
                async for doc in get_db().incidents.find(query):
                    if not dry_run:
                        try:
                            await archive_incident(doc, source=source, actor=actor)
                        except ConflictError:
                            continue
                    report["archived"] += 1
                    report["changedIds"].append(doc["_id"])

    report["finishedAt"] = datetime.now(UTC)
    report["durationMs"] = int((report["finishedAt"] - started).total_seconds() * 1000)
    if not dry_run:
        await get_db().import_runs.insert_one(report)
        await rabbit.publish("import.completed", _summary(report))
    log.info("import done", extra={"extra_data": _summary(report)})
    return report


def _summary(report: dict[str, Any]) -> dict[str, Any]:
    keys = ("source", "mode", "total", "created", "updated", "restored", "unchanged", "archived", "durationMs")
    return {
        "runId": report["_id"],
        **{k: report.get(k) for k in keys},
        "errors": len(report["errors"]),
        "warnings": len(report["warnings"]),
    }


async def import_file(path: Path, *, force: bool = False, mode: Mode = "snapshot") -> dict[str, Any] | None:
    """Импорт файла с данными. Возвращает отчёт или None, если файл не менялся/битый/не выгрузка.

    mode: snapshot — пропавшие из файла записи архивируются (основной файл выгрузки);
          upsert — применяются только записи из файла, остальное не трогается (прочие json рядом).
    """
    try:
        raw_bytes = await asyncio.to_thread(path.read_bytes)  # не блокируем event loop
    except FileNotFoundError:
        log.warning("data file not found", extra={"extra_data": {"path": str(path)}})
        return None
    file_hash = hashlib.sha256(raw_bytes).hexdigest()
    r = get_redis()
    if not force and await r.get(f"import:last_hash:{path.name}") == file_hash:
        return None
    try:
        payload = json.loads(raw_bytes.decode("utf-8-sig"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        # типично для живой правки: файл сохранён не до конца или с опечаткой
        await rabbit.publish("import.failed", {"source": "file", "path": path.name, "error": str(e)})
        log.warning("data file is invalid", extra={"extra_data": {"error": str(e)}})
        return None
    if not looks_like_incident_dump(payload):
        log.info("not an incident dump, skipped", extra={"extra_data": {"file": path.name}})
        return None
    silent = await get_db().incidents.estimated_document_count() == 0
    report = await import_records(
        records=extract_records(payload), mode=mode, source="file", file_hash=file_hash, silent=silent
    )
    await r.set(f"import:last_hash:{path.name}", file_hash)
    return report
