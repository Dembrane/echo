import re
import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

import agent
from agent import (
    POST_NUDGE_CONTINUATION_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    _build_llm,
    _format_canvas_activity_section,
    _normalize_fused_tool_calls,
    create_agent_graph,
)
from settings import get_settings


class FakeLLM:
    def bind_tools(self, _tools):
        return self

    async def ainvoke(self, _messages):
        return AIMessage(content="mocked-response")


class SequenceLLM:
    def __init__(self, responses: list[AIMessage]) -> None:
        self.responses = responses
        self.invocations: list[list[object]] = []
        self.bound_tools: list[object] = []

    def bind_tools(self, tools):
        self.bound_tools = tools
        return self

    async def ainvoke(self, messages):
        self.invocations.append(list(messages))
        if not self.responses:
            raise AssertionError("Unexpected model invocation with no prepared response")
        return self.responses.pop(0)


class MemoryClient:
    def __init__(self, payload: dict | None = None) -> None:
        self.payload = payload or {"memories": []}
        self.list_memory_calls: list[str] = []
        self.closed = False

    async def list_memory(self, project_id: str) -> dict:
        self.list_memory_calls.append(project_id)
        return self.payload

    async def close(self) -> None:
        self.closed = True


class MemoryClientFactory:
    def __init__(self, payload: dict | None = None) -> None:
        self.payload = payload or {"memories": []}
        self.instances: list[MemoryClient] = []

    def __call__(self, _bearer_token: str) -> MemoryClient:
        client = MemoryClient(self.payload)
        self.instances.append(client)
        return client


class CanvasActivityClient(MemoryClient):
    def __init__(self, payload: dict | None = None) -> None:
        super().__init__({"memories": []})
        self.canvas_activity_payload = payload or {"canvases": []}
        self.canvas_activity_calls: list[dict[str, object]] = []

    async def list_chat_canvas_activity(
        self,
        project_id: str,
        chat_id: str,
        limit: int = 5,
    ) -> dict:
        self.canvas_activity_calls.append(
            {"project_id": project_id, "chat_id": chat_id, "limit": limit}
        )
        return self.canvas_activity_payload


class CanvasActivityClientFactory:
    def __init__(self, payload: dict | None = None) -> None:
        self.payload = payload or {"canvases": []}
        self.instances: list[CanvasActivityClient] = []

    def __call__(self, _bearer_token: str) -> CanvasActivityClient:
        client = CanvasActivityClient(self.payload)
        self.instances.append(client)
        return client


def _tool_call_response(
    call_id: int,
    *,
    tool_name: str = "get_project_scope",
    args: dict[str, object] | None = None,
    content: str = "",
) -> AIMessage:
    return AIMessage(
        content=content,
        tool_calls=[
            {
                "id": f"call-{call_id}",
                "name": tool_name,
                "args": args or {},
            }
        ],
    )


def _runtime_note(invocation: list[object]) -> str | None:
    head = invocation[0] if invocation else None
    content = getattr(head, "content", None)
    if getattr(head, "type", None) != "system" or not isinstance(content, str):
        return None
    _, marker, note = content.partition(agent.RUNTIME_NOTE_HEADING)
    return note.strip() if marker else None


def _extract_automatic_nudges(invocations: list[list[object]]) -> list[str]:
    return [note for invocation in invocations if (note := _runtime_note(invocation))]


def _count_corrective_retry_invocations(invocations: list[list[object]]) -> int:
    return sum(
        1
        for invocation in invocations
        if POST_NUDGE_CONTINUATION_SYSTEM_PROMPT in (_runtime_note(invocation) or "")
    )


def _fake_vertex_chat(monkeypatch):
    class _FakeChatVertexAI:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs

    class _FakeCredentials:
        def __init__(self, info, scopes) -> None:
            self.info = info
            self.scopes = scopes

    class _FakeServiceAccountModule:
        class Credentials:
            @staticmethod
            def from_service_account_info(info, scopes=None):
                return _FakeCredentials(info, scopes)

    monkeypatch.setattr(agent, "_VertexChat", _FakeChatVertexAI)
    monkeypatch.setattr(agent, "service_account", _FakeServiceAccountModule)
    return _FakeChatVertexAI, _FakeCredentials


