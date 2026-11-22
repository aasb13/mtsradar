"""Все настройки приложения. Читаются из переменных окружения / файла .env.

Имя переменной окружения = имя поля в ВЕРХНЕМ регистре (например, MONGO_URL).
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Incident Dashboard API"
    env: Literal["dev", "prod", "test"] = "dev"
    log_level: str = "INFO"

    # --- инфраструктура ---
    mongo_url: str = "mongodb://localhost:27017"
    mongo_db: str = "incidents"
    redis_url: str = "redis://localhost:6379/0"
    rabbit_url: str = "amqp://guest:guest@localhost:5672/"
    events_exchange: str = "incidents.events"

    # --- безопасность ---
    jwt_secret: str = "change-me-please-at-least-32-bytes-long!!"
    jwt_algorithm: str = "HS256"
    access_token_ttl_min: int = 30
    refresh_token_ttl_days: int = 7
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]
    # ключ для межсервисных вызовов (ИИ-сервис, внешняя ITSM-система): заголовок X-Service-Key
    service_api_key: str = "dev-service-key"
    login_rate_limit_per_min: int = 10
    bootstrap_admin_email: str = "admin@example.com"
    bootstrap_admin_password: str = "admin12345"

    # --- файл с данными (точка начала + живые изменения на демо) ---
    # бэкенд запускают из backend/ (npm run dev / uv run), файл лежит в data/ корня репозитория
    data_file: Path = Path("../data/incidents.json")
    watch_data_file: bool = True
    # в Docker на Windows/macOS события файловой системы из примонтированной папки
    # часто не доходят до контейнера — тогда включаем опрос
    watch_force_polling: bool = False
    # что делать с инцидентом, который пропал из нового снимка файла
    import_missing_policy: Literal["archive", "keep"] = "archive"
    # Файл = «правда ITSM»: следующий импорт снимка перетрёт правки, сделанные через API.
    # true -> после каждой правки через API/ingest текущее состояние БД пишется обратно в файл.
    # Минус: если в этот момент файл правят руками, ручная правка может потеряться.
    write_back_to_file: bool = False

    # --- предметная область ---
    coordinators_group_name: str = "КЦ ИТ Координаторы Массовых Инцидентов"
    critical_priority_id: int = 4
    high_priority_id: int = 3
    # сколько минут решённый критический инцидент ещё виден в группе «Критические» с отметкой «решён»
    critical_resolved_visible_minutes: int = 60
    # «новый» критический подсвечивается, пока его не подтвердили или пока не прошло N минут
    critical_new_minutes: int = 15
    # Ссылка «перейти в ITSM». Организаторы разрешили муляж: по умолчанию ведёт на встроенный
    # муляж ITSM (/itsm/...). Для показа с другого компьютера подставьте IP машины с бэкендом.
    itsm_base_url: str = "http://localhost:8000/itsm/incident/"
    itsm_mock_enabled: bool = True
    # куда ведёт ссылка «вернуться на дашборд» из муляжа
    dashboard_url: str = "http://localhost:5173/"
    business_tz: str = "Europe/Moscow"
    sla_warning_ratio: float = 0.30
    sla_danger_ratio: float = 0.10
    sla_check_interval_sec: int = 30

    # --- Telegram-бот ---
    telegram_bot_token: str | None = None
    telegram_api_base: str = "https://api.telegram.org"  # подменяется в тестах заглушкой
    # Публичный HTTPS-адрес бэкенда (туннель cloudflared/ngrok или сервер). Telegram открывает
    # мини-апп только по https, поэтому без него кнопка «Войти» в боте не появится.
    public_base_url: str | None = None
    # подпись initData из мини-аппа старше этого считается недействительной
    telegram_init_data_max_age_sec: int = 3600

    # --- push в мобильное приложение (Firebase Cloud Messaging) ---
    # путь к JSON-ключу сервисного аккаунта Firebase; пусто — push выключен
    fcm_service_account_file: str | None = None
    fcm_api_base: str = "https://fcm.googleapis.com"  # подменяется в тестах заглушкой

    # --- ИИ-агент (BigDad): рекомендация команды + описания команд в статистике ---
    # OpenAI-совместимый API (…/chat/completions с вызовом функций).
    # Подойдёт любой провайдер с таким протоколом (GigaChat, OpenRouter, локальный vLLM, …).
    # Базовый адрес до /v1 (без /chat/completions), например https://openrouter.ai/api/v1
    llm_api_base: str | None = None
    llm_api_key: str | None = None
    llm_model: str | None = None
    llm_timeout_sec: int = 120
    # максимум ответов модели за один прогон агента (вызов инструмента = один ответ).
    # Аналитику команд нужен запас: 22 команды в данных → до ~24 ходов, если модель
    # не батчит вызовы get_team_profile в одно сообщение
    llm_max_iterations: int = 40


@lru_cache
def get_settings() -> Settings:
    return Settings()
