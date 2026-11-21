"""HTML-страницы муляжа ITSM: /itsm (список) и /itsm/incident/{id} (карточка с формой правки).

Без авторизации — это муляж для демонстрации. Отключается через ITSM_MOCK_ENABLED=false.
Страница открывается в новой вкладке по ссылке `itsmUrl` из карточки дашборда.
"""

import re
from datetime import datetime
from html import escape
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Form, HTTPException, Query, status
from fastapi.responses import HTMLResponse, RedirectResponse

from app.core.config import get_settings
from app.db.mongo import get_db
from app.domain.enums import PRIORITIES, STATES
from app.services.itsm_mock import MockItsmError, edit_incident
from app.services.store import get_doc

router = APIRouter(prefix="/itsm", tags=["itsm-mock"], include_in_schema=False)

LABELS = {
    "id": "Номер",
    "header": "Заголовок",
    "shortDescription": "Кратко",
    "description": "Описание",
    "productName": "Продукт",
    "productMasterId": "Код продукта",
    "service": "Сервис",
    "scenarioName": "Сценарий",
    "serviceType": "Тип сервиса",
    "state": "Статус",
    "stateReason": "Подстатус",
    "priority": "Приоритет",
    "impact": "Влияние",
    "urgency": "Срочность",
    "submitDate": "Зарегистрирован",
    "deadline": "Срок решения",
    "completionDate": "Время решения",
    "lastAssignmentToTeamDateTime": "Последнее назначение",
    "assignedGroupName": "Группа назначения",
    "assignedEmployee": "Исполнитель",
    "initiatorName": "Инициатор",
    "receivingChannel": "Канал регистрации",
    "isMaster": "Мастер-инцидент",
    "isDouble": "Дубль",
    "isEffect": "Причина дочерних",
    "isReason": "Дочерний",
    "isNeedUp": "Нужно устранение последствий",
    "solution": "Решение",
}

SOURCES = {"file": "выгрузка", "api": "дашборд", "ingest": "ITSM API", "system": "система"}
EVENT_TYPES = {
    "created": "Создан",
    "updated": "Изменён",
    "removed": "В архиве",
    "restored": "Восстановлен",
    "acknowledged": "Подтверждён координатором",
}

CSS = """
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
color:#1d1d1f;background:#eef0f3}a{color:#0a5bd8;text-decoration:none}a:hover{text-decoration:underline}
.top{background:#2b3440;color:#fff;padding:10px 24px;display:flex;gap:16px;align-items:center}
.top b{font-size:15px}.mock{background:#f5c518;color:#1d1d1f;font-size:12px;font-weight:600;
padding:2px 8px;border-radius:4px}.top .sp{flex:1}.top a{color:#cfe0ff}
.wrap{max-width:1200px;margin:20px auto;padding:0 24px}
.card{background:#fff;border:1px solid #d9dde3;border-radius:6px;padding:16px 20px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px;color:#4a5462}
.sub{color:#6b7480}.grid{display:grid;grid-template-columns:1fr 360px;gap:16px}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid #eceff3;
vertical-align:top;text-align:left}th{width:38%;color:#6b7480;font-weight:500}
.list td,.list th{width:auto}.list tr:hover td{background:#f6f8fb}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;background:#e6e9ee}
.p4{background:#fde2e1;color:#b3060f}.p3{background:#ffe9d6;color:#a84300}
label{display:block;font-size:12px;color:#6b7480;margin:10px 0 3px}
input,select,textarea{width:100%;padding:7px 8px;border:1px solid #c9cfd8;border-radius:4px;font:inherit;
background:#fff}
textarea{min-height:70px}button{margin-top:14px;width:100%;padding:9px;border:0;border-radius:4px;
background:#0a5bd8;color:#fff;font-weight:600;cursor:pointer}button:hover{background:#0848ad}
.ok{background:#e3f6e8;border:1px solid #9bd8ab;color:#145c2a;padding:10px 14px;border-radius:6px;margin-bottom:16px}
.err{background:#fde2e1;border:1px solid #f1a19d;color:#8a0a10;padding:10px 14px;border-radius:6px;margin-bottom:16px}
.hist li{margin-bottom:8px}.hist{padding-left:18px;margin:0}.muted{color:#8e959f;font-size:12px}
.search{display:flex;gap:8px}.search input{flex:1}.search button{width:auto;margin:0;padding:7px 16px}
"""


