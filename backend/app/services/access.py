"""Кто какие инциденты видит.

  admin / coordinator / viewer — все инциденты;
  developer — только «свои»: где он исполнитель в ITSM (data.assignedEmployeeLogin == itsmLogin)
              или куда его добавил координатор (members содержит его id).

Одни и те же правила используются в REST (mongo_filter, can_view) и в WebSocket (card_visible),
чтобы разработчику не уходили события о чужих инцидентах.
"""

from typing import Any

from app.domain.enums import Role


def is_developer(user: dict[str, Any]) -> bool:
    return user.get("role") == Role.DEVELOPER


def mongo_filter(user: dict[str, Any]) -> dict[str, Any]:
    if not is_developer(user):
        return {}
    ors: list[dict[str, Any]] = [{"members": user["_id"]}]
    if user.get("itsmLogin"):
        ors.append({"data.assignedEmployeeLogin": user["itsmLogin"]})
    return {"$or": ors}


def can_view(user: dict[str, Any], doc: dict[str, Any]) -> bool:
    if not is_developer(user):
        return True
    login = user.get("itsmLogin")
    return user["_id"] in (doc.get("members") or []) or bool(
        login and doc.get("data", {}).get("assignedEmployeeLogin") == login
    )


def card_visible(user: dict[str, Any], card: dict[str, Any] | None) -> bool:
    """То же по карточке из события (в ней есть assignedEmployeeLogin и members)."""
    if not is_developer(user):
        return True
    if not card:
        return False
    login = user.get("itsmLogin")
    return user["_id"] in (card.get("members") or []) or bool(login and card.get("assignedEmployeeLogin") == login)
