"""Справочники предметной области.

ВАЖНО про статусы. В файле атрибутов написано «7 — Закрыт, 10 — Завершен», но в самих данных
и в ответе организаторов наоборот: 7 = Завершен (Resolved), 10 = Закрыт (Closed).
Ориентируемся на данные + ответ организаторов.
Статус 20 «Исследование ситуации» (Research) в файле атрибутов отсутствует, но есть в данных
и является одной из четырёх обязательных групп кейса.
"""

from enum import StrEnum


class Role(StrEnum):
    ADMIN = "admin"
    COORDINATOR = "coordinator"
    VIEWER = "viewer"
    # разработчик видит только «свои» инциденты: где он исполнитель в ITSM (assignedEmployeeLogin)
    # или куда его явно добавил координатор (members)
    DEVELOPER = "developer"


STAFF_ROLES = frozenset({Role.ADMIN, Role.COORDINATOR, Role.VIEWER})


class Group(StrEnum):
    """Четыре группы дашборда из кейса. Один инцидент может быть в нескольких."""

    CRITICAL = "critical"
    COORDINATORS = "coordinators"
    HIGH = "high"
    RESEARCH = "research"


GROUP_TITLES: dict[Group, str] = {
    Group.CRITICAL: "Критические",
    Group.COORDINATORS: "Назначены на координаторов",
    Group.HIGH: "Высокий приоритет",
    Group.RESEARCH: "Исследование ситуации",
}

ASSIGNED, IN_PROGRESS, RESOLVED, CLOSED, RESEARCH = 0, 2, 7, 10, 20

# stateId -> (текст, stateEnum)
STATES: dict[int, tuple[str, str]] = {
    ASSIGNED: ("Назначен", "Assigned"),
    IN_PROGRESS: ("Выполняется", "WorkInProgress"),
    RESEARCH: ("Исследование ситуации", "Research"),
    RESOLVED: ("Завершен", "Resolved"),
    CLOSED: ("Закрыт", "Closed"),
}
# Проблема устранена (для Research: «инцидент уже решён, идёт разбор причин»)
RESOLVED_STATE_IDS = frozenset({RESOLVED, CLOSED, RESEARCH})
# Не требуют внимания координатора. Research требует — это отдельная группа.
INACTIVE_STATE_IDS = frozenset({RESOLVED, CLOSED})
# Работа полностью закончена, вернуть нельзя — только новый инцидент
FINAL_STATE_IDS = frozenset({CLOSED})

# Разрешённые переходы для канбана (альтернативный сценарий взаимодействия).
# Завершен -> Выполняется: «проблема может остаться, инцидент возвращают в работу».
TRANSITIONS: dict[int, frozenset[int]] = {
    ASSIGNED: frozenset({IN_PROGRESS, RESOLVED}),
    IN_PROGRESS: frozenset({ASSIGNED, RESOLVED, RESEARCH}),
    RESEARCH: frozenset({RESOLVED, IN_PROGRESS}),
    RESOLVED: frozenset({CLOSED, IN_PROGRESS}),
    CLOSED: frozenset(),
}

PRIORITIES: dict[int, str] = {1: "Низкий", 2: "Средний", 3: "Высокий", 4: "Наивысший"}
# текст -> id; в т.ч. синонимы, которые могут написать руками при правке файла на демо
PRIORITY_BY_TEXT: dict[str, int] = {
    "низкий": 1,
    "средний": 2,
    "высокий": 3,
    "наивысший": 4,
    "критический": 4,
}
STATE_BY_TEXT: dict[str, int] = {}
for _sid, (_text, _enum) in STATES.items():
    STATE_BY_TEXT[_text.lower()] = _sid
    STATE_BY_TEXT[_enum.lower()] = _sid
STATE_BY_TEXT["завершён"] = RESOLVED

SLA_RANK = {"breached": 0, "danger": 1, "warning": 2, "ok": 3, "none": 4, "resolved": 5}