def test_build_llm_prefers_explicit_vertex_credentials(monkeypatch):
    get_settings.cache_clear()
    fake_chat, fake_creds = _fake_vertex_chat(monkeypatch)
    monkeypatch.setenv("LLM_MODEL", "gemini-3.5-flash")
    monkeypatch.setenv("VERTEX_PROJECT", "vertex-project")
    monkeypatch.setenv("VERTEX_LOCATION", "europe-west4")
    monkeypatch.setenv("VERTEX_CREDENTIALS", '{"type":"service_account","project_id":"explicit"}')
    monkeypatch.setenv("GCP_SA_JSON", '{"type":"service_account","project_id":"fallback"}')

    llm = _build_llm()

    assert isinstance(llm, fake_chat)
    assert llm.kwargs["model_name"] == "gemini-3.5-flash"
    assert llm.kwargs["project"] == "vertex-project"
    assert llm.kwargs["location"] == "europe-west4"
    assert isinstance(llm.kwargs["credentials"], fake_creds)
    assert llm.kwargs["credentials"].info["project_id"] == "explicit"
    assert llm.kwargs["credentials"].scopes == ["https://www.googleapis.com/auth/cloud-platform"]
    get_settings.cache_clear()


def test_build_llm_uses_adc_when_no_explicit_credentials(monkeypatch):
    get_settings.cache_clear()
    fake_chat, _ = _fake_vertex_chat(monkeypatch)
    monkeypatch.delenv("VERTEX_CREDENTIALS", raising=False)
    monkeypatch.delenv("GCP_SA_JSON", raising=False)
    monkeypatch.setenv("VERTEX_PROJECT", "adc-project")

    llm = _build_llm()

    assert isinstance(llm, fake_chat)
    assert llm.kwargs["credentials"] is None
    assert llm.kwargs["project"] == "adc-project"
    assert llm.kwargs["api_endpoint"] == "aiplatform.eu.rep.googleapis.com"
    get_settings.cache_clear()


def test_build_llm_falls_back_to_service_account_project_id(monkeypatch):
    get_settings.cache_clear()
    fake_chat, fake_creds = _fake_vertex_chat(monkeypatch)
    monkeypatch.delenv("VERTEX_CREDENTIALS", raising=False)
    monkeypatch.delenv("VERTEX_PROJECT", raising=False)
    monkeypatch.setenv("LLM_MODEL", "gemini-3.5-flash")
    monkeypatch.setenv("VERTEX_LOCATION", "eu")
    monkeypatch.setenv("GCP_SA_JSON", '{"type":"service_account","project_id":"sa-project"}')

    llm = _build_llm()

    assert isinstance(llm, fake_chat)
    assert llm.kwargs["project"] == "sa-project"
    assert llm.kwargs["location"] == "eu"
    assert isinstance(llm.kwargs["credentials"], fake_creds)
    get_settings.cache_clear()


def _fake_vertex_chat_with_tools(monkeypatch, failing_models):
    from langchain_core.runnables import RunnableLambda

    fake_chat, _ = _fake_vertex_chat(monkeypatch)
    built: list[dict] = []

    def _bind_tools(self, _tools):
        model = self.kwargs["model_name"]

        def _call(_messages):
            if model in failing_models:
                raise RuntimeError(f"429 Resource exhausted ({model})")
            return AIMessage(content=f"answered by {model}")

        return RunnableLambda(_call)

    original_init = fake_chat.__init__

    def _init(self, **kwargs):
        original_init(self, **kwargs)
        built.append(kwargs)

    monkeypatch.setattr(fake_chat, "__init__", _init)
    monkeypatch.setattr(fake_chat, "bind_tools", _bind_tools, raising=False)
    return built


