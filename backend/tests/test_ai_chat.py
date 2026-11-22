"""Чат-агент: цикл с инструментами, след вызовов, матрица прав — с подменным ответом LLM, без Mongo."""

import json
from datetime import UTC, datetime

import pytest

from app.ai import llm as llm_mod
from app.ai.agent import run_chat_agent
from app.ai.chat_tools import WRITE_DENIED, action_tools, can, chat_tools
from app.ai.llm import LlmError
from app.ai.prompts import chat_system_message
from app.ai.tools import Tool, ToolContext
from app.core.config import Settings

S = Settings(_env_file=None, llm_chat_max_iterations=4)
NOW = datetime.now(UTC)


def make_ctx(role: str) -> ToolContext:
    return ToolContext(now=NOW, settings=S, known_groups=["Команда А"], user={"_id": "u1", "role": role})


def call(name: str, args, call_id: str) -> dict:
    raw = args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": raw}}


def assistant(*calls: dict) -> dict:
    return {"role": "assistant", "content": None, "tool_calls": list(calls)}


def script_chat(monkeypatch: pytest.MonkeyPatch, script: list[dict]) -> list[list[dict]]:
    """Подменяет llm.chat последовательностью ответов; возвращает снимки запросов."""
    requests: list[list[dict]] = []

    async def fake_chat(messages, tools=None):
        requests.append([dict(m) for m in messages])
        return script.pop(0)

    monkeypatch.setattr(llm_mod, "chat", fake_chat)
    monkeypatch.setattr("app.ai.agent.get_settings", lambda: S)
    return requests


def echo_tool() -> Tool:
    async def handler(args: dict) -> dict:
        return {"summary": "нашли 3 инцидента", "count": 3}

    return Tool(name="search_incidents", description="", parameters={}, handler=handler)


async def test_chat_loop_calls_tool_then_answers(monkeypatch):
    requests = script_chat(
        monkeypatch,
        [
            assistant(call("search_incidents", {"q": "L2"}, "c1")),
            {"role": "assistant", "content": "Нашёл 3 инцидента."},
        ],
    )
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "найди"}]
    text, trace = await run_chat_agent(messages, [echo_tool()])
    assert text == "Нашёл 3 инцидента."
    assert trace == [{"tool": "search_incidents", "ok": True, "summary": "нашли 3 инцидента"}]
    # результат инструмента вернулся модели в том же диалоге
    assert json.loads(requests[1][3]["content"])["summary"] == "нашли 3 инцидента"


async def test_chat_loop_failed_tool_marks_trace_not_ok(monkeypatch):
    async def broken(args: dict) -> dict:
        return {"error": "Недостаточно прав"}

    tool = Tool(name="assign_team", description="", parameters={}, handler=broken)
    script_chat(monkeypatch, [assistant(call("assign_team", {}, "c1")), {"role": "assistant", "content": "Не вышло."}])
    _, trace = await run_chat_agent([{"role": "user", "content": "назначь"}], [tool])
    assert trace == [{"tool": "assign_team", "ok": False, "summary": "Недостаточно прав"}]


async def test_chat_loop_rejects_empty_answer(monkeypatch):
    script_chat(monkeypatch, [{"role": "assistant", "content": "   "}])
    with pytest.raises(LlmError):
        await run_chat_agent([{"role": "user", "content": "привет"}], [echo_tool()])


async def test_chat_loop_breaks_repeated_identical_tool_call(monkeypatch):
    calls = {"n": 0}

    async def counting(args: dict) -> dict:
        calls["n"] += 1
        return {"summary": f"проверка {calls['n']}"}

    tool = Tool(name="get_incident", description="", parameters={}, handler=counting)
    same = {"incident_id": "INC1"}
    script_chat(
        monkeypatch,
        [
            assistant(call("get_incident", same, "c1")),
            assistant(call("get_incident", same, "c2")),  # зацикливание: тот же вызов подряд
            {"role": "assistant", "content": "Отвечаю по уже полученным данным."},
        ],
    )
    text, trace = await run_chat_agent([{"role": "user", "content": "глянь INC1"}], [tool])
    assert calls["n"] == 1  # второй одинаковый вызов не исполнялся
    assert trace[1]["ok"] is False and "уже вызвали" in trace[1]["summary"]
    assert text == "Отвечаю по уже полученным данным."


