"""Redis. Что в нём лежит и зачем (всё — короткоживущее, потеря не страшна):

refresh:{jti}            -> user_id   белый список refresh-токенов (logout = удаление ключа)
rl:login:{ip}            -> счётчик   ограничение попыток входа
lock:import              -> lock      импорт файла выполняется строго по одному
import:last_hash         -> sha256    не импортировать один и тот же файл дважды
evt:seen:{consumer}:{id} -> 1         идемпотентность потребителей RabbitMQ (at-least-once)
sla:notified:{...}       -> 1         SLA-оповещение по инциденту отправляется один раз
"""

from redis.asyncio import Redis

from app.core.config import get_settings

_redis: Redis | None = None


def get_redis() -> Redis:
    global _redis
    if _redis is None:
        _redis = Redis.from_url(get_settings().redis_url, decode_responses=True)
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


async def seen_before(consumer: str, event_id: str, ttl_sec: int = 24 * 3600) -> bool:
    """True, если событие уже обработано этим потребителем."""
    created = await get_redis().set(f"evt:seen:{consumer}:{event_id}", "1", nx=True, ex=ttl_sec)
    return not created