def _tz() -> ZoneInfo:
    return ZoneInfo(get_settings().business_tz)


def _fmt(value: Any) -> str:
    if value is None or value == "":
        return '<span class="muted">—</span>'
    if isinstance(value, bool):
        return "Да" if value else "Нет"
    if isinstance(value, datetime):
        return escape(value.astimezone(_tz()).strftime("%d.%m.%Y %H:%M"))
    return escape(str(value))


def _page(title: str, body: str) -> HTMLResponse:
    s = get_settings()
    html = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)}</title>
<style>{CSS}</style></head><body>
<div class="top"><b>ITSM</b><span class="mock">муляж для демонстрации</span>
<a href="/itsm">Все инциденты</a><span class="sp"></span><a href="{escape(s.dashboard_url)}">← на дашборд</a></div>
<div class="wrap">{body}</div></body></html>"""
    return HTMLResponse(html)


def _prio_badge(pid: int | None, text: str | None) -> str:
    cls = {4: "p4", 3: "p3"}.get(pid or 0, "")
    return f'<span class="badge {cls}">{escape(text or str(pid))}</span>'


@router.get("", response_class=HTMLResponse)
async def itsm_list(q: str | None = Query(None)) -> HTMLResponse:
    query: dict[str, Any] = {"meta.deletedAt": None}
    if q:
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        query["$or"] = [{"_id": rx}, {"data.header": rx}]
    rows = []
    async for d in get_db().incidents.find(query).sort("data.submitDate", -1).limit(500):
        x = d["data"]
        rows.append(
            f'<tr><td><a href="/itsm/incident/{quote(d["_id"])}">{escape(d["_id"])}</a></td>'
            f"<td>{_fmt(x.get('header'))}</td><td>{_fmt(x.get('productName'))}</td>"
            f"<td>{_prio_badge(x.get('priorityId'), x.get('priority'))}</td><td>{_fmt(x.get('state'))}</td>"
            f"<td>{_fmt(x.get('assignedGroupName'))}</td><td>{_fmt(x.get('deadline'))}</td></tr>"
        )
    body = f"""<div class="card"><h1>Инциденты</h1>
<form class="search" method="get"><input name="q" value="{escape(q or "")}" placeholder="Номер или заголовок">
<button>Найти</button></form></div>
<div class="card"><table class="list"><tr><th>Номер</th><th>Заголовок</th><th>Продукт</th><th>Приоритет</th>
<th>Статус</th><th>Группа</th><th>Срок</th></tr>{"".join(rows)}</table></div>"""
    return _page("ITSM · инциденты", body)


@router.get("/incident/{incident_id}", response_class=HTMLResponse)
async def itsm_incident(incident_id: str, saved: str | None = None, error: str | None = None) -> HTMLResponse:
    doc = await get_doc(incident_id)
    if not doc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Инцидент не найден")
    x = doc["data"]
    groups = sorted(g for g in await get_db().incidents.distinct("data.assignedGroupName") if g)
    s = get_settings()
    if s.coordinators_group_name not in groups:
        groups.insert(0, s.coordinators_group_name)

    fields = "".join(f"<tr><th>{escape(label)}</th><td>{_fmt(x.get(key))}</td></tr>" for key, label in LABELS.items())
    state_opts = "".join(
        f'<option value="{sid}"{" selected" if sid == x.get("stateId") else ""}>{escape(name)}</option>'
        for sid, (name, _) in STATES.items()
    )
    prio_opts = "".join(
        f'<option value="{pid}"{" selected" if pid == x.get("priorityId") else ""}>{escape(name)}</option>'
        for pid, name in PRIORITIES.items()
    )
    group_opts = "".join(f'<option value="{escape(g)}">' for g in groups)
    deadline_val = x["deadline"].astimezone(_tz()).strftime("%Y-%m-%dT%H:%M") if x.get("deadline") else ""

    history = []
    async for e in get_db().incident_events.find({"incidentId": incident_id}).sort("at", -1).limit(15):
        changes = ", ".join(
            f"{escape(LABELS.get(c['field'], c['field']))}: {_fmt(c['old'])} → {_fmt(c['new'])}"
            for c in e.get("changes", [])
            if c["field"] not in ("stateEnum", "priorityId", "stateId")
        )
        who = escape(
            (e.get("actor") or {}).get("name") or {"file": "выгрузка", "api": "дашборд"}.get(e["source"], e["source"])
        )
        history.append(
            f"<li><b>{escape(EVENT_TYPES.get(e['type'], e['type']))}</b> · {_fmt(e['at'])} · {who}<br>"
            f"<span class='muted'>{changes}</span></li>"
        )

    notice = ""
    if saved is not None:
        notice = (
            '<div class="ok">Сохранено. Изменение записано в выгрузку и уже ушло на дашборд.</div>'
            if saved
            else '<div class="ok">Изменений нет.</div>'
        )
    if error:
        notice = f'<div class="err">Не удалось сохранить: {escape(error)}</div>'

    body = f"""{notice}