def test_fallback_models_answer_in_order_when_earlier_ones_fail(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("LLM_MODEL", "gemini-3.8-flash")
    monkeypatch.setenv("LLM_FALLBACK_MODELS", "gemini-3.7-flash, gemini-3.5-flash")
    built = _fake_vertex_chat_with_tools(
        monkeypatch, failing_models={"gemini-3.8-flash", "gemini-3.7-flash"}
    )

    response = agent._bind_tools_with_fallbacks([]).invoke([HumanMessage(content="hi")])

    assert response.content == "answered by gemini-3.5-flash"
    assert [kwargs["model_name"] for kwargs in built] == [
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.5-flash",
    ]
    # Models with a fallback behind them fail over fast; the last keeps the
    # library's default retries.
    assert [kwargs.get("max_retries") for kwargs in built] == [1, 1, None]
    get_settings.cache_clear()


def test_healthy_primary_answers_without_touching_fallbacks(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("LLM_MODEL", "gemini-3.8-flash")
    monkeypatch.setenv("LLM_FALLBACK_MODELS", "gemini-3.7-flash,gemini-3.5-flash")
    _fake_vertex_chat_with_tools(monkeypatch, failing_models=set())

    response = agent._bind_tools_with_fallbacks([]).invoke([HumanMessage(content="hi")])

    assert response.content == "answered by gemini-3.8-flash"
    get_settings.cache_clear()


def test_no_fallback_models_builds_the_primary_alone(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("LLM_MODEL", "gemini-3.8-flash")
    monkeypatch.delenv("LLM_FALLBACK_MODELS", raising=False)
    built = _fake_vertex_chat_with_tools(monkeypatch, failing_models=set())

    agent._bind_tools_with_fallbacks([])

    assert [kwargs["model_name"] for kwargs in built] == ["gemini-3.8-flash"]
    assert "max_retries" not in built[0]
    get_settings.cache_clear()


def test_create_agent_graph_requires_bearer_token():
    with pytest.raises(ValueError):
        create_agent_graph(project_id="project-1", bearer_token="", llm=FakeLLM())


@pytest.mark.asyncio
async def test_create_agent_graph_binds_progress_tool_and_tool_is_callable():
    llm = SequenceLLM(responses=[AIMessage(content="done")])
    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )
    tool_map = {tool.name: tool for tool in llm.bound_tools}

    assert "sendProgressUpdate" in tool_map
    payload = await tool_map["sendProgressUpdate"].ainvoke(
        {
            "update": "I have a rough picture now.",
            "next_steps": "I will verify two more conversations.",
        }
    )
    assert payload == {
        "kind": "progress_update",
        "update": "I have a rough picture now.",
        "next_steps": "I will verify two more conversations.",
        "visible_to_user": True,
    }


def test_create_agent_graph_binds_edit_canvas_tool():
    llm = SequenceLLM(responses=[AIMessage(content="done")])
    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
    )
    tool_map = {tool.name: tool for tool in llm.bound_tools}

    assert "editCanvas" in tool_map
    assert "addToCanvas" in tool_map
    assert "removeFromCanvas" in tool_map


def test_create_agent_graph_canvas_disabled_strips_tools_and_prompt():
    llm = SequenceLLM(responses=[AIMessage(content="done")])
    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        canvas_enabled=False,
    )
    tool_names = {tool.name for tool in llm.bound_tools}

    assert not (agent.CANVAS_TOOL_NAMES & tool_names)
    prompt = agent.system_prompt_for(False)
    assert "canvas" not in prompt.lower()
    assert agent.system_prompt_for(True) == SYSTEM_PROMPT


@pytest.mark.asyncio
async def test_create_agent_graph_nudge_flow_can_continue_via_progress_tool_call():
    llm = SequenceLLM(
        responses=[
            _tool_call_response(1),
            _tool_call_response(2),
            _tool_call_response(3),
            _tool_call_response(4),
            _tool_call_response(5),
            _tool_call_response(6),
            _tool_call_response(
                7,
                tool_name="sendProgressUpdate",
                args={
                    "update": "I have a rough picture now.",
                    "next_steps": "I will verify two more conversations.",
                },
            ),
            AIMessage(content="done"),
        ]
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "thread-progress-tool-flow"}},
    )

    nudges = _extract_automatic_nudges(llm.invocations)
    assert len(nudges) == 1
    assert "6 tool calls" in nudges[0]
    assert result["messages"][-1].content == "done"
    assert not any(
        isinstance(getattr(message, "content", None), str)
        and message.content.startswith("<Automatic Nudge>")
        for message in result["messages"]
    )


