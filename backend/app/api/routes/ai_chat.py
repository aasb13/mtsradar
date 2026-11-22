"""Чат с ИИ-агентом BigDad: сессии, сообщения, вложения.

Агент работает от имени пользователя: инструменты из app/ai/chat_tools.py исполняют тот же
слой действий, что REST, и проверяют те же права. Вложения хранятся в Mongo (chat_files);
текстовые файлы получают превью, которое уходит модели вместе с сообщением.
Ответ агента стримится (SSE, POST /ai/chat/sessions/{sid}/messages): события
user → start → text*/tool* → done, при сбое — error. По завершении публикуется событие
chat.user.{userId} — открытые в других вкладках чаты подхватят итог по WebSocket.
"""

import json
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from app.ai import agent as ai_agent
from app.ai import llm
from app.ai.chat_tools import chat_tools
from app.ai.llm import LlmError
from app.ai.prompts import chat_system_message
from app.ai.tools import ToolContext
from app.api.deps import CurrentUser
from app.api.routes.ai import _http_error, _known_groups
from app.bus import rabbit
from app.core.config import get_settings
from app.db.mongo import get_db
from app.services import access
from app.services.store import get_doc

router = APIRouter(tags=["ai-chat"])

FILE_MAX_BYTES = 10 * 1024 * 1024
MAX_FILES_PER_MESSAGE = 5
TEXT_PREVIEW_CHARS = 8000
MAX_MESSAGE_CHARS = 8000
MAX_HISTORY_TO_MODEL = 10
SESSIONS_LIST_LIMIT = 100
MESSAGES_LIST_LIMIT = 500
TEXT_SUFFIXES = (".txt", ".csv", ".json", ".md", ".log", ".xml", ".yaml", ".yml")
UNTITLED = "Новый чат"


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _snippet(text: str, limit: int = 60) -> str:
    flat = " ".join(text.split())
    return flat[:limit] + ("…" if len(flat) > limit else "")


def _is_text_like(name: str, content_type: str | None) -> bool:
    if content_type and content_type.startswith("text/"):
        return True
    if content_type in ("application/json", "application/xml", "application/yaml"):
        return True
    return name.lower().endswith(TEXT_SUFFIXES)


def _public_message(m: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": m["_id"],
        "sessionId": m["sessionId"],
        "role": m["role"],
        "text": m["text"],
        "attachments": m.get("attachments") or [],
        "replyTo": m.get("replyTo"),
        "actions": m.get("actions") or [],
        "createdAt": _iso(m["createdAt"]),
    }


def _public_session(s: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": s["_id"],
        "title": s["title"],
        "incidentId": s.get("incidentId"),
        "createdAt": _iso(s["createdAt"]),
        "updatedAt": _iso(s["updatedAt"]),
    }


