# Пошаговый гайд для бэкендера

## Шаг 0. Что поставить (один раз)
| Что | Зачем | Где взять |
|---|---|---|
| **Python 3.12+** | язык | python.org (Windows: галочка «Add to PATH») |
| **uv** | менеджер зависимостей и venv (быстрее pip, есть lock-файл) | `pip install uv` или docs.astral.sh/uv |
| **Docker Desktop** | MongoDB, Redis, RabbitMQ одной командой | docker.com (на Windows включить WSL 2) |
| **Git** | | git-scm.com |
| IDE: **PyCharm** или **VS Code** | см. ниже | |
| MongoDB Compass (по желанию) | смотреть коллекции глазами | mongodb.com/products/compass |

**IDE.** Подойдёт любая из двух:
- **PyCharm**: File → Open → папка проекта → Settings → Python Interpreter → Add → *Existing* → `.venv` (создаётся `uv sync`). Две Run-конфигурации:
  1) *API*: module `uvicorn`, параметры `app.main:app --reload`, рабочая папка — корень проекта;
  2) *Worker*: module `app.worker`.
- **VS Code**: расширения *Python*, *Pylance*, *Ruff*, *Docker*, *MongoDB for VS Code*. `Ctrl+Shift+P → Python: Select Interpreter → .venv`. Запуск — в двух терминалах (команды ниже).

## Шаг 1. Поднять проект
```bash
git clone <repo> && cd incident-backend
cp .env.example .env                # Windows: copy .env.example .env
docker compose up -d mongo redis rabbitmq
uv sync
uv run python -m scripts.seed_users
uv run uvicorn app.main:app --reload   # терминал 1
uv run python -m app.worker            # терминал 2
```
Проверить:
- http://localhost:8000/api/health — `mongo/redis/rabbit: ok`;
- http://localhost:8000/docs — Swagger, Authorize: `coord1@example.com` / `demo12345`, вызвать `GET /api/dashboard`;
- http://localhost:15672 (guest/guest) — во вкладке Exchanges есть `incidents.events`;
- в Compass база `incidents`, коллекция `incidents` — 44 документа.

## Шаг 2. Понять код (порядок чтения)
1. `app/domain/enums.py` → `normalize.py` → `classify.py` → `diff.py` — вся логика кейса, чистые функции, покрыты `tests/test_domain.py`.
2. `app/services/store.py` — **единственная точка записи**: diff → meta → запись с версией → история → событие.
3. `app/services/importer.py` + `watcher.py` — как файл превращается в изменения.
4. `app/bus/rabbit.py` + `app/ws/manager.py` — как событие доходит до браузера.
5. `app/worker/__main__.py` + `services/notify.py` + `services/sla_monitor.py` — уведомления и сроки.
6. `app/api/routes/*` — эндпоинты.

Правило, которое не стоит нарушать: **не писать в `db.incidents` в обход `save_incident`** — иначе пропадут история, события и уведомления.

## Шаг 3. Отдать контракты команде
- Техлиду/фронтенду: `docs/FRONTEND_API.md` + ссылка на `/docs`. Попросите сгенерировать TS-типы из `/openapi.json`.
- ИИ-коллеге: `docs/AI_CONTRACT.md`. Для работы ему нужны только RabbitMQ и `SERVICE_API_KEY`.
- Вопросы организаторам — `docs/DECISIONS.md`, §9.

Чтобы фронт работал с вашим бэкендом по сети на хакатоне: запускайте `uvicorn app.main:app --host 0.0.0.0`, добавьте адрес фронта в `CORS_ORIGINS`, дайте свой IP в локальной сети.

## Шаг 4. Работа на хакатоне
- Каждая фича — ветка → PR → merge в `main`. Перед пушем: `uv run ruff check . && uv run pytest -q`.
- Новое поле в карточке: `services/presenter.py::card` (и сообщить фронту).
- Новое правило уведомлений: `services/notify.py::rules_for` + вид в `services/users.py::NOTIFICATION_KINDS`.
- Новая группа или изменение условия группы: `domain/classify.py` + тест.
- Посмотреть события глазами: RabbitMQ UI → Queues → создать очередь `debug`, привязать к `incidents.events` ключом `#` → Get messages.

## Шаг 5. Репетиция защиты (что показать по кейсу)
1. Открыт дашборд, видно 4 группы. Один инцидент — в двух группах.
2. В редакторе `data/incidents.json` ставим `"priorityId": 4` активному инциденту → сохраняем → баннер + звук + уведомление. Координатор жмёт «Принял».
3. Ставим `"assignedGroupName": "КЦ ИТ Координаторы Массовых Инцидентов"` → инцидент появляется в группе координаторов + тост.
4. Ставим критическому `"stateId": 7` → зелёный «решён за …», карточка уходит из активных.
5. Меняем `deadline` на «через 2 минуты» → срок краснеет, приходит уведомление «срок истекает».
6. Клик по карточке → открывается муляж ITSM. Там меняем, например, статус на «Завершен» → «Сохранить» → вкладка дашборда сразу показывает «решён». Говорим жюри: «координатор работает в ITSM, ITSM обновляет выгрузку, дашборд подхватывает сам».
7. ИИ-блок (выжимка, риск, кому передать) — от коллеги.

Перед защитой: `docker compose down -v && docker compose up -d …` (чистая база), `seed_users`, затем запуск. Держите копию исходного файла, чтобы быстро откатиться.
Сквозная проверка «всё ли живо»: `uv run python -m scripts.smoke` (меняет файл с данными — запускайте на копии, задав `DATA_FILE`).

## Telegram-бот
См. `docs/TELEGRAM.md`: токен в `.env`, туннель `cloudflared`, третий процесс `uv run python -m app.bot`.

## Если что-то не работает
| Симптом | Причина / что делать |
|---|---|
| Правки файла не подхватываются (Docker на Windows/macOS) | `WATCH_FORCE_POLLING=true` (в compose для воркера уже включено) |
| `import.failed` в логах | JSON сохранён с ошибкой — пока его не исправят, система работает на последних данных |
| 401 на всё | истёк access (30 мин) → `/auth/refresh`; или в `.env` сменили `JWT_SECRET` |
| Фронт: CORS error | добавить его адрес в `CORS_ORIGINS` и перезапустить API |
| Нет уведомлений | не запущен воркер; или пользователь отключил вид в `notificationSettings` |
| Уведомлений нет после первого запуска | так и задумано: первичная загрузка «тихая» |
