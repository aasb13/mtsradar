# mtsradar — MTS IT-incident coordinator dashboard

Built during my **second hackathon** for the MTS (МТС) case: a live dashboard that helps an IT-incident coordinator see what is critical, who is assigned, how much time is left, and what just changed. The app treats an incident export in `data/incidents.json` as its source of truth and reacts to edits of that file within about a second — the central requirement of the jury demo. The interface and the case documents are Russian.

> Hackathon prototype, not production software. There is no license file in the repository yet.

## What it does

- Watches every `*.json` file in `data/`; an edit is imported, diffed and pushed to open browsers over WebSocket without reload.
- Groups incidents into four **overlapping** case groups: critical (`priorityId == 4`), coordinator queue (`assignedGroupName == "КЦ ИТ Координаторы Массовых Инцидентов"`), high priority (`priorityId == 3`), and research (`stateId == 20`).
- Computes SLA state and time left from the export's `deadline`; alerts on new criticals, assignments, resolutions and deadline breaches.
- Keeps a change history with comments and acknowledgements; JWT roles `admin`, `coordinator`, `viewer`, plus a restricted `developer` role for the mobile client.
- Provides an ITSM mock at `/itsm/incident/{id}`: edits there write back to the JSON export and travel through the same import → event → dashboard path.
- Optional extras: the **BigDad** LLM assistant (team recommendation, team descriptions, risk summary), a Telegram mini-app login with notifications, and a Flutter mobile client with FCM push.

## Architecture

```
data/*.json ──watchfiles──> worker ──save_incident()──> MongoDB
                              │        ├─ diff + history + notifications
                              │        └─ RabbitMQ incidents.events ──> WS gateway ──> browser
REST / ITSM mock ──────────> API ──────┘                        └──> AI service / Telegram / FCM
Redis: refresh tokens, rate limits, import lock, event + SLA alert deduplication
```

Every write goes through `app/services/store.py::save_incident`; that is what keeps history, events and notifications consistent regardless of whether a change came from the file, REST, the kanban board or the ITSM mock.

## Stack

| Part | Technology |
|---|---|
| Backend | Python 3.12+, FastAPI, MongoDB, Redis, RabbitMQ, `uv`, JWT |
| Frontend | React 19, TypeScript, Vite (dev proxy for `/api` and `/ws` → `:8000`) |
| Mobile | Flutter (Android primary, iOS from the same code), FCM push |
| Deploy | Docker Compose locally; Forgejo Actions + a `mtsradar:host` runner + systemd on the demo host |

## Quick start

