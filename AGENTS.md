# AGENTS.md

## What this repo is

Greenfield MTS (МТС) hackathon project: a **dashboard for IT-incident coordinators**
(`Дашборд координатора IT-инцидентов`). There is **no code yet** — only the dataset,
attribute dictionary, mentor chat log, and two spec documents. No git repo, no
package manifest, no build/test/lint config, no `opencode.json`, no other instruction
files. Do not assume a stack, framework, or dev commands exist; there are none to run.

The case is Russian-language: data values, UI labels, and all spec prose are Russian.
Keep user-facing copy in Russian.

## Source of truth (read these first)

- `data/character_problems.json` — the authoritative incident dump: 44 records, 46
  fields, identical key shape in every record. This **is** the "incident database".
  The brief says the dashboard "должен работать только с тем форматом, который
  представлен в файле с инцидентами" — work only with this exact schema.
- `docs/МТС.pdf` — the case brief and jury scoring criteria. Defines the **four
  dashboard groups** and the live-demo requirement. Trust this over the TЗ for scope.
- `docs/chat_log.txt` — mentor Q&A that clarifies and in some places **corrects** the
  data dictionary. Read it before modeling statuses.
- `data/incidents_attributes.json` — field descriptions. Uses `api_source` key names
  that do NOT match the dump's actual field names; treat as a glossary, not a schema.
- `docs/mts-tz.docx` — a greatly expanded technical wish list (full REST API, data
  model, permissions matrix, UI, AI "BigDad", Flutter, Telegram bot). It is not all
  in scope; its §14 lists explicit exclusions.

When docs conflict with the data file or chat log, **trust the data + chat log**.

## Data quirks that will cause wrong logic if missed

- **Status IDs are swapped in the dictionary.** The dictionary says
  `7=Закрыт/Closed, 10=Завершен/Resolved`. The data and the chat log both say the
  opposite: **`7=Завершен/Resolved, 10=Закрыт/Closed`**. Use the data mapping.
  Full authoritative map: `0=Назначен/Assigned`, `2=Выполняется/WorkInProgress`,
  `7=Завершен/Resolved`, `10=Закрыт/Closed`, `20=Исследование ситуации/Research`.
- `20=Исследование ситуации (Research)` exists in the data (5 records) but is absent
  from the dictionary's list of possible statuses. Handle it.
- Closed (10) is final: it cannot be returned to work; a recurring incident means a
  new record. Resolved (7) can be reopened.
- `priorityId` has only 1/2/3 in the data (Низкий/Средний/Высокий). The dictionary's
  `4=Наивысший` never appears. `urgencyId`/`impactId` do reach 4 (Наивысшая/Наивысшее).
- `solution` is free text and **is filled in all 44 records**, including `Назначен`
  and `Выполняется`, even though the chat says those states must not have it and that
  it can hold a *failed past* solution containing leftover personal data. Do not use
  `solution` presence to infer status, and do not display it verbatim without care.
- `waitingExitDate` is the .NET sentinel `0001-01-01T00:00:00` in all 44 records — ignore it.
- `isEffect/isReason/isDouble/isMaster/isRootIncident` are real JSON booleans.
  `isNeedUp` and `eliminationType` are `null` in most records.
- Coordinator team name in the data is exactly `КЦ ИТ Координаторы Массовых Инцидентов`.
  Timestamps are ISO-8601 (mostly `...Z`; a few fractional seconds). `id` is unique.

## The four dashboard groups (from the case brief)

Group incidents by status, priority/impact, and assigned team:
1. Критические инциденты (critical — show status and deadlines)
2. Инциденты, назначенные на координаторов (assigned to the coordinator team above)
3. Инциденты с высоким приоритетом (can escalate to critical)
4. Инциденты на этапе исследования ситуации (`Исследование ситуации`, stateId 20)

**One incident can belong to several groups at once** — do not treat grouping as
exclusive. Show at a glance: product, time occurred, assignee, status, time left.

## Acceptance / demo (what actually gets scored)

The jury demo requires a **live reaction to file edits**: change the data file and the
dashboard must pick up the change (resolution, reassignment, priority, or deadline),
without a reload. Build for automatic refresh of `data/character_problems.json`.

Jury checklist (PDF + ТЗ §13): (A) reads at a glance — where/who/time-left, live timer,
criticals on top; (B) auto-updates — no reload, alert on new critical, toast on
assignment/resolution, notifications; (C) AI "BigDad" is useful — summary, team
recommendation, 0–100 risk score, developer scoring; (D) engineering — soft delete,
permissions matrix, one-time branch URL, freeze pauses SLA, hotkeys.

Explicitly out of scope (ТЗ §14): real Zabbix/Grafana integration, SMS, SSO/2FA,
multitenancy, PDF reports — mock data only.
