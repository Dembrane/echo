import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from agent import create_agent_graph


class FakeLLM:
    def bind_tools(self, _tools):
        return self

    async def ainvoke(self, _messages):
        return AIMessage(content="mocked-response")


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
