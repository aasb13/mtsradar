# Бэкенд дашборда координатора инцидентов

Каркас стека: FastAPI + SQLAlchemy 2.0 (async) + Alembic (PostgreSQL) + Redis.

## Запуск

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
# поднять PostgreSQL и Redis (например, через docker compose из корня)
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Доменной логики (борд, синк данных, AI-анализ) пока нет — только скелет с `/health`.
