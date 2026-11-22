"""Цикл ИИ-агента: модель вызывает инструменты, результаты возвращаются ей,
работа заканчивается вызовом финального инструмента submit_* (его параметры —
структурированный результат агента, уже проверенный в tools.py).
"""

import json
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
