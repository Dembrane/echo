import pytest
from langchain_core.messages import AIMessage, HumanMessage

import agent
from agent import POST_NUDGE_CONTINUATION_SYSTEM_PROMPT, _build_llm, create_agent_graph


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


def test_build_llm_prefers_explicit_vertex_credentials(monkeypatch, tmp_path):
    class _FakeChatAnthropicVertex:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs

    class _FakeCredentialsFactory:
        calls: list[dict[str, object]] = []

        @classmethod
        def from_service_account_info(cls, value, scopes=None):
            cls.calls.append(
                {
                    "scopes": scopes,
                    "value": value,
                }
            )
            return {"credentials": value, "scopes": scopes}

    class _FakeVertexModelGardenModule:
        ChatAnthropicVertex = _FakeChatAnthropicVertex

    class _FakeServiceAccountModule:
        Credentials = _FakeCredentialsFactory

    def _fake_import(name: str):
        if name == "langchain_google_vertexai.model_garden":
            return _FakeVertexModelGardenModule
        if name == "google.oauth2.service_account":
            return _FakeServiceAccountModule
        raise ModuleNotFoundError(name)

    monkeypatch.chdir(tmp_path)
    agent.get_settings.cache_clear()
    monkeypatch.setenv("LLM_MODEL", "claude-opus-4-6")
    monkeypatch.setenv("VERTEX_PROJECT", "vertex-project")
    monkeypatch.setenv("VERTEX_LOCATION", "europe-west4")
    monkeypatch.setenv("VERTEX_CREDENTIALS", '{"type":"service_account","project_id":"explicit"}')
    monkeypatch.setenv("GCP_SA_JSON", '{"type":"service_account","project_id":"fallback"}')
    monkeypatch.setattr(agent.importlib, "import_module", _fake_import)

    llm = _build_llm()

    assert isinstance(llm, _FakeChatAnthropicVertex)
    assert llm.kwargs["model_name"] == "claude-opus-4-6"
    assert llm.kwargs["project"] == "vertex-project"
    assert llm.kwargs["location"] == "europe-west4"
    assert llm.kwargs["credentials"] == {
        "credentials": {
            "type": "service_account",
            "project_id": "explicit",
        },
        "scopes": ["https://www.googleapis.com/auth/cloud-platform"],
    }
    assert _FakeCredentialsFactory.calls == [
        {
            "scopes": ["https://www.googleapis.com/auth/cloud-platform"],
            "value": {
                "type": "service_account",
                "project_id": "explicit",
            },
        }
    ]
    agent.get_settings.cache_clear()


def test_build_llm_uses_adc_when_no_explicit_credentials(monkeypatch, tmp_path):
    class _FakeChatAnthropicVertex:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs

    class _FakeVertexModelGardenModule:
        ChatAnthropicVertex = _FakeChatAnthropicVertex

    class _FakeServiceAccountModule:
        class Credentials:
            @classmethod
            def from_service_account_info(cls, value):
                raise AssertionError(f"Unexpected explicit credentials: {value}")

    def _fake_import(name: str):
        if name == "langchain_google_vertexai.model_garden":
            return _FakeVertexModelGardenModule
        if name == "google.oauth2.service_account":
            return _FakeServiceAccountModule
        raise ModuleNotFoundError(name)

    monkeypatch.chdir(tmp_path)
    agent.get_settings.cache_clear()
    monkeypatch.delenv("VERTEX_CREDENTIALS", raising=False)
    monkeypatch.setenv("GCP_SA_JSON", "")
    monkeypatch.setenv("LLM_MODEL", "claude-opus-4-6")
    monkeypatch.setenv("VERTEX_PROJECT", "vertex-project")
    monkeypatch.setenv("VERTEX_LOCATION", "us-central1")
    monkeypatch.setattr(agent.importlib, "import_module", _fake_import)

    llm = _build_llm()

    assert isinstance(llm, _FakeChatAnthropicVertex)
    assert llm.kwargs["credentials"] is None
    assert llm.kwargs["model_name"] == "claude-opus-4-6"
    assert llm.kwargs["project"] == "vertex-project"
    assert llm.kwargs["location"] == "us-central1"
    agent.get_settings.cache_clear()


