"""Слежение за файлом с данными: «в файл вносятся изменения — дашборд реагирует».

Следим за ПАПКОЙ, а не за самим файлом: многие редакторы (VS Code, PyCharm, vim) сохраняют
через «записать временный файл и переименовать», и слежка за конкретным inode теряется.
"""

import asyncio
import logging
from pathlib import Path

from watchfiles import awatch

from app.core.config import get_settings
from app.services.importer import import_file

log = logging.getLogger(__name__)


async def watch_data_file(stop: asyncio.Event) -> None:
    s = get_settings()
    path = s.data_file.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    log.info("watching data file", extra={"extra_data": {"path": str(path), "polling": s.watch_force_polling}})

    async for _changes in awatch(
        path.parent,
        watch_filter=lambda _change, p: Path(p).name == path.name,
        stop_event=stop,
        force_polling=s.watch_force_polling,
        debounce=700,
        step=100,
    ):
        try:
            report = await import_file(path)
            if report:
                log.info("file change imported", extra={"extra_data": {"changed": report["changedIds"]}})
        except Exception:
            log.exception("import after file change failed")
