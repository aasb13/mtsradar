"""Распределение новых инцидентов на координаторов.

Новый инцидент попадает не в общую очередь, а конкретному человеку — «дежурному
координатору»: пока у него неразобранных меньше DUTY_CAP, весь поток идёт ему.
Координатор видит такие инциденты в разделе «Ваши инциденты» и передаёт команде
(назначение команды через PATCH закрывает маршрут — route.doneAt в incident_actions).

Разобранным считается инцидент с route.doneAt; разбирает тот, кому назначили команду —
не обязательно тот, кому инцидент был распределён (за смену могли подменить).
"""

from datetime import UTC, datetime
from typing import Any

from app.db.mongo import get_db
from app.domain.enums import Role

# сколько неразобранных может копиться у дежурного, прежде чем поток уйдёт следующему
DUTY_CAP = 20


def _pending_query(user_id: str) -> dict[str, Any]:
    return {"route.userId": user_id, "route.doneAt": None, "meta.deletedAt": None, "meta.isActive": True}


async def new_route() -> dict[str, Any] | None:
    """Кому распределить новый инцидент. None — координаторов нет, инцидент остаётся в общей очереди.

    Дежурным остаётся тот, кто получил последний маршрут, пока его очередь не переполнена;
    иначе берём наименее загруженного (при равенстве — раньше заведённого в системе).
    """
    db = get_db()
    coordinators = [u async for u in db.users.find({"role": Role.COORDINATOR, "deletedAt": None})]
    if not coordinators:
        return None
    by_id = {u["_id"]: u for u in coordinators}
    last = await db.incidents.find_one(
        {"route.userId": {"$in": list(by_id)}, "meta.deletedAt": None},
        sort=[("route.at", -1)],
    )
    duty = by_id.get(last["route"]["userId"]) if last else None
    if duty is not None and await db.incidents.count_documents(_pending_query(duty["_id"])) < DUTY_CAP:
        picked = duty
    else:
        for u in coordinators:
            u["pending"] = await db.incidents.count_documents(_pending_query(u["_id"]))

        def load_key(u: dict[str, Any]) -> tuple[int, datetime, str]:
            return (u["pending"], u.get("createdAt") or datetime.max.replace(tzinfo=UTC), u.get("fullName") or "")

        picked = min(coordinators, key=load_key)
    return {"userId": picked["_id"], "name": picked.get("fullName"), "at": datetime.now(UTC), "doneAt": None}