async def test_withheld_tool_is_reported_as_permission_denial(monkeypatch):
    script_chat(
        monkeypatch,
        [
            assistant(call("set_priority", {"incident_id": "INC1", "priority_id": 2}, "c1")),
            {"role": "assistant", "content": "Недостаточно прав."},
        ],
    )
    _, trace = await run_chat_agent([{"role": "user", "content": "снизь приоритет"}], [echo_tool()])
    assert trace[0]["tool"] == "set_priority"
    assert trace[0]["ok"] is False
    assert "недостаточно прав" in trace[0]["summary"].lower()


def test_strip_reasoning_removes_think_block(monkeypatch):
    from app.ai.agent import _strip_reasoning

    assert _strip_reasoning("<think>долгие размышления</think>Ответ.") == "Ответ."
    assert _strip_reasoning("Чистый ответ") == "Чистый ответ"


async def test_chat_loop_gives_up_after_max_iterations(monkeypatch):
    script = [assistant(call("search_incidents", {}, f"c{i}")) for i in range(S.llm_max_iterations)]
    script_chat(monkeypatch, script)
    with pytest.raises(LlmError):
        await run_chat_agent([{"role": "user", "content": "найди"}], [echo_tool()])


# ---------------- матрица прав ----------------


@pytest.mark.parametrize(
    "role,write,comment",
    [
        ("admin", True, True),
        ("coordinator", True, True),
        ("viewer", False, True),
        ("developer", False, False),
    ],
)
def test_can_mirrors_rest_role_gates(role, write, comment):
    user = {"_id": "u", "role": role}
    assert can(user, "incident_write") is write
    assert can(user, "comment") is comment


def test_tool_sets_match_permissions():
    write_names = {
        "assign_team",
        "set_priority",
        "set_deadline",
        "change_state",
        "ack_incident",
        "archive_incident",
        "restore_incident",
    }
    coordinator = [t.name for t in chat_tools(make_ctx("coordinator"))]
    assert write_names <= set(coordinator) and "add_comment" in coordinator
    viewer = [t.name for t in chat_tools(make_ctx("viewer"))]
    assert not write_names & set(viewer) and "add_comment" in viewer  # только то, что реально исполнимо
    developer = [t.name for t in chat_tools(make_ctx("developer"))]
    assert set(developer) == {"search_incidents", "get_incident", "dashboard_summary"}


async def test_write_tool_denied_for_viewer_before_touching_data():
    tool = action_tools(make_ctx("viewer"))["archive_incident"]
    res = await tool.handler({"incident_id": "INC1"})
    assert res["error"] == WRITE_DENIED


async def test_write_tool_requires_incident_id():
    tool = action_tools(make_ctx("coordinator"))["archive_incident"]
    res = await tool.handler({})
    assert "Укажите incident_id" in res["error"]


async def test_comment_tool_denied_for_developer():
    tool = action_tools(make_ctx("developer"))["add_comment"]
    res = await tool.handler({"incident_id": "INC1", "text": "привет"})
    assert "Недостаточно прав" in res["error"]


def test_system_prompt_names_role_and_incident():
    user = {"_id": "u", "role": "viewer"}
    plain = chat_system_message(user, None)
    assert "тестировщик" in plain and "менять инциденты не может" in plain
    doc = {"_id": "INC1", "data": {"header": "Нет доступа", "stateId": 2}}
    with_incident = chat_system_message(user, doc)
    assert "INC1" in with_incident and "Нет доступа" in with_incident