Prerequisites: Python 3.12+, [uv](https://docs.astral.sh/uv/), Node.js/npm, Docker. Flutter, an LLM key and Telegram/FCM credentials are optional.

**Infrastructure + services in Docker, frontend in dev mode:**

```bash
cp backend/.env.example backend/.env
docker compose up --build                      # mongo, redis, rabbitmq, api (:8000), worker, bot
docker compose exec api python -m scripts.seed_users
npm install && npm run dev --workspace frontend  # Vite on http://localhost:5173
```

**Local development (code from the IDE):**

```bash
cp backend/.env.example backend/.env
docker compose up -d mongo redis rabbitmq
(cd backend && uv sync && uv run python -m scripts.seed_users)
npm install
npm run dev                                    # API + worker + Vite together
```

Check: http://localhost:8000/api/health should report all services `ok`, Swagger is at http://localhost:8000/docs, RabbitMQ UI at http://localhost:15672 (guest/guest).

Seeded logins (password `demo12345`): `coord1@example.com` … `coord3@example.com`, `viewer@example.com`, plus developer accounts `alice@example.com` and `winnie@example.com`. `admin@example.com / admin12345` is created on startup. **Change `JWT_SECRET` and the bootstrap password before exposing the app anywhere.**

## Rehearse the demo

Edit `data/incidents.json` and save; the dashboard updates on its own:

| Edit | What the coordinator sees |
|---|---|
| `"priorityId": 4` on an active incident | critical banner, sound and notification; acknowledgement button |
| `"assignedGroupName": "КЦ ИТ Координаторы Массовых Инцидентов"` | incident enters the coordinator group with a toast |
| `"stateId": 7` on a critical incident | resolved state, still marked resolved for 60 minutes |
| `"stateId": 20` | incident moves into the research group |
| a `deadline` a couple of minutes away | SLA warning then breach notification |
| remove an incident | archived, not physically deleted |
| save malformed JSON | `import.failed`; the dashboard keeps the last good data |

The current export contains 77 incidents (33 with `priorityId: 4`); older docs in `docs/` describe an earlier 44-record dump, so treat the data file as authoritative.

## Configuration

All settings live in `backend/.env` (template: `backend/.env.example`). Notable ones:

| Variable | Purpose |
|---|---|
| `DATA_FILE`, `WATCH_DATA_FILE`, `WATCH_FORCE_POLLING` | which export to watch and how to watch it (enable polling on Windows/macOS) |
| `COORDINATORS_GROUP_NAME`, `CRITICAL_PRIORITY_ID`, `HIGH_PRIORITY_ID` | case group rules |
| `SLA_WARNING_RATIO`, `SLA_DANGER_RATIO`, `SLA_CHECK_INTERVAL_SEC` | deadline alerts |
| `JWT_SECRET`, `BOOTSTRAP_ADMIN_*`, `SERVICE_API_KEY`, `CORS_ORIGINS` | auth and integration |
| `LLM_API_BASE`, `LLM_API_KEY`, `LLM_MODEL` | optional BigDad AI; empty means AI endpoints return 503 |
| `TELEGRAM_BOT_TOKEN`, `PUBLIC_BASE_URL`, `FCM_SERVICE_ACCOUNT_FILE` | optional Telegram bot and mobile push |

Never commit `.env`, Telegram tokens or the Firebase service-account key.

## Checks and deployment

```bash
cd backend && uv run pytest -q && uv run ruff check .   # backend tests + lint
npm run build --workspace frontend                       # TypeScript check + production build
cd backend && uv run python -m scripts.smoke             # end-to-end demo script
```

`deploy/deploy.sh` (triggered by `.forgejo/workflows/deploy.yml` on pushes to `master`) syncs the code to `/srv/mtsradar`, rebuilds the frontend and backend and restarts the `mtsradar-*` systemd units. Secrets on the target are created once and are never overwritten by the deploy.

## Repository layout

| Path | Contents |
|---|---|
| `backend/` | FastAPI app, domain logic, services, routes, worker, tests, API docs |
| `frontend/` | React dashboard: inbox, kanban, stats, teams, profile, chat, admin screens |
| `data/` | incident export and attribute dictionary — the live demo input |
| `docs/` | case brief, technical brief, chat log, extracted requirements |
| `hackathon-integration2/` | integration snapshot that also contains the Flutter `mobile/` client |
| `deploy/`, `.forgejo/workflows/` | host deployment script and workflow |
| `AGENTS.md` | contributor notes: data quirks, status mappings, demo checklist |

## Further reading

- [Backend guide](backend/docs/GUIDE.md) — setup, code reading order, demo rehearsal
- [Frontend API contract](backend/docs/FRONTEND_API.md) and [Swagger](http://localhost:8000/docs)
- [AI contract](backend/docs/AI_CONTRACT.md), [decisions and data quirks](backend/docs/DECISIONS.md)
- [Telegram](backend/docs/TELEGRAM.md), [mobile backend](backend/docs/MOBILE.md), [Flutter client](hackathon-integration2/mobile/README.md)

Two data traps worth remembering: `7 = Завершен (Resolved)` and `10 = Закрыт (Closed)` even though the attribute dictionary swaps them; status `20 = Исследование ситуации` exists in the export but is missing from that dictionary. The `solution` field can contain stale text in non-resolved records and is cleaned during import.
