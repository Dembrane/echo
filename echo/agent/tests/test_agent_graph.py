import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

import agent
from agent import (
    POST_NUDGE_CONTINUATION_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    _build_llm,
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


def _extract_automatic_nudges(invocations: list[list[object]]) -> list[str]:
    nudges: list[str] = []
    for invocation in invocations:
        for message in invocation:
            if getattr(message, "type", None) != "human":
                continue
            content = getattr(message, "content", None)
            if isinstance(content, str) and content.startswith("<Automatic Nudge>"):
                nudges.append(content)
    return nudges


def _count_corrective_retry_invocations(invocations: list[list[object]]) -> int:
    count = 0
    for invocation in invocations:
        if any(
            getattr(message, "type", None) == "system"
            and getattr(message, "content", None) == POST_NUDGE_CONTINUATION_SYSTEM_PROMPT
            for message in invocation
        ):
            count += 1
    return count


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

    monkeypatch.setattr(agent, "ChatVertexAI", _FakeChatVertexAI)
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
    assert llm.kwargs["api_endpoint"] == "aiplatform.googleapis.com"
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
async def test_create_agent_graph_retries_once_after_nudge_when_model_returns_text_only():
    llm = SequenceLLM(
        responses=[
            _tool_call_response(1),
            _tool_call_response(2),
            _tool_call_response(3),
            _tool_call_response(4),
            _tool_call_response(5),
            _tool_call_response(6),
            AIMessage(content="Progress update but no tool call."),
            AIMessage(content="Still text-only after retry."),
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
        config={"configurable": {"thread_id": "thread-single-retry-after-nudge"}},
    )

    nudges = _extract_automatic_nudges(llm.invocations)
    assert len(nudges) >= 1
    assert all("6 tool calls" in nudge for nudge in nudges)
    assert _count_corrective_retry_invocations(llm.invocations) == 1


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


def test_system_prompt_forbids_claiming_actions_without_successful_tool_result():
    prompt = SYSTEM_PROMPT.lower()
    assert "only say you saved, logged, proposed, updated" in prompt
    assert "corresponding action returned success in this turn" in prompt
    assert "akshita" in prompt


def test_fused_parallel_tool_call_name_is_split_with_concatenated_json_args():
    message = AIMessage.model_construct(
        content="",
        tool_calls=[
            {
                "id": "call-fused",
                "name": "recordInsightproposeCanvas",
                "args": (
                    '{"kind":"wish","content":"The host wants a wall."}'
                    '{"brief":"Create a wall.","expires_at":"2026-07-10T00:00:00Z"}'
                ),
            }
        ],
    )

    normalized = _normalize_fused_tool_calls(
        message,
        {"recordInsight", "proposeCanvas", "remember"},
    )

    assert [call["name"] for call in normalized.tool_calls] == [
        "recordInsight",
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
                "name": "recordInsightproposeCanvas",
                "args": '{"kind":"wish","content":"Need a wall."}{"brief":"Create a wall."}',
                "error": "Could not parse tool args",
            }
        ],
    )

    normalized = _normalize_fused_tool_calls(
        message,
        {"recordInsight", "proposeCanvas", "remember"},
    )

    assert normalized.invalid_tool_calls == []
    assert [call["name"] for call in normalized.tool_calls] == [
        "recordInsight",
        "proposeCanvas",
    ]
