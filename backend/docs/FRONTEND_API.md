# Контракт для фронтенда

Базовый URL: `http://localhost:8000/api`. Полная живая схема — **Swagger** `http://localhost:8000/docs`,
машинная — `http://localhost:8000/openapi.json` (из неё можно сгенерировать TS-типы:
`npx openapi-typescript http://localhost:8000/openapi.json -o src/api/schema.ts`).

Все ключи — camelCase, как в исходном файле. Все даты — ISO-8601 в UTC (`2026-11-10T06:32:14Z`).
Ошибки: `{"detail": "текст по-русски"}` (у 422 от валидации — массив).

## 1. Авторизация (JWT)

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/auth/login` | `{email, password}` | `{accessToken, refreshToken, tokenType, expiresIn, user}` |
| POST | `/auth/refresh` | `{refreshToken}` | новая пара (старый refresh больше не работает) |
| POST | `/auth/logout` | `{refreshToken}` | 204 |
| GET | `/me` | — | профиль + `notificationKinds` |
| PATCH | `/me` | `{fullName?, telegramChatId?, notificationSettings?, currentPassword?, newPassword?}` | профиль |

Запросы: заголовок `Authorization: Bearer <accessToken>`. Access живёт 30 мин.
Рецепт: при 401 один раз вызвать `/auth/refresh`, повторить запрос; если и refresh дал 401 — на логин.
Роли: `admin`, `coordinator`, `viewer` (только чтение), `developer` (видит только свои инциденты, для мобильного
приложения — см. `docs/MOBILE.md`). Изменения доступны `admin` и `coordinator`. Разработчику общий дашборд,
канбан и список закрыты (403).

## 2. Главный экран

### `GET /dashboard` — всё одним запросом
```json
{
  "serverTime": "2026-11-20T15:25:46Z",
  "groupTitles": {"critical": "Критические", "coordinators": "Назначены на координаторов",
                  "high": "Высокий приоритет", "research": "Исследование ситуации"},
  "kpi": {"active": 29, "critical": 2, "coordinators": 2, "high": 0, "research": 5,
          "breached": 16, "resolvedToday": 1},
  "unacknowledgedCritical": ["INC000021938167"],
  "groups": {"critical": [Card, ...], "coordinators": [...], "high": [...], "research": [...]}
}
```
Один и тот же инцидент может лежать в нескольких группах (это требование кейса).
Внутри группы карточки уже отсортированы: нерешённые → критические → по срочности SLA → по остатку времени.

### Карточка (Card) — одинакова в REST и в WebSocket
```json
{
  "id": "INC000021938167",
  "header": "Проблема с Прокладка",
  "shortDescription": "Зафиксировано отклонение в работе Прокладка.",
  "productName": "Вечная зажигалка",
  "service": "[Вечная зажигалка] Газовый клапан",
  "scenarioName": "Прокладка",
  "submitDate": "2026-11-10T06:32:14Z",
  "deadline": "2026-11-10T12:32:14Z",
  "completionDate": null,
  "stateId": 2, "state": "Выполняется",
  "priorityId": 4, "priority": "Наивысший",
  "assignedGroupName": "ОГЭ Приморье",
  "assignedEmployee": "Медведь Барсик (barsik)",
  "serviceType": "Технологический",
  "groups": ["critical"],
  "isCritical": true, "isActive": true, "isResolved": false,
  "isNewCritical": true,
  "sla": {"state": "breached", "timeLeftSeconds": -874412, "ratio": 0.0, "met": null},
  "acknowledged": null,
  "ai": null,
  "itsmUrl": "https://itsm.example.local/incident/INC000021938167",
  "updatedAt": "2026-11-20T15:25:05.810Z",
  "version": 2,
  "deleted": false
}
```
Как читать поля:
- **что / где / кто / сколько осталось** (обязательно по кейсу): `productName` + `header`; `submitDate`; `assignedGroupName` + `assignedEmployee`; `state`; `deadline`.
- `sla.state`: `ok` · `warning` (<30% времени) · `danger` (<10%) · `breached` (просрочен) · `none` (нет срока) · `resolved`.
- **Живой таймер** считайте на клиенте от `deadline`. Чтобы не зависеть от часов ноутбука, при загрузке запомните `offset = serverTime − Date.now()` и используйте `Date.now() + offset`.
- `isResolved && groups.includes("critical")` — критический, который **решён недавно**: показывать зелёным «решён» (бэкенд держит его в группе 60 мин).
- `isNewCritical` — появился недавно и ещё никем не подтверждён → пульсация/звук.
- `acknowledged` — `{userId, name, at}` или `null`. Кнопка «Принял» → `POST /incidents/{id}/ack`.
- `itsmUrl` — переход в ITSM по клику (требование кейса). Ведёт на встроенный муляж ITSM; открывайте в новой вкладке: `<a href={itsmUrl} target="_blank" rel="noopener">`. Правки, сделанные там, вернутся на дашборд обычными WS-событиями.
- `ai` — `{summary, riskScore, stale}` или `null`; `stale: true` — данные поменялись после расчёта ИИ.

## 3. Обновления в реальном времени — WebSocket

`ws://localhost:8000/api/ws?token=<accessToken>` (неверный токен — соединение отклоняется).

Сообщение сервера: `{"eventId", "type", "ts", "payload"}`. Клиент может слать `{"type":"ping"}` → `{"type":"pong"}` (раз в 25–30 с).

| type | payload | Что делать на фронте |
|---|---|---|
| `hello` | `{userId}` | соединение готово |
| `incident.created` / `incident.updated` | `{incidentId, kinds[], changes[], groupsEntered[], groupsLeft[], card, source, actor, silent}` | заменить карточку по `id` во всех группах по `card.groups` (убрать из групп, которых там нет) |
| `incident.removed` | `{incidentId}` | убрать карточку отовсюду |
| `incident.acknowledged` | `{incidentId, actor, card}` | обновить карточку, погасить баннер |
| `incident.ai_updated` | `{incidentId, ai, card}` | обновить ИИ-блок |
| `incident.sla` | `{incidentId, slaState, timeLeftSeconds, card}` | подсветить срок |
| `incident.comment_added` | `{incidentId, comment}` | дописать в ленту, если карточка открыта |
| `import.completed` | `{created, updated, archived, errors, warnings, ...}` | опционально тост «данные обновлены» |
| `import.failed` | `{error}` | тост «файл с данными некорректен» |
| `notification.created` | уведомление (см. §6) — приходит **только адресату** | тост + колокольчик +1 |

`kinds` — что именно поменялось, без разбора полей: `created`, `state_changed`, `resolved`, `reopened`,
`priority_changed`, `reassigned`, `deadline_changed`, `fields_changed`, `restored`.

Реакции из кейса:
- `"critical"` в `groupsEntered` → красный баннер + звук;
- `"resolved"` в `kinds` и `card.isCritical` → зелёный тост «решён»;
- `"coordinators"` в `groupsEntered` → тост «назначен на координаторов».
Удобнее всего строить тосты прямо по `notification.created`: там уже готовые `title/body/severity`.

**Важно:** после переподключения сокета перезапросите `GET /dashboard`: события, которые пришли, пока сокет был отключён, повторно не придут.

## 4. Канбан и список

- `GET /board?priorityId=&assignedGroupName=&productName=&q=&closedLimit=30` →
  `{columns: [{stateId, title, count, cards[]}], transitions: {"0":[2,7], ...}}`.
  Колонки — реальные статусы ITSM: Назначен(0) · Выполняется(2) · Исследование ситуации(20) · Завершен(7) · Закрыт(10).
  `transitions` — куда можно перетаскивать (для курсора no-drop).