def test_build_llm_falls_back_to_service_account_project_id(monkeypatch, tmp_path):
    class _FakeChatAnthropicVertex:
        def __init__(self, **kwargs) -> None:
            self.kwargs = kwargs

    class _FakeVertexModelGardenModule:
        ChatAnthropicVertex = _FakeChatAnthropicVertex

    class _FakeCredentialsFactory:
        calls: list[dict[str, str]] = []

        @classmethod
        def from_service_account_info(cls, value, scopes=None):
            cls.calls.append(
                {
                    "scopes": scopes,
                    "value": value,
                }
            )
            return {"credentials": value, "scopes": scopes}

    class _FakeServiceAccountModule:
        Credentials = _FakeCredentialsFactory

    def _fake_import(name: str):
        if name == "langchain_google_vertexai.model_garden":
            return _FakeVertexModelGardenModule
        if name == "google.oauth2.service_account":
            return _FakeServiceAccountModule
        raise ModuleNotFoundError(name)

    monkeypatch.chdir(tmp_path)
    agent.get_settings.cache_clear()
    monkeypatch.setenv("VERTEX_PROJECT", "")
    monkeypatch.delenv("VERTEX_CREDENTIALS", raising=False)
    monkeypatch.setenv("LLM_MODEL", "claude-opus-4-6")
    monkeypatch.setenv("VERTEX_LOCATION", "us-central1")
    monkeypatch.setenv("GCP_SA_JSON", '{"type":"service_account","project_id":"sa-project"}')
    monkeypatch.setattr(agent.importlib, "import_module", _fake_import)

    llm = _build_llm()

    assert isinstance(llm, _FakeChatAnthropicVertex)
    assert llm.kwargs["model_name"] == "claude-opus-4-6"
    assert llm.kwargs["project"] == "sa-project"
    assert llm.kwargs["location"] == "us-central1"
    assert llm.kwargs["credentials"] == {
        "credentials": {
            "type": "service_account",
            "project_id": "sa-project",
        },
        "scopes": ["https://www.googleapis.com/auth/cloud-platform"],
    }
    assert _FakeCredentialsFactory.calls == [
        {
            "scopes": ["https://www.googleapis.com/auth/cloud-platform"],
            "value": {
                "type": "service_account",
                "project_id": "sa-project",
            },
        }
    ]
    agent.get_settings.cache_clear()


@pytest.mark.asyncio
async def test_create_agent_graph_uses_mocked_llm_deterministically():
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=FakeLLM(),
    )

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "thread-test-1"}},
    )

    # System message is used for LLM invocation but not persisted in state to avoid duplication
    assert result["messages"][-1].content == "mocked-response"
    assert any(msg.content == "mocked-response" for msg in result["messages"])


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
            _tool_call_response(
                5,
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
    )

    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "thread-progress-tool-flow"}},
    )

    nudges = _extract_automatic_nudges(llm.invocations)
    assert len(nudges) == 1
    assert "4 tool calls" in nudges[0]
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
            AIMessage(content="Progress update but no tool call."),
            AIMessage(content="Still text-only after retry."),
        ]
    )
    graph = create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
    )

    await graph.ainvoke(
        {"messages": [HumanMessage(content="hello")]},
        config={"configurable": {"thread_id": "thread-single-retry-after-nudge"}},
    )

    nudges = _extract_automatic_nudges(llm.invocations)
    assert len(nudges) >= 1
    assert all("4 tool calls" in nudge for nudge in nudges)
    assert _count_corrective_retry_invocations(llm.invocations) == 1
