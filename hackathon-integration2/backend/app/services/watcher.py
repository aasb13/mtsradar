"""Слежение за json-файлами с данными: «в файл вносятся изменения — дашборд реагирует».

Следим за ПАПКОЙ, а не за самим файлом: многие редакторы (VS Code, PyCharm, vim) сохраняют
через «записать временный файл и переименовать», и слежка за конкретным inode теряется.

Основной файл выгрузки (data_file) импортируется как снимок — пропавшие записи архивируются.
Остальные json в папке (например, character_problems.json) — как upsert: их правки применяются,
но чужие записи из них не исчезают. Не-выгрузки (словарь атрибутов) отсекаются в импортере.
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
    primary = s.data_file.resolve()
    primary.parent.mkdir(parents=True, exist_ok=True)
    data_dir = primary.parent

    log.info(
        "watching data dir",
        extra={"extra_data": {"dir": str(data_dir), "primary": primary.name, "polling": s.watch_force_polling}},
    )

    async for changes in awatch(
        data_dir,
        watch_filter=lambda _change, p: (file := Path(p)).parent == data_dir and file.suffix.lower() == ".json",
        stop_event=stop,
        force_polling=s.watch_force_polling,
        debounce=700,
        step=100,
    ):
        # основной файл первым: правки прочих файлов, попавшие в тот же батч, применяются после
        touched = sorted({Path(p) for _change, p in changes}, key=lambda p: (p != primary, p.name))
        for path in touched:
            try:
                report = await import_file(path, mode="snapshot" if path == primary else "upsert")
                if report:
                    log.info(
                        "file change imported",
                        extra={"extra_data": {"file": path.name, "changed": report["changedIds"]}},
                    )
            except Exception:
                log.exception("import after file change failed")