@pytest.mark.asyncio
async def test_text_reply_after_a_nudge_is_the_answer_not_retried():
    llm = SequenceLLM(
        responses=[
            _tool_call_response(1),
            _tool_call_response(2),
            _tool_call_response(3),
            _tool_call_response(4),
            _tool_call_response(5),
            _tool_call_response(6),
            AIMessage(content="Here is what I found."),
        ]
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "thread-text-after-nudge"}},
    )

    nudges = _extract_automatic_nudges(llm.invocations)
    assert len(nudges) == 1
    assert "6 tool calls" in nudges[0]
    assert _count_corrective_retry_invocations(llm.invocations) == 0
    assert result["messages"][-1].content == "Here is what I found."


@pytest.mark.asyncio
async def test_nudges_never_reach_the_model_as_a_message():
    """A nudge sent as a user turn reads as the host speaking, and the model
    answers it in the chat. It rides in the system instruction instead."""
    llm = SequenceLLM(
        responses=[
            *[_tool_call_response(index) for index in range(1, 7)],
            AIMessage(content=""),
            AIMessage(content="done"),
        ]
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )

    await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "thread-nudge-channel"}},
    )

    for invocation in llm.invocations:
        humans = [m for m in invocation if getattr(m, "type", None) == "human"]
        assert [m.content for m in humans] == ["hello"]
        # Vertex rejects a request that ends on the model's own turn.
        assert getattr(invocation[-1], "type", None) != "ai"


@pytest.mark.asyncio
async def test_model_never_sees_its_own_empty_tool_call_turns():
    """Regression: Gemini reacted to empty AI tool-call turns in history with
    "Do not send empty messages." — the model input must carry placeholder
    text on those turns (tool_calls preserved)."""
    llm = SequenceLLM(
        responses=[
            _tool_call_response(1),
            AIMessage(content="done"),
        ]
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )
    await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "thread-placeholder"}},
    )

    final_invocation = llm.invocations[-1]
    ai_turns = [m for m in final_invocation if getattr(m, "type", None) == "ai"]
    assert ai_turns, "expected the prior tool-call turn in the model input"
    for turn in ai_turns:
        assert turn.content, "AI tool-call turn reached the model with empty content"
        assert turn.tool_calls, "tool_calls must be preserved on the placeholder turn"


def _empty_ai_turns(invocation: list[object]) -> list[object]:
    return [
        message
        for message in invocation
        if getattr(message, "type", None) == "ai"
        and not getattr(message, "tool_calls", None)
        and not getattr(message, "content", None)
    ]


@pytest.mark.asyncio
async def test_empty_nudge_reply_is_not_sent_back_in_the_retry_invocation():
    """Regression: an AI turn with no content and no tool calls serializes to a
    Vertex Content with zero parts, which 400s and kills the stream. Gemini
    returns exactly that shape to the automatic nudge sometimes."""
    llm = SequenceLLM(
        responses=[
            _tool_call_response(1),
            _tool_call_response(2),
            _tool_call_response(3),
            _tool_call_response(4),
            _tool_call_response(5),
            _tool_call_response(6),
            AIMessage(content=""),
            AIMessage(content="done"),
        ]
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )

    await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "thread-empty-nudge-reply"}},
    )

    assert _count_corrective_retry_invocations(llm.invocations) == 1
    for invocation in llm.invocations:
        assert not _empty_ai_turns(invocation), "empty AI turn reached the model"


