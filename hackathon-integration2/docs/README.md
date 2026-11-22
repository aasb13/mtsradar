# Incident Dashboard — backend

Бэкенд дашборда координатора массовых инцидентов (кейс МТС).
Python 3.12+ · FastAPI · MongoDB · Redis · RabbitMQ · JWT.

Что делает:
- берёт файл выгрузки инцидентов (формат организаторов) как «точку начала» и **следит за ним**: любая правка файла за ~1 с доходит до браузеров по WebSocket;
- раскладывает инциденты по **четырём группам** кейса (критические / назначены на координаторов / высокий приоритет / исследование ситуации), один инцидент может быть в нескольких;
- считает остаток срока и состояние SLA из поля `deadline`;
- **оповещает**: новый критический, критический решён, назначен на координаторов, срок истекает/нарушен;
- хранит историю каждого изменения (путь инцидента), комментарии и подтверждения;
- отдаёт контракт ИИ-части (события в RabbitMQ + внутренние эндпоинты);
- содержит **муляж ITSM** (`/itsm`), куда ведёт клик по инциденту (организаторы разрешили муляж).

Документы:
- [docs/GUIDE.md](docs/GUIDE.md) — пошаговый план работы: что ставить, где запускать, как репетировать демо
- [docs/FRONTEND_API.md](docs/FRONTEND_API.md) — контракт для фронтенда (REST + WebSocket)
- [docs/AI_CONTRACT.md](docs/AI_CONTRACT.md) — контракт для ИИ-части
- [docs/DECISIONS.md](docs/DECISIONS.md) — расхождения ТЗ / кейса / данных и принятые решения
- Swagger: http://localhost:8000/docs

## Архитектура

```
             правка руками                      пуш из ITSM (X-Service-Key)
                  │                                      │
          data/incidents.json                 POST /api/ingest/incidents
                  │ watchfiles                           │
   ┌──────────────▼──────────────┐        ┌──────────────▼──────────────┐
   │ worker (python -m app.worker)│        │  api (uvicorn app.main:app) │◄── REST / WS ── браузер
   │  • вотчер файла → импорт     │        │  • REST, JWT, права         │
   │  • правила уведомлений       │        │  • WS-шлюз                  │
   │  • контроль сроков (SLA)     │        │                             │
   └──────┬───────────────▲───────┘        └───┬──────────────▲─────────┘
          │ save_incident │ consume            │ save_incident│ consume (своя очередь)
          ▼               │                    ▼              │
   ┌──────────────┐   ┌───┴────────────────────────────────────┴──┐     ┌──────────────┐
   │   MongoDB    │   │ RabbitMQ  exchange incidents.events (topic)│◄───►│  ИИ-сервис   │
   │ incidents,   │   │ incident.* · import.* · ai.requested ·     │     │  (коллега)   │
   │ events, ...  │   │ notification.user.{id}                     │     └──────────────┘
   └──────────────┘   └────────────────────────────────────────────┘
          Redis: refresh-токены, rate-limit, блокировка импорта, дедуп событий и SLA-оповещений
```

Ключевая идея: **любое изменение инцидента** (файл, REST, ITSM, канбан) проходит через одну функцию
`app/services/store.py::save_incident` → diff → история → событие в RabbitMQ. Поэтому история,
уведомления и обновление экрана одинаковы для всех источников, а повторный импорт того же файла ничего не меняет.

## Быстрый старт

### Вариант A — всё в Docker
```bash
cp .env.example .env
docker compose up --build
docker compose exec api python -m scripts.seed_users   # демо-координаторы
```

### Вариант B — инфраструктура в Docker, код из IDE (удобнее для разработки)
```bash
cp .env.example .env
docker compose up -d mongo redis rabbitmq
uv sync                                    # зависимости в .venv
uv run python -m scripts.seed_users
uv run uvicorn app.main:app --reload       # терминал 1 — API
uv run python -m app.worker                # терминал 2 — воркер
```

Проверка: http://localhost:8000/api/health → все `ok`. Swagger: http://localhost:8000/docs
(кнопка Authorize: username = `coord1@example.com`, password = `demo12345`).

Пользователи: `admin@example.com / admin12345` (создаётся сам), после `seed_users` — `coord1..3@example.com`, `viewer@example.com` (пароль `demo12345`).

## Демо: «в файл вносятся изменения — дашборд реагирует»
Правьте `data/incidents.json` в любом редакторе и сохраняйте. Что попробовать:

| Правка | Что увидит координатор |
|---|---|
| `"priorityId": 4` у любого активного | событие с `groupsEntered: ["critical"]`, уведомление «Критический инцидент», баннер до подтверждения |
| `"assignedGroupName": "КЦ ИТ Координаторы Массовых Инцидентов"` | инцидент появляется в группе координаторов + уведомление |
| у критического `"stateId": 7` | `kinds: ["resolved"]`, уведомление «решён за …», ещё 60 мин виден с отметкой «решён» |
| `"stateId": 20` | попадает в «Исследование ситуации» |
| `"deadline"` через пару минут | срок становится `danger` → уведомление от SLA-монитора |
| удалить инцидент из файла | `incident.removed` (архив, не физическое удаление) |
| сохранить битый JSON | `import.failed`, система продолжает работать на последних данных |
| клик по карточке → муляж ITSM `/itsm/incident/{id}` → «Сохранить» | правка пишется в файл выгрузки и тем же путём приходит на дашборд |

Для репетиций есть `uv run python -m scripts.demo …` (см. docstring) и сквозная проверка `scripts/smoke.py`.

## Структура
```
app/
  core/       настройки, JWT/пароли, логи
  db/         Mongo (индексы), Redis (что и зачем там лежит)
  bus/        RabbitMQ: публикация и подписка
  domain/     чистая логика: нормализация записи, группы, SLA, diff (покрыта тестами)
  services/   store (единая запись), importer, watcher, exporter, presenter, notify, sla_monitor, users
  api/        deps (авторизация, роли) + routes/* (в т.ч. itsm_mock — HTML-муляж ITSM)
  ws/         менеджер WebSocket-подключений и шлюз RabbitMQ → WS
  worker/     фоновый процесс
scripts/      seed_users, demo, smoke
tests/        юнит-тесты ядра на реальных данных организаторов
```

## Тесты и линтер
```bash
uv run pytest -q
uv run ruff check . && uv run ruff format .
```
