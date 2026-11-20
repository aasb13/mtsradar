"""Хранилище инцидентов: снимок в памяти, опрос файла данных, реестр WebSocket-клиентов."""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import WebSocket

from app.incidents import (
    Change,
    FINAL_STAGE,
    Snapshot,
    apply_stage_change,
    build_snapshot,
    diff_snapshots,
    load_records,
    payload_from_view,
    stage_denied_reason,
    stage_of,
    ws_snapshot_message,
    ws_update_message,
)

logger = logging.getLogger(__name__)


class StateTransitionError(Exception):
    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class Store:
    def __init__(self, data_file: Path, watch_interval_seconds: float) -> None:
        self._data_file = data_file
        self._watch_interval_seconds = watch_interval_seconds
        self._snapshot: Snapshot | None = None
        self._stat_key: tuple[int, int] | None = None
        self._clients: set[WebSocket] = set()
        self._send_lock = asyncio.Lock()
        self._mutation_lock = asyncio.Lock()
        self._poll_task: asyncio.Task | None = None

    @property
    def snapshot(self) -> Snapshot | None:
        return self._snapshot

    async def start(self) -> None:
        try:
            stat = self._data_file.stat()
            records = load_records(self._data_file.read_bytes())
        except (OSError, ValueError) as exc:
            raise RuntimeError(f"Не удалось загрузить файл данных инцидентов {self._data_file}: {exc}") from exc
        self._snapshot = build_snapshot(records, datetime.now(timezone.utc))
        self._stat_key = (stat.st_mtime_ns, stat.st_size)
        self._poll_task = asyncio.create_task(self._poll_loop(), name="incident-file-poll")
        logger.info("Загружен снимок инцидентов: %d записей, файл %s", len(records), self._data_file)

    async def stop(self) -> None:
        if self._poll_task is None:
            return
        self._poll_task.cancel()
        try:
            await self._poll_task
        except asyncio.CancelledError:
            pass
        self._poll_task = None

    async def register_client(self, websocket: WebSocket) -> None:
        async with self._send_lock:
            self._clients.add(websocket)
            snapshot = self._snapshot
            if snapshot is not None:
                await websocket.send_json(ws_snapshot_message(snapshot))

    async def unregister_client(self, websocket: WebSocket) -> None:
        self._clients.discard(websocket)

    async def apply_stage(self, incident_id: str, new_stage_id: int) -> dict | None:
        async with self._mutation_lock:
            try:
                records = load_records(self._data_file.read_bytes())
            except (OSError, ValueError) as exc:
                raise ValueError(f"Файл данных недоступен, изменение колонки невозможно: {exc}") from exc
            record = next((item for item in records if item["id"] == incident_id), None)
            if record is None:
                return None
            if stage_of(record) == FINAL_STAGE and new_stage_id != FINAL_STAGE:
                raise StateTransitionError(stage_denied_reason(new_stage_id))
            now = datetime.now(timezone.utc)
            apply_stage_change(record, new_stage_id, now)
            self._write_records(records)
            # Мгновенная рассылка: карточка переезжает у всех клиентов сразу,
            # не дожидаясь ближайшего опроса файла.
            await self._commit(records, now)
            return payload_from_view(self._snapshot.views[incident_id])

    def _write_records(self, records: list[dict]) -> None:
        text = json.dumps(records, ensure_ascii=False, indent=2) + "\n"
        tmp_path = self._data_file.with_name(self._data_file.name + ".tmp")
        with open(tmp_path, "w", encoding="utf-8") as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp_path, self._data_file)

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(self._watch_interval_seconds)
            await self._reload()

    async def _reload(self) -> None:
        try:
            stat = self._data_file.stat()
        except OSError as exc:
            logger.warning("Файл данных %s недоступен, используется предыдущий снимок: %r", self._data_file, exc)
            return
        if (stat.st_mtime_ns, stat.st_size) == self._stat_key:
            return
        try:
            records = load_records(self._data_file.read_bytes())
        except (OSError, ValueError) as exc:
            logger.error("Файл данных %s повреждён или нечитаем, используется предыдущий снимок: %s", self._data_file, exc)
            return
        async with self._mutation_lock:
            await self._commit(records, datetime.now(timezone.utc))

    async def _commit(self, records: list[dict], now: datetime) -> None:
        # Инвариант: вызывается под _mutation_lock, иначе опрос может
        # откатить снимок на состояние, предшествующее записи переноса.
        previous = self._snapshot
        current = build_snapshot(records, now)
        self._snapshot = current
        try:
            stat = self._data_file.stat()
            self._stat_key = (stat.st_mtime_ns, stat.st_size)
        except OSError as exc:
            logger.warning("Не удалось зафиксировать метаданные файла данных: %r", exc)
        changes = diff_snapshots(previous, current) if previous is not None else []
        if changes:
            logger.info("Файл данных изменён: %d событий", len(changes))
            await self._broadcast_update(current, changes)

    async def _broadcast_update(self, snapshot: Snapshot, changes: list[Change]) -> None:
        message = ws_update_message(snapshot, changes)
        stale: list[WebSocket] = []
        async with self._send_lock:
            for client in tuple(self._clients):
                try:
                    await client.send_json(message)
                except Exception as exc:
                    logger.warning("Не удалось отправить обновление клиенту, соединение будет закрыто: %r", exc)
                    stale.append(client)
            for client in stale:
                self._clients.discard(client)
