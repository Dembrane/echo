import pytest
from langchain_core.messages import AIMessage

from agent import SYSTEM_PROMPT, create_agent_graph


class _CaptureLLM:
    def __init__(self):
        self.bound_tools = []

    def bind_tools(self, tools):
        self.bound_tools = tools
        return self

    async def ainvoke(self, _messages):
        return AIMessage(content="unused")


class _FakeEchoClient:
    def __init__(
        self,
        *,
        bearer_token: str,
        search_payload: dict | None,
        search_payload_by_query: dict[str, dict] | None,
        transcripts: dict[str, str],
    ):
        self.bearer_token = bearer_token
        self.search_payload = search_payload or {}
        self.search_payload_by_query = search_payload_by_query or {}
        self.transcripts = transcripts
        self.search_calls: list[dict[str, object]] = []
        self.transcript_calls: list[str] = []
        self.closed = False

    async def search_home(self, query: str, limit: int = 5) -> dict:
        self.search_calls.append({"query": query, "limit": limit})
        return self.search_payload_by_query.get(query, self.search_payload)

    async def get_conversation_transcript(self, conversation_id: str) -> str:
        self.transcript_calls.append(conversation_id)
        return self.transcripts[conversation_id]

    async def close(self) -> None:
        self.closed = True


class _FakeEchoClientFactory:
    def __init__(
        self,
        *,
        search_payload: dict | None,
        search_payload_by_query: dict[str, dict] | None = None,
        transcripts: dict[str, str],
    ):
        self.search_payload = search_payload
        self.search_payload_by_query = search_payload_by_query
        self.transcripts = transcripts
        self.instances: list[_FakeEchoClient] = []

    def __call__(self, bearer_token: str) -> _FakeEchoClient:
        client = _FakeEchoClient(
            bearer_token=bearer_token,
            search_payload=self.search_payload,
            search_payload_by_query=self.search_payload_by_query,
            transcripts=self.transcripts,
        )
        self.instances.append(client)
        return client


def _tool_map(tools) -> dict[str, object]:  # noqa: ANN001
    return {tool.name: tool for tool in tools}


def test_system_prompt_contains_research_and_quote_directives():
    prompt = SYSTEM_PROMPT.lower()
    assert "break down user intent" in prompt
    assert "subquestions" in prompt
    assert "derive a strategy" in prompt
    assert "adapt your research course" in prompt
    assert "2-5 short verbatim quotes" in prompt
    assert "[conversation_id:<id>]" in SYSTEM_PROMPT
    assert "never fabricate quotes" in prompt


@pytest.mark.asyncio
async def test_find_convos_by_keywords_filters_to_current_project():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={
            "conversations": [
                {
                    "id": "conv-1",
                    "projectId": "project-1",
                    "projectName": "Project One",
                    "displayLabel": "Alice",
                    "status": "done",
                    "startedAt": "2026-01-01T00:00:00Z",
                    "lastChunkAt": "2026-01-01T01:00:00Z",
                    "summary": "summary one",
                },
                {
                    "id": "conv-2",
                    "projectId": "project-2",
                    "projectName": "Project Two",
                    "displayLabel": "Bob",
                    "status": "done",
                    "startedAt": "2026-01-02T00:00:00Z",
                    "lastChunkAt": "2026-01-02T01:00:00Z",
                    "summary": "summary two",
                },
            ]
        },
        transcripts={},
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["findConvosByKeywords"].ainvoke({"keywords": "policy", "limit": 7})

    assert result["project_id"] == "project-1"
    assert result["count"] == 1
    assert result["conversations"][0]["conversation_id"] == "conv-1"
    assert factory.instances[0].search_calls == [{"query": "policy", "limit": 7}]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_find_convos_by_keywords_uses_transcript_hits_with_project_scoping():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={
            "conversations": [],
            "transcripts": [
                {"conversationId": "conv-1"},
                {"conversationId": "conv-2"},
                {"conversationId": "conv-1"},
            ],
        },
        search_payload_by_query={
            "conv-1": {
                "conversations": [
                    {
                        "id": "conv-1",
                        "projectId": "project-1",
                        "projectName": "Project One",
                        "displayLabel": "Alice",
                        "status": "done",
                        "summary": "talked about budget",
                    }
                ]
            },
            "conv-2": {
                "conversations": [
                    {
                        "id": "conv-2",
                        "projectId": "project-2",
                        "projectName": "Project Two",
                        "displayLabel": "Bob",
                        "status": "done",
                        "summary": "other project",
                    }
                ]
            },
        },
        transcripts={},
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["findConvosByKeywords"].ainvoke({"keywords": "budget", "limit": 5})

    assert result["project_id"] == "project-1"
    assert result["count"] == 1
    assert result["conversations"][0]["conversation_id"] == "conv-1"
    assert factory.instances[0].search_calls == [
        {"query": "budget", "limit": 5},
        {"query": "conv-1", "limit": 20},
        {"query": "conv-2", "limit": 20},
    ]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_list_convo_summary_returns_nullable_summary_and_exact_match():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={
            "conversations": [
                {
                    "id": "conv-12",
                    "projectId": "project-1",
                    "displayLabel": "Partial Match",
                    "status": "done",
                    "summary": "wrong match",
                },
                {
                    "id": "conv-1",
                    "projectId": "project-1",
                    "displayLabel": "Exact Match",
                    "status": "done",
                    "summary": None,
                },
            ]
        },
        transcripts={},
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["listConvoSummary"].ainvoke({"conversation_id": "conv-1"})

    assert result["conversation"]["conversation_id"] == "conv-1"
    assert result["conversation"]["summary"] is None
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_list_convo_full_transcript_returns_text_for_project_conversation():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={
            "conversations": [
                {
                    "id": "conv-1",
                    "projectId": "project-1",
                    "displayLabel": "Alice",
                    "status": "done",
                    "summary": "summary",
                }
            ]
        },
        transcripts={"conv-1": "line one\nline two"},
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["listConvoFullTranscript"].ainvoke({"conversation_id": "conv-1"})

    assert result["project_id"] == "project-1"
    assert result["conversation_id"] == "conv-1"
    assert result["transcript"] == "line one\nline two"
    assert all(instance.closed for instance in factory.instances)


@pytest.mark.asyncio
async def test_list_convo_summary_raises_for_out_of_scope_or_missing_conversation():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={
            "conversations": [
                {
                    "id": "conv-9",
                    "projectId": "other-project",
                    "displayLabel": "Other",
                    "status": "done",
                    "summary": "other",
                }
            ]
        },
        transcripts={},
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    with pytest.raises(ValueError, match="Conversation not found in current project scope"):
        await tools["listConvoSummary"].ainvoke({"conversation_id": "conv-9"})

    with pytest.raises(ValueError, match="Conversation not found in current project scope"):
        await tools["listConvoFullTranscript"].ainvoke({"conversation_id": "conv-9"})
