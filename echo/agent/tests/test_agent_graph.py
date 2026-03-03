import pytest
from langchain_core.messages import AIMessage, HumanMessage

from agent import POST_NUDGE_CONTINUATION_SYSTEM_PROMPT, create_agent_graph


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