@pytest.mark.parametrize(
    "content",
    [
        "",
        "   ",
        [],
        [""],
        [{"type": "text", "text": ""}],
        [{"type": "function_call_signature", "signature": "YWJj", "index": 0}],
    ],
    ids=[
        "empty-str",
        "blank-str",
        "empty-list",
        "list-of-empty-str",
        "empty-text-block",
        "signature-only-block",
    ],
)
@pytest.mark.asyncio
async def test_every_zero_part_content_shape_is_kept_out_of_the_model_input(content):
    """Each of these shapes serializes to a Vertex Content with zero parts
    (verified against langchain_google_vertexai), so each is the same 400."""
    llm = SequenceLLM(responses=[AIMessage(content="done")])
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )

    await graph.ainvoke(
        {
            "messages": [
                HumanMessage(content="hello"),
                AIMessage(content=content),
                HumanMessage(content="are you there?"),
            ]
        },
        config={"configurable": {"thread_id": f"thread-zero-parts-{content!r}"}},
    )

    # History holds exactly one AI turn, the zero-part one. It must be gone,
    # so the model input carries no AI turn at all.
    assert llm.invocations
    replayed_ai_turns = [
        message for message in llm.invocations[0] if getattr(message, "type", None) == "ai"
    ]
    assert not replayed_ai_turns, f"zero-part AI turn {content!r} reached the model"


@pytest.mark.parametrize(
    "content",
    [
        [{"type": "text", "text": "real answer"}],
        ["", {"type": "text", "text": "still says something"}],
        [{"type": "some_future_block"}],
    ],
    ids=["text-block", "mixed-blank-and-text", "unknown-block"],
)
@pytest.mark.asyncio
async def test_ai_turns_that_still_carry_a_part_are_not_dropped(content):
    """The drop must be narrow: anything that serializes to at least one part
    has to survive, or replayed history loses real turns."""
    llm = SequenceLLM(responses=[AIMessage(content="done")])
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )

    await graph.ainvoke(
        {
            "messages": [
                HumanMessage(content="hello"),
                AIMessage(content=content),
                HumanMessage(content="are you there?"),
            ]
        },
        config={"configurable": {"thread_id": f"thread-keeps-parts-{content!r}"}},
    )

    replayed_ai_turns = [
        message for message in llm.invocations[0] if getattr(message, "type", None) == "ai"
    ]
    assert len(replayed_ai_turns) == 1, f"dropped an AI turn that still had parts: {content!r}"


@pytest.mark.asyncio
async def test_empty_ai_turn_in_replayed_history_never_reaches_the_model():
    """Same 400, other entry point: an empty AI turn already in the thread's
    history must be dropped when the next turn replays it."""
    llm = SequenceLLM(responses=[AIMessage(content="done")])
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )

    await graph.ainvoke(
        {
            "messages": [
                HumanMessage(content="hello"),
                AIMessage(content=""),
                HumanMessage(content="are you there?"),
            ]
        },
        config={"configurable": {"thread_id": "thread-empty-history-turn"}},
    )

    assert llm.invocations
    for invocation in llm.invocations:
        assert not _empty_ai_turns(invocation), "empty AI turn reached the model"


@pytest.mark.asyncio
async def test_ambient_memory_is_injected_into_first_model_invocation():
    llm = SequenceLLM(responses=[AIMessage(content="done")])
    factory = MemoryClientFactory(
        {
            "memories": [
                {
                    "scope": "user",
                    "memory_key": "owner_spelling",
                    "content": "The owner's name is spelled Akshita.",
                    "updated_at": "2026-07-08T10:00:00Z",
                }
            ]
        }
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )

    await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "thread-ambient-memory"}},
    )

    first_system = next(
        message for message in llm.invocations[0] if isinstance(message, SystemMessage)
    )
    assert "## What you remember" in first_system.content
    assert "user/owner_spelling: The owner's name is spelled Akshita." in first_system.content
    assert factory.instances[0].list_memory_calls == ["project-1"]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_canvas_activity_is_injected_into_first_model_invocation():
    llm = SequenceLLM(responses=[AIMessage(content="done")])
    factory = CanvasActivityClientFactory(
        {
            "canvases": [
                {
                    "id": "canvas-1",
                    "name": "Pulse wall",
                    "recent_runs": [
                        {
                            "status": "ok",
                            "detail": "rejections: quote[3] not found verbatim",
                            "started_at": "2026-07-08T10:00:00Z",
                        }
                    ],
                }
            ]
        }
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
        chat_id="chat-1",
    )

    await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "thread-canvas-activity"}},
    )

    first_system = next(
        message for message in llm.invocations[0] if isinstance(message, SystemMessage)
    )
    assert "## Canvas activity since last turn" in first_system.content
    assert "Pulse wall (canvas-1)" in first_system.content
    assert "rejections: quote[3] not found verbatim" in first_system.content
    assert factory.instances[1].canvas_activity_calls == [
        {"project_id": "project-1", "chat_id": "chat-1", "limit": 5}
    ]
    assert factory.instances[1].closed is True


