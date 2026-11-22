"""Процесс API: REST + WebSocket.

Запуск: uv run uvicorn app.main:app --reload
Фоновая работа (слежка за файлом, уведомления, контроль сроков) — в отдельном процессе:
        uv run python -m app.worker
"""

import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import (
    ai,
    ai_chat,
    auth,
    data_io,
    incidents,
    itsm_mock,
    meta,
    my,
    notifications,
    registration,
    tg,
    users,
    ws,
)
from app.bus import rabbit
from app.core.config import get_settings
from app.core.logging import request_id_var, setup_logging
from app.db.mongo import close_client, ensure_indexes, get_db
from app.db.redis import close_redis, get_redis
from app.services.users import ensure_bootstrap_admin
from app.ws.manager import manager, start_gateway

log = logging.getLogger("app")


@asynccontextmanager
async def lifespan(_: FastAPI):
    s = get_settings()
    setup_logging(s.log_level)
    await ensure_indexes()
    await ensure_bootstrap_admin(s.bootstrap_admin_email, s.bootstrap_admin_password)
    await start_gateway()
    log.info("api started", extra={"extra_data": {"env": s.env}})
    yield
    await rabbit.close()
    await close_redis()
    await close_client()


settings = get_settings()
app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
    openapi_url="/openapi.json",
    description="Дашборд координатора массовых инцидентов. WebSocket: /api/ws?token=…",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
    token = request_id_var.set(rid)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    finally:
        request_id_var.reset(token)
    response.headers["x-request-id"] = rid
    log.info(
        "request",
        extra={
            "extra_data": {
                "request_id": rid,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "ms": round((time.perf_counter() - started) * 1000, 1),
            }
        },
    )
    return response


API = "/api"
for r in (
    auth.router,
    registration.router,
    users.router,
    incidents.router,
    meta.router,
    data_io.router,
    notifications.router,
    ai.router,
    ai_chat.router,
    ws.router,
    tg.api_router,
    my.router,
):
    app.include_router(r, prefix=API)
app.include_router(tg.page_router)  # мини-апп Telegram: /tg/app
if settings.itsm_mock_enabled:
    app.include_router(itsm_mock.router)  # HTML-муляж ITSM: /itsm/...


@app.get(f"{API}/health", tags=["meta"])
async def health() -> dict[str, Any]:
    out: dict[str, Any] = {"wsClients": manager.count}
    for name, check in (
        ("mongo", lambda: get_db().command("ping")),
        ("redis", lambda: get_redis().ping()),
        ("rabbit", rabbit.connect),
    ):
        try:
            await check()
            out[name] = "ok"
        except Exception as e:  # noqa: BLE001
            out[name] = f"error: {e.__class__.__name__}"
    out["status"] = "ok" if all(out[k] == "ok" for k in ("mongo", "redis", "rabbit")) else "degraded"
    return out