<div class="card"><h1>{escape(incident_id)} · {_fmt(x.get("header"))}</h1>
<div class="sub">{_fmt(x.get("productName"))} · {_prio_badge(x.get("priorityId"), x.get("priority"))}
 · {_fmt(x.get("state"))}</div></div>
<div class="grid">
  <div class="card"><h2>Карточка</h2><table>{fields}</table></div>
  <div>
    <div class="card"><h2>Изменить</h2>
      <form method="post" action="/itsm/incident/{quote(incident_id)}">
        <label>Статус</label><select name="stateId">{state_opts}</select>
        <label>Приоритет</label><select name="priorityId">{prio_opts}</select>
        <label>Группа назначения</label>
        <input name="assignedGroupName" list="groups" value="{escape(x.get("assignedGroupName") or "")}">
        <datalist id="groups">{group_opts}</datalist>
        <label>Исполнитель</label><input name="assignedEmployee" value="{escape(x.get("assignedEmployee") or "")}">
        <label>Срок решения ({escape(s.business_tz)})</label>
        <input type="datetime-local" name="deadline" value="{deadline_val}">
        <label>Подстатус</label><input name="stateReason" value="{escape(x.get("stateReason") or "")}">
        <label>Решение</label><textarea name="solution">{escape(x.get("solution") or "")}</textarea>
        <button>Сохранить</button>
      </form></div>
    <div class="card"><h2>История</h2><ul class="hist">{"".join(history) or "<li class='muted'>пусто</li>"}</ul></div>
  </div>
</div>"""
    return _page(f"{incident_id} · ITSM", body)


@router.post("/incident/{incident_id}")
async def itsm_save(
    incident_id: str,
    stateId: int = Form(...),
    priorityId: int = Form(...),
    assignedGroupName: str = Form(""),
    assignedEmployee: str = Form(""),
    deadline: str = Form(""),
    stateReason: str = Form(""),
    solution: str = Form(""),
) -> RedirectResponse:
    base = f"/itsm/incident/{quote(incident_id)}"
    try:
        if stateId not in STATES or priorityId not in PRIORITIES:
            raise MockItsmError("неизвестный статус или приоритет")
        form: dict[str, Any] = {
            "stateId": stateId,
            "priorityId": priorityId,
            "assignedGroupName": assignedGroupName,
            "assignedEmployee": assignedEmployee,
            "stateReason": stateReason,
            "solution": solution,
        }
        if deadline:
            form["deadline"] = datetime.fromisoformat(deadline).replace(tzinfo=_tz())
        changed = await edit_incident(incident_id, form)
    except (MockItsmError, ValueError) as e:
        return RedirectResponse(f"{base}?error={quote(str(e))}", status_code=303)
    return RedirectResponse(f"{base}?saved={'1' if changed else ''}", status_code=303)