def test_system_prompt_forbids_claiming_actions_without_successful_tool_result():
    prompt = SYSTEM_PROMPT.lower()
    assert "only say you saved, logged, proposed, updated" in prompt
    assert "corresponding action returned success in this turn" in prompt
    assert "akshita" in prompt


def test_system_prompt_contains_canvas_one_question_rule_and_counterexamples():
    prompt = " ".join(SYSTEM_PROMPT.lower().split())
    assert "canvas activity since last turn" in prompt
    assert "at most one pointed" in prompt
    assert "question in the same turn" in prompt
    assert "real fork" in prompt
    assert "never ask permission to do something you can already do" in prompt
    assert "never ask more than one question" in prompt
    assert "never ask when there is no fork" in prompt
    assert "never invent canvas activity" in prompt


def test_canvas_activity_section_renders_run_details_and_truncates_detail():
    section = _format_canvas_activity_section(
        {
            "canvases": [
                {
                    "id": "canvas-1",
                    "name": "Pulse wall",
                    "recent_runs": [
                        {
                            "status": "ok",
                            "detail": "rejections: quote[3] not found verbatim",
                            "started_at": "2026-07-08T10:00:00Z",
                        },
                        {
                            "status": "no_op",
                            "detail": "0 quote(s), 0 concept change(s)",
                            "started_at": "2026-07-08T10:05:00Z",
                        },
                    ],
                }
            ]
        }
    )

    assert "## Canvas activity since last turn" in section
    assert "Pulse wall (canvas-1)" in section
    assert "ok at 2026-07-08T10:00:00Z: rejections: quote[3] not found verbatim" in section
    assert "no_op at 2026-07-08T10:05:00Z: 0 quote(s), 0 concept change(s)" in section


def test_canvas_activity_section_returns_empty_without_canvas_runs():
    assert _format_canvas_activity_section({"canvases": []}) == ""
    assert _format_canvas_activity_section({"canvases": [{"id": "canvas-1"}]}) == ""


def test_fused_parallel_tool_call_name_is_split_with_concatenated_json_args():
    message = AIMessage.model_construct(
        content="",
        tool_calls=[
            {
                "id": "call-fused",
                "name": "noteInsightproposeCanvas",
                "args": (
                    '{"kind":"wish","content":"The host wants a wall."}'
                    '{"brief":"Create a wall.","expires_at":"2026-07-10T00:00:00Z"}'
                ),
            }
        ],
    )

    normalized = _normalize_fused_tool_calls(
        message,
        {"noteInsight", "proposeCanvas", "remember"},
    )

    assert [call["name"] for call in normalized.tool_calls] == [
        "noteInsight",
        "proposeCanvas",
    ]
    assert normalized.tool_calls[0]["args"] == {
        "kind": "wish",
        "content": "The host wants a wall.",
    }
    assert normalized.tool_calls[1]["args"] == {
        "brief": "Create a wall.",
        "expires_at": "2026-07-10T00:00:00Z",
    }


def test_fused_invalid_tool_call_is_recovered_when_args_are_concatenated_json():
    message = AIMessage(
        content="",
        invalid_tool_calls=[
            {
                "id": "call-fused",
                "name": "noteInsightproposeCanvas",
                "args": '{"kind":"wish","content":"Need a wall."}{"brief":"Create a wall."}',
                "error": "Could not parse tool args",
            }
        ],
    )

    normalized = _normalize_fused_tool_calls(
        message,
        {"noteInsight", "proposeCanvas", "remember"},
    )

    assert normalized.invalid_tool_calls == []
    assert [call["name"] for call in normalized.tool_calls] == [
        "noteInsight",
        "proposeCanvas",
    ]