async def _resolve_attachments(user: dict[str, Any], ids: list[str]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Метаданные вложений сообщения + превью текстовых файлов для модели."""
    files: list[dict[str, Any]] = []
    previews: dict[str, str] = {}
    for fid in ids:
        f = await get_db().chat_files.find_one({"_id": fid, "userId": user["_id"]})
        if f is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Вложение не найдено")
        files.append({"id": f["_id"], "name": f["name"], "size": f["size"]})
        if f.get("preview"):
            previews[f["name"]] = f["preview"]
    return files, previews


def _user_content(
    text: str,
    attachments: list[dict[str, Any]],
    previews: dict[str, str],
    reply_to: dict[str, Any] | None,
) -> str:
    """Сообщение пользователя в том виде, в каком его видит модель."""
    parts: list[str] = []
    if reply_to:
        parts.append(f"(В ответ на ваше сообщение: «{reply_to['snippet']}»)")
    parts.append(text)
    if attachments:
        lines = ["Вложения пользователя:"]
        for a in attachments:
            preview = previews.get(a["name"])
            if preview:
                lines.append(f"Файл «{a['name']}» ({a['size']} байт):\n<файл>\n{preview}\n</файл>")
            else:
                lines.append(f"Файл «{a['name']}» ({a['size']} байт) — текст недоступен, только метаданные.")
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


async def _agent_events(
    user: dict[str, Any], session: dict[str, Any], current_content: str
) -> AsyncIterator[dict[str, Any]]:
    """Прогон агента по истории сессии; отдаёт события text/tool/final без сохранения."""
    s = get_settings()
    all_docs = [d async for d in get_db().chat_messages.find({"sessionId": session["_id"]}).sort("createdAt", 1)]
    past = [d for d in all_docs if d["role"] in ("user", "assistant")][:-1]  # без текущего сообщения
    history: list[dict[str, str]] = []
    for m in past[-MAX_HISTORY_TO_MODEL:]:
        content = m["text"]
        if m["role"] == "user":
            if m.get("replyTo"):
                content = f"(в ответ на ваше сообщение: «{m['replyTo']['snippet']}»)\n\n{content}"
            names = [a["name"] for a in m.get("attachments") or []]
            if names:
                content += f"\n\n(к сообщению приложены файлы: {', '.join(names)})"
        history.append({"role": m["role"], "content": content})

    incident_doc = None
    if session.get("incidentId"):
        doc = await get_doc(session["incidentId"])
        if doc and not doc["meta"].get("deletedAt") and access.can_view(user, doc):
            incident_doc = doc

    ctx = ToolContext(now=_now(), settings=s, known_groups=await _known_groups(), user=user)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": chat_system_message(user, incident_doc)},
        *history,
        {"role": "user", "content": current_content},
    ]
    async for event in ai_agent.run_chat_agent_stream(messages, chat_tools(ctx)):
        yield event


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _own_session_or_404(sid: str, user: dict[str, Any]) -> dict[str, Any]:
    session = await get_db().chat_sessions.find_one({"_id": sid, "userId": user["_id"]})
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сессия не найдена")
    return session


def _ensure_llm() -> None:
    try:
        llm.ensure_configured()
    except LlmError as e:
        raise _http_error(e) from e


# ---------------- сессии ----------------


@router.get("/ai/chat/sessions")
async def list_sessions(user: CurrentUser) -> dict[str, Any]:
    docs = [
        d
        async for d in get_db()
        .chat_sessions.find({"userId": user["_id"]})
        .sort("updatedAt", -1)
        .limit(SESSIONS_LIST_LIMIT)
    ]
    return {"items": [_public_session(d) for d in docs]}


class SessionIn(BaseModel):
    incidentId: str | None = None


@router.post("/ai/chat/sessions", status_code=201)
async def create_session(body: SessionIn, user: CurrentUser) -> dict[str, Any]:
    """Пустая сессия; первое сообщение уходит через стрим /messages."""
    _ensure_llm()
    now = _now()
    session = {
        "_id": uuid.uuid4().hex,
        "userId": user["_id"],
        "title": UNTITLED,
        "incidentId": body.incidentId or None,
        "createdAt": now,
        "updatedAt": now,
    }
    if body.incidentId:
        doc = await get_doc(body.incidentId)
        if doc is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Инцидент не найден")
    await get_db().chat_sessions.insert_one(session)
    return {"session": _public_session(session)}


@router.get("/ai/chat/sessions/{sid}")
async def get_session(sid: str, user: CurrentUser) -> dict[str, Any]:
    session = await _own_session_or_404(sid, user)
    docs = [
        d
        async for d in get_db()
        .chat_messages.find({"sessionId": sid})
        .sort("createdAt", 1)
        .limit(MESSAGES_LIST_LIMIT)
    ]
    return {"session": _public_session(session), "messages": [_public_message(d) for d in docs]}


@router.delete("/ai/chat/sessions/{sid}", status_code=204)
async def delete_session(sid: str, user: CurrentUser) -> None:
    res = await get_db().chat_sessions.delete_one({"_id": sid, "userId": user["_id"]})
    if res.deleted_count == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Сессия не найдена")
    await get_db().chat_messages.delete_many({"sessionId": sid})


# ---------------- сообщения ----------------


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    attachmentIds: list[str] = Field(default_factory=list, max_length=MAX_FILES_PER_MESSAGE)
    replyToMessageId: str | None = None


@router.post("/ai/chat/sessions/{sid}/messages")
async def send_message(sid: str, body: MessageIn, user: CurrentUser) -> StreamingResponse:
    """Сообщение пользователя + стрим ответа агента (SSE).

    События: user (сообщение сохранено), start (id ответа), text (кусок ответа),
    tool (шаг вызова инструмента), done (итоговое сообщение ассистента + сессия),
    error (сбой агента — сообщение пользователя уже сохранено).
    """
    _ensure_llm()
    session = await _own_session_or_404(sid, user)
    reply_to = None
    if body.replyToMessageId:
        target = await get_db().chat_messages.find_one({"_id": body.replyToMessageId, "sessionId": sid})
        if target is not None:
            reply_to = {"messageId": target["_id"], "snippet": _snippet(target["text"], 120)}
    files, previews = await _resolve_attachments(user, body.attachmentIds)
    text = body.text.strip()
    now = _now()
    user_doc = {
        "_id": uuid.uuid4().hex,
        "sessionId": sid,
        "userId": user["_id"],
        "role": "user",
        "text": text,
        "attachments": files,
        "replyTo": reply_to,
        "actions": [],
        "createdAt": now,
    }
    await get_db().chat_messages.insert_one(user_doc)
    # заголовок ставим сразу по первому сообщению: сессия узнаваема в списке, не дожидаясь агента
    title = _snippet(text) if session["title"] in (UNTITLED, "") else session["title"]
    await get_db().chat_sessions.update_one({"_id": sid}, {"$set": {"title": title, "updatedAt": now}})
    session["title"], session["updatedAt"] = title, now

    async def stream() -> AsyncIterator[str]:
        yield _sse("user", {"message": _public_message(user_doc), "session": _public_session(session)})
        assistant_id = uuid.uuid4().hex
        yield _sse("start", {"id": assistant_id})
        try:
            final: dict[str, Any] | None = None
            async for event in _agent_events(user, session, _user_content(text, files, previews, reply_to)):
                if event["type"] == "text":
                    yield _sse("text", {"text": event["text"]})
                elif event["type"] == "tool":
                    yield _sse("tool", {"trace": event["trace"]})
                else:
                    final = event
            if final is None:  # цикл агента завершается final либо LlmError — третьего не бывает
                raise LlmError("ИИ не завершил ответ")
            assistant_doc = {
                "_id": assistant_id,
                "sessionId": sid,
                "userId": user["_id"],
                "role": "assistant",
                "text": final["text"],
                "attachments": [],
                "replyTo": None,
                "actions": final["trace"],
                "createdAt": _now(),
            }
            await get_db().chat_messages.insert_one(assistant_doc)
            updated_at = _now()
            await get_db().chat_sessions.update_one({"_id": sid}, {"$set": {"updatedAt": updated_at}})
            await rabbit.publish(
                f"chat.user.{user['_id']}",
                {
                    "sessionId": sid,
                    "session": {"id": sid, "title": title, "updatedAt": _iso(updated_at)},
                    "messages": [_public_message(user_doc), _public_message(assistant_doc)],
                },
            )
            yield _sse("done", {"message": _public_message(assistant_doc), "session": _public_session(session)})
        except LlmError as e:
            yield _sse("error", {"message": str(e)})

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------- вложения ----------------


@router.post("/ai/chat/uploads")
async def upload_file(user: CurrentUser, file: UploadFile = File(...)) -> dict[str, Any]:
    data = await file.read(FILE_MAX_BYTES + 1)
    if len(data) > FILE_MAX_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Файл больше 10 МБ")
    name = file.filename or "file"
    content_type = file.content_type or "application/octet-stream"
    preview = data.decode("utf-8", errors="replace")[:TEXT_PREVIEW_CHARS] if _is_text_like(name, content_type) else None
    doc = {
        "_id": uuid.uuid4().hex,
        "userId": user["_id"],
        "name": name,
        "size": len(data),
        "contentType": content_type,
        "preview": preview,
        "createdAt": _now(),
    }
    await get_db().chat_files.insert_one(doc)
    return {"id": doc["_id"], "name": name, "size": len(data)}


@router.get("/ai/chat/files/{file_id}")
async def download_file(file_id: str, user: CurrentUser) -> Response:
    f = await get_db().chat_files.find_one({"_id": file_id, "userId": user["_id"]})
    if f is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Файл не найден")
    filename = quote(f["name"])
    return Response(
        content=f["data"],
        media_type=f.get("contentType") or "application/octet-stream",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )
