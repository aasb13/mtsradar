"""MongoDB через официальный асинхронный драйвер PyMongo (Motor объявлен устаревшим).

Коллекции:
  incidents       {_id: "INC...", data: {...запись ITSM как в файле...}, meta: {...}, ai: {...}, ack: {...}}
  incident_events история изменений (путь инцидента)
  comments        заметки координаторов
  users           пользователи нашей системы (координаторы, админы)
  notifications   центр уведомлений (колокольчик)
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
    await db.incidents.create_index("data.assignedEmployeeLogin")
    await db.incidents.create_index("members")
    await db.devices.create_index("userId")
    await db.notifications.create_index([("userId", ASCENDING), ("readAt", ASCENDING), ("createdAt", DESCENDING)])
    await db.import_runs.create_index([("startedAt", DESCENDING)])
