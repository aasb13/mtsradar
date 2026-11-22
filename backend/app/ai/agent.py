"""Цикл ИИ-агента: модель вызывает инструменты, результаты возвращаются ей,
работа заканчивается вызовом финального инструмента submit_* (его параметры —
структурированный результат агента, уже проверенный в tools.py).
"""

import json
from collections.abc import AsyncIterator
from typing import Any

from app.ai import llm
from app.ai.llm import LlmError
from app.ai.tools import Tool, ToolContext, run_tool, tool_index, tool_specs
from app.core.config import get_settings


async def run_agent(ctx: ToolContext, system: str, user: str, tools: list[Tool]) -> dict[str, Any]:
    """Прогон агента до вызова submit_*-инструмента; возвращает проверенные параметры."""
    registry = tool_index(tools)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    max_iterations = get_settings().llm_max_iterations
    for _ in range(max_iterations):
        msg = await llm.chat(messages, tools=tool_specs(tools))
        messages.append(msg)
        calls = msg.get("tool_calls") or []
        if not calls:
            raise LlmError("ИИ не завершил анализ: нет итогового результата")
        for call in calls:
            result = await _execute(registry, call)
            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id"),
                "content": json.dumps(result, ensure_ascii=False, default=str),
            })
        if ctx.finished and ctx.result is not None:
            return ctx.result
    raise LlmError("ИИ не завершил анализ за отведённое число шагов")


async def run_chat_agent_stream(
    messages: list[dict[str, Any]], tools: list[Tool], registry: dict[str, Tool] | None = None
) -> AsyncIterator[dict[str, Any]]:
    """Цикл чат-агента со стримингом: модель вызывает инструменты, пока не ответит текстом.

    messages — готовая история [system, ...прошлые, текущий user]; цикл дописывает в неё
    ответы модели и результаты инструментов. По ходу отдаёт события
    {'type': 'text', 'text': кусок ответа} и {'type': 'tool', 'trace': {tool, ok, summary}},
    в конце — {'type': 'final', 'text': текст ответа, 'trace': весь след вызовов}.
    """
    registry = registry or tool_index(tools)
    specs = tool_specs(tools)
    trace: list[dict[str, Any]] = []
    last_call: str | None = None
    max_iterations = get_settings().llm_chat_max_iterations
    for _ in range(max_iterations):
        msg: dict[str, Any] | None = None
        async for ev in llm.chat_stream(messages, tools=specs):
            if ev["type"] == "text":
                yield ev
            else:
                msg = ev["message"]
        messages.append(msg)
        calls = msg.get("tool_calls") or []
        if not calls:
            text = (msg.get("content") or "").strip()
            if not text:
                raise LlmError("ИИ вернул пустой ответ")
            yield {"type": "final", "text": text, "trace": trace}
            return
        for call in calls:
            name = call.get("function", {}).get("name")
            # зацикливание reasoning-моделей: тот же вызов подряд не исполняем, отправляем модели предупреждение
            key = f"{name}:{call.get('function', {}).get('arguments')}"
            if key == last_call:
                result: dict[str, Any] = {
                    "error": "Вы уже вызвали этот инструмент с теми же аргументами — результат не изменится. "
                             "Используйте уже полученные данные и дайте финальный ответ без повторных вызовов.",
                }
            elif name not in registry:
                result = {
                    "error": f"Инструмент {name!r} недоступен в этой сессии — у пользователя недостаточно прав. "
                             "Не пытайтесь обойти и сообщите пользователю, что действие выполнить нельзя.",
                }
            else:
                result = await _execute(registry, call)
            last_call = key
            chip = {
                "tool": name,
                "ok": "error" not in result,
                "summary": str(result.get("summary") or result.get("error") or "данные получены"),
            }
            trace.append(chip)
            yield {"type": "tool", "trace": chip}
            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id"),
                "content": json.dumps(result, ensure_ascii=False, default=str),
            })
    raise LlmError("ИИ не завершил ответ за отведённое число шагов")


async def _execute(registry: dict[str, Tool], call: dict[str, Any]) -> dict[str, Any]:
    name = call.get("function", {}).get("name")
    tool = registry.get(name)
    if tool is None:
        return {"error": f"Неизвестный инструмент {name!r}"}
    try:
        args = json.loads(call.get("function", {}).get("arguments") or "{}")
    except ValueError:
        return {"error": f"Аргументы {name!r} — не корректный JSON. Пошлите объект целиком."}
    if not isinstance(args, dict):
        return {"error": f"Аргументы {name!r} должны быть JSON-объектом."}
    return await run_tool(tool, args)
