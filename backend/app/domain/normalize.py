"""Приём записи в формате ITSM-выгрузки (как в файле организаторов) и приведение её к виду для хранения.

Принципы:
* Формат файла — «родной» формат системы. Поля и их имена не переименовываем,
  чтобы экспорт возвращал ровно тот же формат. Неизвестные поля сохраняем (extra="allow").
* Даты -> datetime в UTC с точностью до миллисекунд (так хранит MongoDB; иначе каждый
  повторный импорт видел бы «изменение» в полях с микросекундами).
* "0001-01-01T00:00:00" в waitingExitDate — «пустое значение», превращаем в null.
* Текстовые поля, дублирующие id (state/stateId, priority/priorityId), сверяем:
  при правке файла руками легко поменять одно и забыть другое.
"""

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.domain.enums import (
    ASSIGNED,
    IN_PROGRESS,
    PRIORITIES,
    PRIORITY_BY_TEXT,
    STATE_BY_TEXT,
    STATES,
)

DATETIME_FIELDS = (
    "submitDate",
    "deadline",
    "completionDate",
    "lastAssignmentToTeamDateTime",
    "waitingExitDate",
)


def to_ms_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    value = value.astimezone(UTC)
    return value.replace(microsecond=value.microsecond // 1000 * 1000)


def format_dt(value: datetime | None) -> str | None:
    """Обратное преобразование для экспорта: 2026-11-08T12:02:29Z (или .123Z при наличии мс)."""
    if value is None:
        return None
    value = value.astimezone(UTC)
    base = value.strftime("%Y-%m-%dT%H:%M:%S")
    if value.microsecond:
        base += f".{value.microsecond // 1000:03d}"
    return base + "Z"


class ItsmIncident(BaseModel):
    """Одна запись выгрузки. Обязательный минимум: id, stateId, priorityId, submitDate."""

    model_config = ConfigDict(extra="allow")

    sysId: str | None = None
    id: str = Field(min_length=1, max_length=64)
    state: str | None = None
    stateEnum: str | None = None
    stateId: int
    stateReason: str | None = None
    stateReasonId: str | None = None
    submitDate: datetime
    deadline: datetime | None = None
    completionDate: datetime | None = None
    lastAssignmentToTeamDateTime: datetime | None = None
    header: str = ""
    description: str | None = None
    shortDescription: str | None = None
    assignedGroupName: str | None = None
    assignedEmployee: str | None = None
    assignedEmployeeLogin: str | None = None
    initiatorName: str | None = None
    initiatorLogin: str | None = None
    isEffect: bool | None = None
    isReason: bool | None = None
    isDouble: bool | None = None
    isMaster: bool | None = None
    incType: str | None = None
    serviceTypeId: int | None = None
    serviceType: str | None = None
    priorityId: int
    priority: str | None = None
    urgencyId: int | None = None
    urgency: str | None = None
    impactId: int | None = None
    impact: str | None = None
    waitingExitDate: datetime | None = None
    isRootIncident: bool | None = None
    productName: str | None = None
    productId: str | None = None
    productMasterId: str | None = None
    productUrl: str | None = None
    service: str | None = None
    serviceId: str | None = None
    scenarioName: str | None = None
    isNeedUp: bool | None = None
    eliminationType: Any = None
    eliminationTypeId: Any = None
    receivingChannel: str | None = None
    solution: str | None = None

    @field_validator(*DATETIME_FIELDS, mode="before")
    @classmethod
    def _empty_dates(cls, v: Any) -> Any:
        if v in (None, ""):
            return None
        if isinstance(v, str) and v.startswith("0001-01-01"):
            return None
        return v

    @field_validator(*DATETIME_FIELDS, mode="after")
    @classmethod
    def _utc_ms(cls, v: datetime | None) -> datetime | None:
        return to_ms_utc(v)

    @field_validator("isNeedUp", "isEffect", "isReason", "isDouble", "isMaster", mode="before")
    @classmethod
    def _ru_bool(cls, v: Any) -> Any:
        if isinstance(v, str):
            low = v.strip().lower()
            if low in ("да", "yes", "true"):
                return True
            if low in ("нет", "no", "false"):
                return False
            if low == "":
                return None
        return v

    @field_validator("id", mode="after")
    @classmethod
    def _strip_id(cls, v: str) -> str:
        return v.strip()


def to_storage(model: ItsmIncident) -> dict[str, Any]:
    """Словарь для поля `data` документа в Mongo (порядок ключей сохраняется)."""
    return model.model_dump()


def reconcile_codes(data: dict[str, Any], prev: dict[str, Any] | None) -> list[str]:
    """Сверяет пары id/текст. Правило: если человек поменял только текст — верим тексту,
    иначе верим id и подправляем текст. Возвращает список предупреждений."""
    warnings: list[str] = []

    # --- статус ---
    sid, text = data.get("stateId"), (data.get("state") or "").strip()
    text_sid = STATE_BY_TEXT.get(text.lower()) if text else None
    if text_sid is not None and text_sid != sid:
        only_text_changed = prev is not None and prev.get("stateId") == sid and prev.get("state") != data.get("state")
        if only_text_changed:
            warnings.append(f"state='{text}' не совпадал со stateId={sid}; взят stateId={text_sid} по тексту")
            data["stateId"] = sid = text_sid
        else:
            warnings.append(f"state='{text}' не совпадал со stateId={sid}; текст исправлен по stateId")
    if sid in STATES:
        data["state"], data["stateEnum"] = STATES[sid]
    else:
        warnings.append(f"неизвестный stateId={sid}; инцидент считается активным")

    # --- приоритет ---
    pid, ptext = data.get("priorityId"), (data.get("priority") or "").strip()
    text_pid = PRIORITY_BY_TEXT.get(ptext.lower()) if ptext else None
    if text_pid is not None and text_pid != pid:
        only_text_changed = (
            prev is not None and prev.get("priorityId") == pid and prev.get("priority") != data.get("priority")
        )
        if only_text_changed:
            warnings.append(f"priority='{ptext}' не совпадал с priorityId={pid}; взят priorityId={text_pid} по тексту")
            data["priorityId"] = pid = text_pid
        else:
            warnings.append(f"priority='{ptext}' не совпадал с priorityId={pid}; текст исправлен по priorityId")
    if pid in PRIORITIES:
        data["priority"] = PRIORITIES[pid]
    else:
        warnings.append(f"неизвестный priorityId={pid}")
    return warnings


def sanitize(data: dict[str, Any]) -> list[str]:
    """Правила целостности, подтверждённые организаторами."""
    warnings: list[str] = []
    # «Там где state назначен или выполняется, не должно быть заполненного solution»
    if data.get("stateId") in (ASSIGNED, IN_PROGRESS) and data.get("solution"):
        data["solution"] = None
        warnings.append("solution очищен: у инцидента в статусе Назначен/Выполняется решения быть не должно")
    return warnings
