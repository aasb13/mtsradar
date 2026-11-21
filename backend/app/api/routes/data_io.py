"""Импорт/экспорт файла и приём изменений из внешней системы."""

import asyncio
import json
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Body, File, HTTPException, Query, UploadFile, status
from fastapi.responses import Response

from app.api.deps import AdminUser, CoordinatorUser, ServiceAuth
from app.core.config import get_settings
from app.db.mongo import get_db
from app.services.exporter import export_records, export_to_file, maybe_write_back
from app.services.importer import ImportFormatError, extract_records, import_file, import_records
from app.services.presenter import public
from app.services.store import actor_of

router = APIRouter(tags=["import/export"])

MAX_UPLOAD_BYTES = 20 * 1024 * 1024


@router.post("/import")
async def upload_import(
    user: CoordinatorUser,
    file: UploadFile = File(..., description="JSON в формате выгрузки"),
    mode: Literal["snapshot", "upsert"] = "snapshot",
    dryRun: bool = Query(False, description="только посчитать, что изменится"),
    writeToDataFile: bool = Query(
        True, description="для snapshot: сохранить файл как текущий файл с данными (чтобы вотчер и БД не расходились)"
    ),
) -> dict[str, Any]:
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Файл больше 20 МБ")
    try:
        records = extract_records(json.loads(raw.decode("utf-8-sig")))
    except (json.JSONDecodeError, UnicodeDecodeError, ImportFormatError) as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"Некорректный JSON: {e}") from e
    report = await import_records(records, mode=mode, source="api", actor=actor_of(user), dry_run=dryRun)
    if mode == "snapshot" and writeToDataFile and not dryRun:
        # вотчер увидит новый файл, но изменений в нём относительно БД уже не будет
        await asyncio.to_thread(get_settings().data_file.write_bytes, raw)
    return public(report)


@router.post("/import/reload")
async def reload_data_file(_: AdminUser) -> dict[str, Any]:
    """Принудительно перечитать файл с данными."""
    report = await import_file(get_settings().data_file.resolve(), force=True)
    if report is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Файл не найден или содержит некорректный JSON")
    return public(report)


@router.get("/import/runs")
async def import_runs(_: CoordinatorUser, limit: int = Query(20, ge=1, le=200)) -> list[dict[str, Any]]:
    cursor = get_db().import_runs.find({}, {"changedIds": 0}).sort("startedAt", -1).limit(limit)
    return [public(r) async for r in cursor]


@router.get("/import/runs/{run_id}")
async def import_run(run_id: str, _: CoordinatorUser) -> dict[str, Any]:
    run = await get_db().import_runs.find_one({"_id": run_id})
    if not run:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Отчёт не найден")
    return public(run)


@router.get("/export")
async def export(_: CoordinatorUser, includeArchived: bool = False) -> Response:
    records = await export_records(include_archived=includeArchived)
    name = f"incidents_{datetime.now(UTC):%Y%m%d_%H%M%S}.json"
    return Response(
        json.dumps(records, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@router.post("/export/to-data-file")
async def export_into_data_file(_: AdminUser) -> dict[str, Any]:
    """Записать текущее состояние БД (вместе с правками из UI) обратно в файл с данными."""
    count = await export_to_file(get_settings().data_file.resolve())
    return {"written": count}


@router.post("/ingest/incidents", dependencies=[ServiceAuth])
async def ingest(
    payload: Any = Body(..., description="один инцидент, массив или {incidents: [...]}"),
) -> dict[str, Any]:
    """Точка для внешней ITSM: присылает новые/изменённые инциденты (upsert, без архивации остальных)."""
    try:
        records = extract_records(payload)
    except ImportFormatError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(e)) from e
    report = await import_records(records, mode="upsert", source="ingest")
    await maybe_write_back()
    return {k: report[k] for k in ("created", "updated", "unchanged", "errors", "warnings")}
