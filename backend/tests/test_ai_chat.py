"""Чат-агент: стрим-цикл с инструментами, след вызовов, матрица прав — подменные LLM и Mongo."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from app.ai import llm as llm_mod
from app.ai.agent import run_chat_agent_stream
from app.ai.chat_tools import WRITE_DENIED, action_tools, can, chat_tools
from app.ai.llm import LlmError, _ThinkFilter
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


def script_stream(monkeypatch: pytest.MonkeyPatch, script: list[dict]) -> list[list[dict]]:
    """Подменяет llm.chat_stream последовательностью ответов; возвращает снимки запросов."""
    requests: list[list[dict]] = []

    async def fake_stream(messages, tools=None):
        requests.append([dict(m) for m in messages])
        msg = script.pop(0)
        content = msg.get("content")
        if isinstance(content, str) and content.strip():
            half = max(1, len(content) // 2)
            yield {"type": "text", "text": content[:half]}
            yield {"type": "text", "text": content[half:]}
        yield {"type": "message", "message": dict(msg)}

    monkeypatch.setattr(llm_mod, "chat_stream", fake_stream)
    monkeypatch.setattr("app.ai.agent.get_settings", lambda: S)
    return requests


async def collect(messages: list[dict], tools: list[Tool]) -> tuple[str, list[dict], list[dict]]:
    """Прогоняет стрим до конца; возвращает (текст, след, события)."""
    text, trace, events = "", [], []
    async for ev in run_chat_agent_stream(messages, tools):
        events.append(ev)
        if ev["type"] == "text":
            text += ev["text"]
        elif ev["type"] == "tool":
            trace.append(ev["trace"])
        else:
            text, trace = ev["text"], ev["trace"]
    return text, trace, events


def echo_tool() -> Tool:
    async def handler(args: dict) -> dict:
        return {"summary": "нашли 3 инцидента", "count": 3}

    return Tool(name="search_incidents", description="", parameters={}, handler=handler)


async def test_chat_loop_calls_tool_then_answers(monkeypatch):
    requests = script_stream(
        monkeypatch,
        [
            assistant(call("search_incidents", {"q": "L2"}, "c1")),
            {"role": "assistant", "content": "Нашёл 3 инцидента."},
        ],
    )
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "найди"}]
    text, trace, events = await collect(messages, [echo_tool()])
    assert text == "Нашёл 3 инцидента."
    assert trace == [{"tool": "search_incidents", "ok": True, "summary": "нашли 3 инцидента"}]
    # ответ пришёл живыми кусками, а не одним финальным событием
    assert sum(1 for e in events if e["type"] == "text") == 2
    # результат инструмента вернулся модели в том же диалоге
    assert json.loads(requests[1][3]["content"])["summary"] == "нашли 3 инцидента"


async def test_chat_loop_failed_tool_marks_trace_not_ok(monkeypatch):
    async def broken(args: dict) -> dict:
        return {"error": "Недостаточно прав"}

    tool = Tool(name="assign_team", description="", parameters={}, handler=broken)
    script_stream(
        monkeypatch, [assistant(call("assign_team", {}, "c1")), {"role": "assistant", "content": "Не вышло."}]
    )
    _, trace, _ = await collect([{"role": "user", "content": "назначь"}], [tool])
    assert trace == [{"tool": "assign_team", "ok": False, "summary": "Недостаточно прав"}]


async def test_chat_loop_rejects_empty_answer(monkeypatch):
    script_stream(monkeypatch, [{"role": "assistant", "content": "   "}])
    with pytest.raises(LlmError):
        await collect([{"role": "user", "content": "привет"}], [echo_tool()])


async def test_chat_loop_breaks_repeated_identical_tool_call(monkeypatch):
    calls = {"n": 0}

    async def counting(args: dict) -> dict:
        calls["n"] += 1
        return {"summary": f"проверка {calls['n']}"}

    tool = Tool(name="get_incident", description="", parameters={}, handler=counting)
    same = {"incident_id": "INC1"}
    script_stream(
        monkeypatch,
        [
            assistant(call("get_incident", same, "c1")),
            assistant(call("get_incident", same, "c2")),  # зацикливание: тот же вызов подряд
            {"role": "assistant", "content": "Отвечаю по уже полученным данным."},
        ],
    )
    text, trace, _ = await collect([{"role": "user", "content": "глянь INC1"}], [tool])
    assert calls["n"] == 1  # второй одинаковый вызов не исполнялся
    assert trace[1]["ok"] is False and "уже вызвали" in trace[1]["summary"]
    assert text == "Отвечаю по уже полученным данным."


async def test_withheld_tool_is_reported_as_permission_denial(monkeypatch):
    script_stream(
        monkeypatch,
        [
            assistant(call("set_priority", {"incident_id": "INC1", "priority_id": 2}, "c1")),
            {"role": "assistant", "content": "Недостаточно прав."},
        ],
    )
    _, trace, _ = await collect([{"role": "user", "content": "снизь приоритет"}], [echo_tool()])
    assert trace[0]["tool"] == "set_priority"
    assert trace[0]["ok"] is False
    assert "недостаточно прав" in trace[0]["summary"].lower()


def test_think_filter_hides_reasoning_across_chunks():
    f = _ThinkFilter()
    assert f.feed("Привет. <thi") == "Привет. "
    assert f.feed("nk>размышления</thin") == ""
    assert f.feed("k>Вот ответ.") == "Вот ответ."
    assert f.flush() == ""


def test_think_filter_keeps_text_when_tag_never_closes():
    f = _ThinkFilter()
    assert f.feed("abc") == "abc"
    assert f.feed("<thi") == ""
    assert f.flush() == "<thi"  # тег так и не собрался — это обычный текст
    g = _ThinkFilter()
    assert g.feed("x<think>скрытое") == "x"
    assert g.flush() == ""  # стрим оборвался внутри think — наружу ничего не попадает


async def test_chat_stream_parses_sse_filters_think_and_requests_stream(monkeypatch):
    import httpx

    sse = (
        'data: {"choices":[{"delta":{"content":"При<thi"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"nk>скрытый</think>вет"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":" мир"}}]}\n\n'
        "data: [DONE]\n\n"
    )
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})

    monkeypatch.setattr(
        "app.ai.llm.get_settings",
        lambda: Settings(_env_file=None, llm_api_base="http://llm/v1", llm_model="m"),
    )
    real_client = httpx.AsyncClient
    monkeypatch.setattr(llm_mod.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    events = [ev async for ev in llm_mod.chat_stream([{"role": "user", "content": "привет"}])]
    assert seen["body"]["stream"] is True
    assert [ev["text"] for ev in events if ev["type"] == "text"] == ["При", "вет", " мир"]
    final = [ev for ev in events if ev["type"] == "message"][0]["message"]
    assert final == {"role": "assistant", "content": "Привет мир"}


async def test_chat_stream_accumulates_tool_calls_by_index(monkeypatch):
    import httpx

    sse = (
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_incident","arguments":""}}]}}]}\n\n'
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"incident_id\\": "}}]}}]}\n\n'
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"INC1\\"}"}}]}}]}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=sse.encode(), headers={"content-type": "text/event-stream"})

    monkeypatch.setattr(
        "app.ai.llm.get_settings",
        lambda: Settings(_env_file=None, llm_api_base="http://llm/v1", llm_model="m"),
    )
    real_client = httpx.AsyncClient
    monkeypatch.setattr(llm_mod.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    events = [ev async for ev in llm_mod.chat_stream([{"role": "user", "content": "глянь"}])]
    assert all(ev["type"] != "text" for ev in events)
    msg = [ev for ev in events if ev["type"] == "message"][0]["message"]
    assert msg["content"] is None
    assert msg["tool_calls"] == [
        {"id": "c1", "type": "function", "function": {"name": "get_incident", "arguments": '{"incident_id": "INC1"}'}}
    ]


async def test_chat_loop_gives_up_after_max_iterations(monkeypatch):
    script = [assistant(call("search_incidents", {}, f"c{i}")) for i in range(S.llm_chat_max_iterations)]
    script_stream(monkeypatch, script)
    with pytest.raises(LlmError):
        await collect([{"role": "user", "content": "найди"}], [echo_tool()])


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
    assert set(developer) == {
        "search_incidents",
        "get_incident",
        "dashboard_summary",
        "ratings_leaderboard",  # leaderboard в REST открыт любому пользователю
        "get_user_ratings",  # чужие оценки инструмент отклонит по правам GET /users/{id}/ratings
    }


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


# ---------------- инструменты оценок (подменная Mongo) ----------------

RATER = {"_id": "u2", "fullName": "Оценщик", "email": "rater@mts.ru", "role": "coordinator", "deletedAt": None}
RATINGS_DOCS = [
    {
        "_id": "r1",
        "targetUserId": "u1",
        "authorUserId": "u2",
        "score": 5,
        "comment": "Быстро помог",
        "anonymous": False,
        "createdAt": datetime(2026, 11, 1, tzinfo=UTC),
    },
    {
        "_id": "r2",
        "targetUserId": "u1",
        "authorUserId": "u2",
        "score": 4,
        "comment": "",
        "anonymous": True,
        "createdAt": datetime(2026, 11, 10, tzinfo=UTC),
    },
]


def _matches(doc: dict, query: dict) -> bool:
    for field, expected in query.items():
        if isinstance(expected, dict) and "$in" in expected:
            if doc.get(field) not in expected["$in"]:
                return False
        elif doc.get(field) != expected:
            return False
    return True


class FakeCursor:
    """Курсор find()/sort(): to_list(None) и асинхронная итерация."""

    def __init__(self, docs: list[dict], key: str | None = None):
        self._docs, self._key = docs, key

    def sort(self, key: str, _direction: int) -> "FakeCursor":
        return FakeCursor(self._docs, key)

    def _sorted(self) -> list[dict]:
        if self._key is None:
            return list(self._docs)
        floor = datetime.min.replace(tzinfo=UTC)
        return sorted(self._docs, key=lambda d: d.get(self._key) or floor, reverse=True)

    async def to_list(self, _limit: int) -> list[dict]:
        return self._sorted()

    def __aiter__(self):
        self._it = iter(self._sorted())
        return self

    async def __anext__(self) -> dict:
        try:
            return next(self._it)
        except StopIteration:
            raise StopAsyncIteration from None


class FakeRatingsClient:
    """Клиент Mongo в объёме инструментов оценок: коллекции users и ratings."""

    def __init__(self, users: list[dict], ratings: list[dict]):
        self._users, self._ratings = users, ratings

    def __getitem__(self, _name: str) -> SimpleNamespace:
        by_target: dict[str, list[int]] = {}
        for d in self._ratings:
            by_target.setdefault(d["targetUserId"], []).append(d["score"])
        agg_rows = [{"_id": t, "avg": sum(s) / len(s), "count": len(s)} for t, s in by_target.items()]

        async def aggregate(_pipeline: list[dict]) -> FakeCursor:
            return FakeCursor(agg_rows)

        return SimpleNamespace(
            users=SimpleNamespace(find=lambda q: FakeCursor([d for d in self._users if _matches(d, q)])),
            ratings=SimpleNamespace(
                find=lambda q: FakeCursor([d for d in self._ratings if _matches(d, q)]),
                aggregate=aggregate,
            ),
        )


def use_ratings_db(monkeypatch: pytest.MonkeyPatch, users: list[dict], ratings: list[dict]) -> None:
    monkeypatch.setattr("app.db.mongo._client", FakeRatingsClient(users, ratings))


def tool_by_name(tools: list[Tool], name: str) -> Tool:
    return next(t for t in tools if t.name == name)


async def test_own_ratings_include_average_and_hide_anonymous_author(monkeypatch):
    use_ratings_db(monkeypatch, users=[RATER], ratings=RATINGS_DOCS)
    tool = tool_by_name(chat_tools(make_ctx("viewer")), "get_user_ratings")
    res = await tool.handler({})
    assert res["average"] == 4.5 and res["count"] == 2
    assert res["distribution"] == {1: 0, 2: 0, 3: 0, 4: 1, 5: 1}
    assert res["items"][0]["score"] == 4 and res["items"][0]["author"] is None  # свежий аноним — автор скрыт
    assert res["items"][1]["author"]["name"] == "Оценщик"


async def test_staff_reads_other_employee_ratings(monkeypatch):
    use_ratings_db(monkeypatch, users=[RATER], ratings=[{**d, "targetUserId": "u2"} for d in RATINGS_DOCS])
    tool = tool_by_name(chat_tools(make_ctx("coordinator")), "get_user_ratings")
    res = await tool.handler({"employee": "Оценщик"})
    assert res["employee"] == "Оценщик" and res["average"] == 4.5


async def test_developer_cannot_read_other_employee_ratings(monkeypatch):
    use_ratings_db(monkeypatch, users=[RATER], ratings=[{**RATINGS_DOCS[0], "targetUserId": "u2"}])
    tool = tool_by_name(chat_tools(make_ctx("developer")), "get_user_ratings")
    res = await tool.handler({"employee": "Оценщик"})
    assert "Чужие оценки" in res["error"]


async def test_ratings_leaderboard_puts_rated_first(monkeypatch):
    unrated = {"_id": "u3", "fullName": "Без Оценок", "email": "u3@mts.ru", "role": "viewer", "deletedAt": None}
    rated_on_rater = [{**d, "targetUserId": "u2"} for d in RATINGS_DOCS]  # оценки нацелены на RATER, он в списке
    use_ratings_db(monkeypatch, users=[RATER, unrated], ratings=rated_on_rater)
    tool = tool_by_name(chat_tools(make_ctx("viewer")), "ratings_leaderboard")
    res = await tool.handler({})
    assert [i["fullName"] for i in res["items"]] == ["Оценщик", "Без Оценок"]
    assert res["items"][0]["average"] == 4.5 and res["items"][0]["count"] == 2


def test_system_prompt_names_role_and_incident():
    user = {"_id": "u", "role": "viewer"}
    plain = chat_system_message(user, None)
    assert "тестировщик" in plain and "менять инциденты не может" in plain
    doc = {"_id": "INC1", "data": {"header": "Нет доступа", "stateId": 2}}
    with_incident = chat_system_message(user, doc)
    assert "INC1" in with_incident and "Нет доступа" in with_incident
