"""Минимальный клиент LLM по OpenAI-совместимому протоколу (chat/completions + tools).

Провайдер задаётся настройками LLM_API_BASE / LLM_API_KEY / LLM_MODEL.
Ключ не печатается: детали ошибок остаются в логах, наружу идёт короткое сообщение.
"""

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.core.config import get_settings

log = logging.getLogger("app.ai")


class LlmError(RuntimeError):
    """Сбой вызова модели: недоступен сервис, плохой ответ, превышен лимит шагов."""


class LlmNotConfigured(LlmError):
    """LLM_API_BASE / LLM_MODEL не заданы — ИИ-функции выключены."""


def ensure_configured() -> None:
    s = get_settings()
    if not s.llm_api_base or not s.llm_model:
        raise LlmNotConfigured("ИИ-сервис не настроен: задайте LLM_API_BASE и LLM_MODEL в backend/.env")


def _payload(messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None) -> dict[str, Any]:
    s = get_settings()
    body: dict[str, Any] = {"model": s.llm_model, "messages": messages, "temperature": 0.2}
    if tools:
        body["tools"] = tools
    if s.llm_reasoning_budget is not None:
        # reasoning-модели (llama.cpp): ограничиваем размышления, иначе агент зацикливается.
        # Явный max_tokens обязателен: без него reasoning может съесть весь лимит генерации
        # сервера и прийти пустой content — для агента это «пустой ответ».
        body["reasoning_budget"] = s.llm_reasoning_budget
        body["max_tokens"] = s.llm_reasoning_budget + 8192
    return body


class _ThinkFilter:
    """Гасит <think>…</think> в стриме контента: reasoning-модели кладут размышления в
    content, если у провайдера выключен парсер. Теги могут быть разрезаны границей
    чанков, поэтому хвост буфера придерживается до разрешения неоднозначности."""

    _OPEN = "<think>"
    _CLOSE = "</think>"

    def __init__(self) -> None:
        self.inside = False
        self._buf = ""

    def feed(self, chunk: str) -> str:
        self._buf += chunk
        out: list[str] = []
        while self._buf:
            tag = self._CLOSE if self.inside else self._OPEN
            idx = self._buf.find(tag)
            if idx >= 0:
                if not self.inside:
                    out.append(self._buf[:idx])
                self._buf = self._buf[idx + len(tag):]
                self.inside = not self.inside
                continue
            keep = self._partial_len(self._buf, tag)
            if not self.inside:
                out.append(self._buf[: len(self._buf) - keep])
            self._buf = self._buf[len(self._buf) - keep:]
            break
        return "".join(out)

    def flush(self) -> str:
        """Остаток буфера на конце стрима: начавшийся тег так и не собрался."""
        text = "" if self.inside else self._buf
        self._buf = ""
        return text

    @staticmethod
    def _partial_len(buf: str, tag: str) -> int:
        """Длина суффикса buf, который может оказаться началом tag."""
        for n in range(min(len(buf), len(tag) - 1), 0, -1):
            if tag.startswith(buf[-n:]):
                return n
        return 0


async def chat(messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Один ответ модели. Возвращает сообщение ассистента как есть (content / tool_calls)."""
    s = get_settings()
    ensure_configured()
    body = _payload(messages, tools)
    headers = {"Authorization": f"Bearer {s.llm_api_key}"} if s.llm_api_key else {}
    url = s.llm_api_base.rstrip("/") + "/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=s.llm_timeout_sec) as client:
            resp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError as e:
        log.exception("LLM недоступен: %s", e.__class__.__name__)
        raise LlmError("ИИ-сервис недоступен") from e
    if resp.status_code != 200:
        log.error("LLM вернул %s: %s", resp.status_code, resp.text[:500])
        raise LlmError("ИИ-сервис вернул ошибку")
    try:
        return resp.json()["choices"][0]["message"]
    except (KeyError, IndexError, ValueError) as e:
        log.error("Неожиданный ответ LLM: %s", resp.text[:500])
        raise LlmError("ИИ-сервис вернул неожиданный ответ") from e


async def chat_stream(
    messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None
) -> AsyncIterator[dict[str, Any]]:
    """Стриминговый вариант chat(): по мере генерации отдаёт {'type': 'text', 'text': кусок}
    (уже без reasoning), в конце — {'type': 'message', 'message': <то же, что вернул бы chat()>}.
    Ошибки — те же LlmError, в том же порядке проверок."""
    s = get_settings()
    ensure_configured()
    body = _payload(messages, tools)
    body["stream"] = True
    headers = {"Authorization": f"Bearer {s.llm_api_key}"} if s.llm_api_key else {}
    url = s.llm_api_base.rstrip("/") + "/chat/completions"
    think = _ThinkFilter()
    content: list[str] = []
    calls: dict[int, dict[str, Any]] = {}
    try:
        async with httpx.AsyncClient(timeout=s.llm_timeout_sec) as client:
            async with client.stream("POST", url, json=body, headers=headers) as resp:
                if resp.status_code != 200:
                    detail = (await resp.aread()).decode("utf-8", "replace")[:500]
                    log.error("LLM вернул %s: %s", resp.status_code, detail)
                    raise LlmError("ИИ-сервис вернул ошибку")
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    piece = delta.get("content")
                    if isinstance(piece, str) and piece:
                        visible = think.feed(piece)
                        if visible:
                            content.append(visible)
                            yield {"type": "text", "text": visible}
                    for tc in delta.get("tool_calls") or []:
                        idx = tc.get("index") or 0
                        slot = calls.setdefault(
                            idx, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
                        )
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name") and not slot["function"]["name"]:
                            slot["function"]["name"] = fn["name"]
                        args_piece = fn.get("arguments")
                        if isinstance(args_piece, str):
                            slot["function"]["arguments"] += args_piece
    except httpx.HTTPError as e:
        log.exception("LLM недоступен: %s", e.__class__.__name__)
        raise LlmError("ИИ-сервис недоступен") from e
    text = "".join(content) + think.flush()
    message: dict[str, Any] = {"role": "assistant", "content": text or None}
    ordered = [calls[i] for i in sorted(calls)]
    if ordered:
        message["tool_calls"] = ordered
    yield {"type": "message", "message": message}
