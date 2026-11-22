# Бэкенд для мобильного приложения

Приложение — отдельная ветка `feature/mobile` (Flutter). Здесь — что для него есть на бэкенде.

## Роли и видимость
| Роль | Что видит | Уведомления |
|---|---|---|
| admin, coordinator, viewer | все инциденты | новые инциденты, критические, решённые, назначенные на координаторов, сроки (viewer — без уведомлений) |
| **developer** | только «свои»: где он исполнитель в ITSM (`data.assignedEmployeeLogin == user.itsmLogin`) или куда его добавил координатор (`members`) | `incident.assigned_to_me` — «Вас назначили на инцидент / Вас добавили в инцидент» |

Правила видимости — `app/services/access.py`; их используют и REST, и WebSocket (разработчику не уходят события о чужих
инцидентах, а когда инцидент перестаёт быть «его», он получает `incident.removed`).

Разработчику закрыты общие экраны: `/api/dashboard`, `/api/board`, `/api/incidents` (список), `/api/stats`,
`/api/dictionaries`, история, комментарии → 403. Карточка `GET /api/incidents/{id}` чужого инцидента → 404.

Демо-разработчики (`python -m scripts.seed_users`): `alice@example.com` (itsmLogin `alice`), `winnie@example.com` (`winnie`), пароль `demo12345`.
Создать своего: `POST /api/users` (admin) с `{"role": "developer", "itsmLogin": "<логин из assignedEmployeeLogin>", ...}`.

## Эндпоинты
| Метод | Путь | Кто | Что |
|---|---|---|---|
| GET | `/api/my/incidents?includeResolved=false` | все | `{serverTime, role, total, levels: [{priorityId, title: "4 уровень", name, count, items: [Card]}]}` — уровни 4 → 1, текущие инциденты, уже отфильтрованные по роли |
| POST | `/api/devices` | все | `{token, platform: android/ios}` — FCM-токен телефона |
| POST | `/api/devices/unregister` | все | `{token}` — при выходе из приложения |
| POST | `/api/incidents/{id}/members` | coordinator | `{userId}` — добавить разработчика в инцидент → ему уведомление |
| DELETE | `/api/incidents/{id}/members/{userId}` | coordinator | убрать |

В карточке (Card) добавились поля `assignedEmployeeLogin` и `members` (id добавленных разработчиков).
Новое событие WebSocket/RabbitMQ: `incident.members_changed` `{incidentId, added[], removed[], card}`.

## Push (Firebase Cloud Messaging)
Канал включается переменной `FCM_SERVICE_ACCOUNT_FILE` (JSON-ключ сервисного аккаунта Firebase:
Project settings → Service accounts → Generate new private key). Файл не коммитить — `firebase-service-account*.json` в `.gitignore`.
Без неё push выключен, всё остальное работает.

Воркер шлёт push на все устройства адресата уведомления (если в `notificationSettings.push` не выключено).
Протухшие токены (приложение удалено) удаляются автоматически. Код — `app/services/push.py`.
