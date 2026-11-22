"""Построение Mongo-запросов для списков инцидентов.

Общий код для REST (routes/incidents.py) и ИИ-агента (app/ai/chat_tools.py), чтобы
поиск агента фильтровал ровно так же, как поиск в интерфейсе.
"""

import re
from typing import Any, Literal

from app.domain.enums import Group


def build_filters(
    *,
    priorityId: list[int] | None = None,
    stateId: list[int] | None = None,
    assignedGroupName: str | None = None,
    productName: str | None = None,
    q: str | None = None,
    group: Group | None = None,
    active: bool | None = None,
    includeDeleted: bool = False,
) -> dict[str, Any]:
    query: dict[str, Any] = {} if includeDeleted else {"meta.deletedAt": None}
    if priorityId:
        query["data.priorityId"] = {"$in": priorityId}
    if stateId:
        query["data.stateId"] = {"$in": stateId}
    if assignedGroupName:
        query["data.assignedGroupName"] = assignedGroupName
    if productName:
        query["data.productName"] = productName
    if group:
        query["meta.groups"] = group.value
    if active is not None:
        query["meta.isActive"] = active
    if q:
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        query["$or"] = [{"_id": rx}, {"data.header": rx}, {"data.description": rx}, {"data.service": rx}]
    return query


SortKey = Literal["attention", "deadline", "submitDate", "priority"]
