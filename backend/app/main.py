"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routes import router
from app.service import Store

logger = logging.getLogger(__name__)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    store = Store(settings.data_file, settings.watch_interval_seconds)
    await store.start()
    app.state.store = store
    try:
        yield
    finally:
        await store.stop()


app = FastAPI(title="МТС — дашборд координатора IT-инцидентов", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
