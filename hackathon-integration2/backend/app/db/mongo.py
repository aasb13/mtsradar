"""MongoDB через официальный асинхронный драйвер PyMongo (Motor объявлен устаревшим).

Коллекции:
  incidents       {_id: "INC...", data: {...запись ITSM как в файле...}, meta: {...}, ai: {...}, ack: {...}}
  incident_events история изменений (путь инцидента)
  comments        заметки координаторов
  users           пользователи нашей системы (координаторы, админы)
  teams           команды, созданные администратором до появления инцидентов ({_id, name, createdAt, createdBy, deletedAt})
  registration_requests заявки на регистрацию (одобряет админ — тогда создаётся пользователь)
  notifications   центр уведомлений (колокольчик)
  team_descriptions ИИ-описания команд для раздела статистика ({_id: имя команды, text, model, updatedAt})
  chat_sessions    сессии чата с ИИ-агентом BigDad ({userId, title, incidentId})
  chat_messages    сообщения чата ({sessionId, role: user|assistant, text, attachments, actions})
  chat_files       вложения чата ({userId, name, size, contentType, preview, data})
  import_runs     отчёты об импортах файла
  devices         токены push-уведомлений мобильного приложения (FCM)
"""

from pymongo import ASCENDING, DESCENDING, AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase

from app.core.config import get_settings

_client: AsyncMongoClient | None = None


def get_client() -> AsyncMongoClient:
    global _client
    if _client is None:
        # tz_aware=True: даты возвращаются с таймзоной UTC, их можно сравнивать с datetime.now(UTC)
        _client = AsyncMongoClient(get_settings().mongo_url, tz_aware=True, uuidRepresentation="standard")
    return _client


def get_db() -> AsyncDatabase:
    return get_client()[get_settings().mongo_db]


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.close()
        _client = None


async def ensure_indexes() -> None:
    db = get_db()
    await db.incidents.create_index([("meta.deletedAt", ASCENDING), ("data.stateId", ASCENDING)])
    await db.incidents.create_index("meta.groups")
    await db.incidents.create_index("data.priorityId")
    await db.incidents.create_index("data.deadline")
    await db.incidents.create_index("data.assignedGroupName")
    await db.incidents.create_index("meta.resolvedAt")
    await db.incident_events.create_index([("incidentId", ASCENDING), ("at", DESCENDING)])
    await db.comments.create_index([("incidentId", ASCENDING), ("createdAt", ASCENDING)])
    await db.users.create_index("email", unique=True)
    await db.users.create_index("itsmLogin")
    # одно живое имя команды; удалённое имя можно занять заново
    await db.teams.create_index("name", unique=True, partialFilterExpression={"deletedAt": None})
    # одна нерассмотренная заявка на почту; отклонённую можно подать заново
    await db.registration_requests.create_index("email", unique=True, partialFilterExpression={"status": "pending"})
    await db.incidents.create_index("data.assignedEmployeeLogin")
    await db.incidents.create_index("members")
    await db.devices.create_index("userId")
    await db.notifications.create_index([("userId", ASCENDING), ("readAt", ASCENDING), ("createdAt", DESCENDING)])
    await db.import_runs.create_index([("startedAt", DESCENDING)])
    # чат с ИИ-агентом: список сессий пользователя и история сообщений сессии
    await db.chat_sessions.create_index([("userId", ASCENDING), ("updatedAt", DESCENDING)])
    await db.chat_messages.create_index([("sessionId", ASCENDING), ("createdAt", ASCENDING)])
    await db.chat_files.create_index("userId")
