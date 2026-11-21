# Контракт для ИИ-части

ИИ-сервис — отдельный процесс (любой язык). С бэкендом он общается двумя путями:
**слушает события в RabbitMQ** и **пишет результаты через внутренний REST** с заголовком `X-Service-Key`.
ИИ не меняет данные инцидента (статус, приоритет, команду) — только рекомендации.

## 1. Подписка на события
- RabbitMQ: `amqp://guest:guest@localhost:5672/`, exchange **`incidents.events`** (topic, durable).
- Объявите свою durable-очередь, например `ai.incidents`, и привяжите ключи:
  `incident.created`, `incident.updated`, `ai.requested` (кнопка «Обновить» у координатора).
- Тело сообщения (JSON):
```json
{"eventId": "…", "type": "incident.updated", "ts": "2026-11-20T15:24:01Z",
 "payload": {"incidentId": "INC000021931151", "kinds": ["priority_changed"],
             "changes": [{"field": "priorityId", "old": 1, "new": 4}],
             "groupsEntered": ["critical"], "groupsLeft": [], "card": { … }, "silent": false}}
```
- Доставка «хотя бы один раз» — дубликаты возможны, отсекайте по `eventId`.
- `silent: true` — первичная загрузка файла в пустую базу; считать стоит, но это не «новые» события.
- Подсказка: не пересчитывайте на каждый `incident.updated` — достаточно на `created`, на `kinds` с
  `priority_changed`/`reassigned`/`deadline_changed`/`state_changed` и на `ai.requested`.

Пример на Python (aio-pika):
```python
queue = await channel.declare_queue("ai.incidents", durable=True)
for key in ("incident.created", "incident.updated", "ai.requested"):
    await queue.bind("incidents.events", routing_key=key)
```

## 2. Контекст для анализа
`GET /api/internal/incidents/{id}/context` (заголовок `X-Service-Key: <SERVICE_API_KEY>`) →
```json
{"incident": { Card + "data": {…полная запись…} + "ai": {…} },
 "history": [последние 20 изменений],
 "similar": [до 10 инцидентов с тем же productName + scenarioName: id, stateId, assignedGroupName, solution, submitDate],
 "knownAssignedGroups": ["КЦ ДОИ Администрирование SAN", …]}
```
Для сводки смены можно брать `GET /api/stats` (нужен JWT любого пользователя) или читать Mongo напрямую (только чтение!).

## 3. Запись результата
`PUT /api/internal/incidents/{id}/ai` (заголовок `X-Service-Key`). Все поля необязательны, присланные — перезаписываются:
```json
{"summary": "2–3 предложения, что произошло",
 "riskScore": 82, "riskReason": "почему может стать критическим",
 "recommendedGroup": "КЦ ИТ OPS Аварии MSCP", "recommendedReason": "почему эта команда",
 "breachForecast": {"probability": 0.7, "reason": "…"},
 "model": "имя модели", "extra": {"что угодно": "ещё"}}
```
Бэкенд сохраняет это в `ai` инцидента, ставит `ai.updatedAt`, `ai.stale=false` и рассылает всем браузерам
событие `incident.ai_updated`. Когда данные инцидента меняются, бэкенд сам ставит `ai.stale=true`.

`recommendedGroup` берите из `knownAssignedGroups`, чтобы фронт мог сделать кнопку «Передать» (PATCH assignedGroupName).