- `GET /incidents?group=&stateId=&priorityId=&assignedGroupName=&productName=&slaState=&active=&q=&sort=attention|deadline|submitDate|priority&order=&page=&perPage=` → `{items, total, page, perPage, serverTime}`. Мультизначения повторяются: `?stateId=0&stateId=2`.

## 5. Карточка инцидента и действия

| Метод | Путь | Кто | Что |
|---|---|---|---|
| GET | `/incidents/{id}` | все | Card + `data` (полная запись из файла) + `meta` + `ai` (полный) + `allowedTransitions` |
| PATCH | `/incidents/{id}` | coordinator | `{priorityId?, deadline?, assignedGroupName?, assignedEmployee?, header?, shortDescription?, description?, expectedVersion?}` |
| POST | `/incidents/{id}/transition` | coordinator | `{toStateId, stateReason?, solution?, comment?}`; 422 при недопустимом переходе, 409 если Закрыт |
| POST | `/incidents/{id}/ack` | coordinator | подтвердить критический |
| DELETE | `/incidents/{id}` | coordinator | в архив (логическое удаление) |
| POST | `/incidents/{id}/restore` | coordinator | вернуть из архива |
| GET | `/incidents/{id}/history` | все | путь инцидента: `[{type, at, source, actor, kinds, changes[{field, old, new}], groupsEntered, groupsLeft}]` |
| GET / POST | `/incidents/{id}/comments` | все | `{text}` |
| DELETE | `/comments/{id}` | автор/admin | |
| POST | `/incidents/{id}/ai/refresh` | coordinator | попросить ИИ пересчитать (ответ придёт событием `incident.ai_updated`) |

409 «Инцидент изменился» — карточка устарела: перечитать и повторить.

## 6. Уведомления

- `GET /notifications?unreadOnly=true&limit=50` → `{items, unread}`
- `POST /notifications/{id}/read`, `POST /notifications/read-all`

Уведомление: `{id, userId, kind, severity, title, body, incidentId, itsmUrl, createdAt, readAt}`.
`kind`: `incident.assigned_to_me`, `incident.new`, `critical.new`, `critical.resolved`, `coordinators.assigned`, `high.new`, `sla.danger`, `sla.breached`.
`severity`: `critical` · `high` · `success` · `info`. Отключение видов — `PATCH /me` → `notificationSettings.kinds`.

## 5a. Участники инцидента (разработчики)
`POST /incidents/{id}/members` `{userId}` и `DELETE /incidents/{id}/members/{userId}` (coordinator) — добавить/убрать
разработчика; он увидит инцидент в мобильном приложении и получит уведомление. Список разработчиков:
`GET /users?role=developer`. В карточке: `members` (id) и `assignedEmployeeLogin`.
Событие WS: `incident.members_changed`.

## 6a. Telegram
Привязка делается в боте (мини-апп), фронту отдельно делать ничего не нужно. В профиле можно показать
`user.telegramChatId` (не null — привязан) и кнопку «Отвязать Telegram» → `POST /api/tg/unlink`.
Новый вид уведомлений: `incident.new` (появился новый инцидент).

## 7. Справочники, статистика, файлы

- `GET /dictionaries` — статусы, приоритеты, группы, переходы, список команд (`assignedGroups`), продукты и т.п. для фильтров.
- `GET /stats` — агрегаты для виджетов (по продуктам, командам, приоритетам, SLA; среднее время решения, доля соблюдения срока).
- `POST /import` (multipart `file`, `?mode=snapshot|upsert&dryRun=false`) — загрузка файла с UI; `dryRun=true` показывает, что изменится.
- `GET /export` — скачать текущее состояние в исходном формате.
- `GET /import/runs` — журнал импортов (сколько создано/обновлено, ошибки и предупреждения).
- `GET /users`, `POST/PATCH/DELETE /users/{id}` — админка (admin).
- `GET /health`.