def test_fused_old_tool_name_in_replay_is_split_and_renamed_to_new_names():
    # A replayed history may still carry the pre-wave-32 fused name; splitting
    # against the recognized set (new + old) must land on the new names.
    recognized = {
        "noteInsight",
        "proposeCanvas",
        "remember",
    } | set(agent.TOOL_NAME_RENAMES.keys())
    message = AIMessage.model_construct(
        content="",
        tool_calls=[
            {
                "id": "call-fused",
                "name": "recordInsightproposeCanvas",
                "args": (
                    '{"kind":"wish","content":"The host wants a wall."}'
                    '{"brief":"Create a wall."}'
                ),
            }
        ],
    )

    normalized = _normalize_fused_tool_calls(message, recognized)

    assert [call["name"] for call in normalized.tool_calls] == [
        "noteInsight",
        "proposeCanvas",
    ]


def test_replayed_history_old_tool_names_are_normalized_to_new_names():
    from langchain_core.messages import ToolMessage

    from agent import _normalize_message_tool_names

    recognized = {"noteInsight", "findConversationsByKeywords"} | set(
        agent.TOOL_NAME_RENAMES.keys()
    )

    ai_message = AIMessage.model_construct(
        content="(calling tools)",
        tool_calls=[
            {"id": "call-1", "name": "findConvosByKeywords", "args": {"keywords": "x"}},
            {"id": "call-2", "name": "recordInsight", "args": {"kind": "wish", "content": "y"}},
        ],
    )
    normalized_ai = _normalize_message_tool_names(ai_message, recognized)
    assert [call["name"] for call in normalized_ai.tool_calls] == [
        "findConversationsByKeywords",
        "noteInsight",
    ]

    tool_message = ToolMessage(
        content="{}", name="reachOutToDembrane", tool_call_id="call-3"
    )
    normalized_tool = _normalize_message_tool_names(tool_message, recognized)
    assert normalized_tool.name == "reachOutToDembraneSupport"


@pytest.mark.asyncio
async def test_ack_and_update_plan_payloads():
    llm = SequenceLLM(responses=[AIMessage(content="done")])
    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )
    tool_map = {tool.name: tool for tool in llm.bound_tools}

    ack_payload = await tool_map["ack"].ainvoke(
        {"message": "You want the main themes.", "plan": ["Read the conversations", " ", "Group themes"]}
    )
    assert ack_payload == {
        "kind": "progress_update",
        "update": "You want the main themes.",
        "plan": ["Read the conversations", "Group themes"],
        "visible_to_user": True,
    }
    plan_payload = await tool_map["updatePlan"].ainvoke(
        {"steps": ["Read the conversations", "Group themes"], "done": 5, "note": "12 read"}
    )
    assert plan_payload == {
        "kind": "plan",
        "steps": ["Read the conversations", "Group themes"],
        "done": 2,
        "note": "12 read",
        "visible_to_user": False,
    }


def _tool_messages(result) -> list:
    return [m for m in result["messages"] if getattr(m, "type", None) == "tool"]


@pytest.mark.asyncio
async def test_identical_call_is_answered_from_the_earlier_result_not_run_again(monkeypatch):
    runs: list[str] = []
    llm = SequenceLLM(
        responses=[
            _tool_call_response(1, tool_name="readGoal"),
            _tool_call_response(2, tool_name="readGoal"),
            AIMessage(content="done"),
        ]
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )
    tool_map = {tool.name: tool for tool in llm.bound_tools}
    original = tool_map["readGoal"].coroutine

    async def _counting(*args, **kwargs):
        runs.append("readGoal")
        return {"goal": "g"}

    monkeypatch.setattr(tool_map["readGoal"], "coroutine", _counting)

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "repeat-guard"}},
    )

    assert runs == ["readGoal"]
    tool_messages = _tool_messages(result)
    assert agent.REPEATED_CALL_MESSAGE in tool_messages[1].content
    assert result["messages"][-1].content == "done"
    assert original is not None


