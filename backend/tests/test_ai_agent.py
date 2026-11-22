"""Цикл ИИ-агента и проверка финальных инструментов — с подменным ответом LLM, без Mongo."""

import json
from datetime import UTC, datetime

import pytest

from app.ai import llm as llm_mod
from app.ai.agent import run_agent
from app.ai.llm import LlmError
from app.ai.prompts import TEAM_SELECTOR_SYSTEM
from app.ai.tools import ToolContext, run_tool, selection_tools, tool_index
from app.core.config import Settings

S = Settings(_env_file=None, llm_max_iterations=4)
GROUPS = ["КЦ ДОИ Администрирование SAN", "КЦ ИТ OPS Аварии MSCP"]

VALID_REC = {
    "recommendedGroup": GROUPS[0],
    "reason": "Решала похожие инциденты этого продукта, загрузка ниже средней.",
    "confidence": 70,
    "alternatives": [{"group": GROUPS[1], "reason": "Меньше опыта с продуктом, но свободнее."}],
}


def make_ctx() -> ToolContext:
    return ToolContext(now=datetime.now(UTC), settings=S, known_groups=GROUPS)


def call(name: str, args, call_id: str) -> dict:
    raw = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": raw}}


def assistant(*calls: dict) -> dict:
    return {"role": "assistant", "content": None, "tool_calls": list(calls)}


def script_chat(monkeypatch: pytest.MonkeyPatch, script: list[dict]) -> list[list[dict]]:
    """Подменяет llm.chat последовательностью ответов; возвращает снимки запросов для проверок."""
    requests: list[list[dict]] = []

    async def fake_chat(messages, tools=None):
        # снимок: агент мутирует список messages, добавляя в него ответы инструментов
        requests.append([dict(m) for m in messages])
        return script.pop(0)

    monkeypatch.setattr(llm_mod, "chat", fake_chat)
    monkeypatch.setattr("app.ai.agent.get_settings", lambda: S)
    return requests


async def test_final_tool_returns_validated_result(monkeypatch):
    ctx = make_ctx()
    script_chat(monkeypatch, [assistant(call("submit_recommendation", VALID_REC, "c1"))])
    result = await run_agent(ctx, TEAM_SELECTOR_SYSTEM, "start", selection_tools(ctx))
    assert result["recommendedGroup"] == GROUPS[0]
    assert result["confidence"] == 70
    assert result["alternatives"][0]["group"] == GROUPS[1]


async def test_invalid_group_is_fed_back_and_model_retries(monkeypatch):
    ctx = make_ctx()
    bad = {**VALID_REC, "recommendedGroup": "Нет такой команды"}
    requests = script_chat(
        monkeypatch,
        [
            assistant(call("submit_recommendation", bad, "c1")),
            assistant(call("submit_recommendation", VALID_REC, "c2")),
        ],
    )
    result = await run_agent(ctx, TEAM_SELECTOR_SYSTEM, "start", selection_tools(ctx))
    assert result["recommendedGroup"] == GROUPS[0]
    tool_answer = json.loads(requests[1][-1]["content"])
    assert "не входит в список известных команд" in tool_answer["error"]


async def test_unknown_tool_and_bad_json_do_not_crash_the_loop(monkeypatch):
    ctx = make_ctx()
    requests = script_chat(
        monkeypatch,
        [
            assistant(call("nope", {}, "c1"), call("submit_recommendation", "{плохой json", "c2")),
            assistant(call("submit_recommendation", VALID_REC, "c3")),
        ],
    )
    result = await run_agent(ctx, TEAM_SELECTOR_SYSTEM, "start", selection_tools(ctx))
    assert result["recommendedGroup"] == GROUPS[0]
    # после первого ответа модели: [system, user, assistant, tool(неизвестный), tool(плохой json)]
    unknown_tool, bad_json = json.loads(requests[1][3]["content"]), json.loads(requests[1][4]["content"])
    assert "Неизвестный инструмент" in unknown_tool["error"]
    assert "JSON" in bad_json["error"]


async def test_loop_gives_up_when_final_tool_never_called(monkeypatch):
    ctx = make_ctx()
    # валидация финального инструмента возвращает ошибку (без похода в Mongo), агент крутится до лимита
    bad = {**VALID_REC, "recommendedGroup": "Нет такой команды"}
    script = [assistant(call("submit_recommendation", bad, f"c{i}")) for i in range(S.llm_max_iterations)]
    script_chat(monkeypatch, script)
    with pytest.raises(LlmError):
        await run_agent(ctx, TEAM_SELECTOR_SYSTEM, "start", selection_tools(ctx))


async def test_submit_recommendation_rejects_missing_reason():
    ctx = make_ctx()
    tool = tool_index(selection_tools(ctx))["submit_recommendation"]
    res = await run_tool(tool, {k: v for k, v in VALID_REC.items() if k != "reason"})
    assert "error" in res
    assert not ctx.finished


async def test_submit_recommendation_rejects_alternatives_outside_known_groups():
    ctx = make_ctx()
    tool = tool_index(selection_tools(ctx))["submit_recommendation"]
    bad = {**VALID_REC, "alternatives": [{"group": "Чужая команда", "reason": "резерв"}]}
    res = await run_tool(tool, bad)
    assert "error" in res
    assert ctx.result is None


async def test_submit_descriptions_requires_every_team():
    ctx = make_ctx()
    from app.ai.tools import analyst_tools

    submit = tool_index(analyst_tools(ctx))["submit_team_descriptions"]
    partial = {"descriptions": [{"group": GROUPS[0], "text": "Команда SAN: решает хранение."}]}
    res = await run_tool(submit, partial)
    assert GROUPS[1] in res["error"]

    full = {"descriptions": [{"group": g, "text": f"Описание {g}."} for g in GROUPS]}
    res = await run_tool(submit, full)
    assert res == {"status": "accepted"}
    assert ctx.finished
    assert [d["group"] for d in ctx.result["descriptions"]] == GROUPS


async def test_submit_descriptions_rejects_duplicate_and_long_text():
    ctx = make_ctx()
    from app.ai.tools import analyst_tools

    submit = tool_index(analyst_tools(ctx))["submit_team_descriptions"]
    dup = {
        "descriptions": [{"group": g, "text": f"Описание {g}."} for g in GROUPS]
        + [{"group": GROUPS[0], "text": "ещё"}]
    }
    assert "error" in await run_tool(submit, dup)
    long_text = {"descriptions": [{"group": g, "text": "x" * 1001 if g == GROUPS[0] else "ок"} for g in GROUPS]}
    assert "error" in await run_tool(submit, long_text)
    assert not ctx.finished
