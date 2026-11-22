"""Минимальный клиент LLM по OpenAI-совместимому протоколу (chat/completions + tools).

Провайдер задаётся настройками LLM_API_BASE / LLM_API_KEY / LLM_MODEL.
Ключ не печатается: детали ошибок остаются в логах, наружу идёт короткое сообщение.
"""

import logging
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


async def chat(messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Один ответ модели. Возвращает сообщение ассистента как есть (content / tool_calls)."""
    s = get_settings()
    ensure_configured()
    body: dict[str, Any] = {"model": s.llm_model, "messages": messages, "temperature": 0.2}
    if tools:
        body["tools"] = tools
    if s.llm_reasoning_budget is not None:
        # reasoning-модели (llama.cpp): ограничиваем размышления, иначе агент зацикливается.
        # Явный max_tokens обязателен: без него reasoning может съесть весь лимит генерации
        # сервера и прийти пустой content — для агента это «пустой ответ».
        body["reasoning_budget"] = s.llm_reasoning_budget
        body["max_tokens"] = s.llm_reasoning_budget + 8192
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
