# МТС — дашборд координатора IT-инцидентов

Монорепозиторий: Python/FastAPI бэкенд и React/TypeScript веб-фронтенд.

## Структура

- `backend/` — каркас FastAPI + SQLAlchemy 2.0/Alembic (PostgreSQL) + Redis.
- `frontend/` — каркас React + TypeScript + Vite.
- `data/character_problems.json` — источник данных (44 инцидента, 46 полей).
- `docs/` — кейс, ТЗ, словарь атрибутов, лог ментора.

Это база стека: доменная логика (борд, обновление данных, AI-анализ) пока не реализована.
