"""Application settings, loaded from backend/.env."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    database_url: str = "postgresql+asyncpg://mts:mts@localhost:5432/mts"
    redis_url: str = "redis://localhost:6379/0"
    cors_origins: str = "http://localhost:5173"
    data_file: Path = BACKEND_DIR.parent / "data" / "character_problems.json"
    watch_interval_seconds: float = 1.0

    @property
    def allowed_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