@pytest.mark.asyncio
async def test_third_repeat_tells_the_model_to_stop_and_answer(monkeypatch):
    llm = SequenceLLM(
        responses=[
            _tool_call_response(1, tool_name="readGoal"),
            _tool_call_response(2, tool_name="readGoal"),
            _tool_call_response(3, tool_name="readGoal"),
            _tool_call_response(4, tool_name="readGoal"),
            AIMessage(content="done"),
        ]
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )
    tool_map = {tool.name: tool for tool in llm.bound_tools}

    async def _goal(*args, **kwargs):
        return {"goal": "g"}

    monkeypatch.setattr(tool_map["readGoal"], "coroutine", _goal)

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "repeat-stop"}},
    )

    contents = [m.content for m in _tool_messages(result)]
    assert contents[1] == agent.REPEATED_CALL_MESSAGE
    assert contents[2] == agent.REPEATED_CALL_MESSAGE
    assert contents[3] == agent.REPEATED_CALL_STOP_MESSAGE


@pytest.mark.asyncio
async def test_same_result_three_times_in_a_row_adds_a_note(monkeypatch):
    llm = SequenceLLM(
        responses=[
            _tool_call_response(1, tool_name="findConversationsByKeywords", args={"keywords": "a"}),
            _tool_call_response(2, tool_name="findConversationsByKeywords", args={"keywords": "b"}),
            _tool_call_response(3, tool_name="findConversationsByKeywords", args={"keywords": "c"}),
            AIMessage(content="done"),
        ]
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )
    tool_map = {tool.name: tool for tool in llm.bound_tools}

    async def _empty(*args, **kwargs):
        return {"conversations": []}

    monkeypatch.setattr(tool_map["findConversationsByKeywords"], "coroutine", _empty)

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "same-result"}},
    )

    contents = [m.content for m in _tool_messages(result)]
    assert "returned the same result" not in contents[1]
    assert "returned the same result" in contents[2]


@pytest.mark.asyncio
async def test_repeated_host_updates_are_never_skipped():
    llm = SequenceLLM(
        responses=[
            _tool_call_response(1, tool_name="updatePlan", args={"steps": ["a", "b"], "done": 1}),
            _tool_call_response(2, tool_name="updatePlan", args={"steps": ["a", "b"], "done": 1}),
            AIMessage(content="done"),
        ]
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
    )

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "host-updates"}},
    )

    assert all(
        agent.REPEATED_CALL_MESSAGE not in str(m.content) for m in _tool_messages(result)
    )


# The chat places cards by when a tool ran, so a message can land before or
# after the card it mentions. Any position word the model reads about the UI
# will be wrong some of the time; the prompt and tool descriptions carry none.
POSITION_WORDS = re.compile(
    r"\b(above|below|beneath|underneath|to the (left|right))\b", re.IGNORECASE
)
# The one allowed use: the rule that forbids position words quotes them.
POSITION_RULE_QUOTE = '"above", "below", "here", or "on the left/right"'


@pytest.mark.parametrize("canvas_enabled", [True, False])
def test_prompt_never_tells_the_model_where_ui_lands(canvas_enabled):
    prompt = agent.system_prompt_for(canvas_enabled).replace(POSITION_RULE_QUOTE, "")
    offending = [line for line in prompt.splitlines() if POSITION_WORDS.search(line)]
    # "Be honest above all" is about priority, not layout.
    offending = [line for line in offending if "honest above all" not in line]
    assert offending == []


def test_tool_descriptions_never_tell_the_model_where_ui_lands():
    llm = SequenceLLM(responses=[AIMessage(content="done")])
    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=MemoryClientFactory(),
        canvas_enabled=True,
    )
    offending = {
        tool.name: tool.description
        for tool in llm.bound_tools
        if POSITION_WORDS.search(tool.description or "")
    }
    assert offending == {}


def test_repetition_guard_messages_carry_no_position_words():
    for message in (agent.REPEATED_CALL_MESSAGE, agent.REPEATED_CALL_STOP_MESSAGE):
        assert not POSITION_WORDS.search(message)
