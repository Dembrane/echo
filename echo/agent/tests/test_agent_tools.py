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
        project_conversations_payload: dict | None,
        project_conversations_payload_by_id: dict[str, dict] | None,
        project_conversations_payload_by_transcript_query: dict[str, dict] | None,
    ):
        self.bearer_token = bearer_token
        self.search_payload = search_payload or {}
        self.search_payload_by_query = search_payload_by_query or {}
        self.transcripts = transcripts
        self.project_conversations_payload = project_conversations_payload or {}
        self.project_conversations_payload_by_id = project_conversations_payload_by_id or {}
        self.project_conversations_payload_by_transcript_query = (
            project_conversations_payload_by_transcript_query or {}
        )
        self.search_calls: list[dict[str, object]] = []
        self.transcript_calls: list[str] = []
        self.project_conversations_calls: list[dict[str, object]] = []
        self.closed = False

    async def search_home(self, query: str, limit: int = 5) -> dict:
        self.search_calls.append({"query": query, "limit": limit})
        return self.search_payload_by_query.get(query, self.search_payload)

    async def get_conversation_transcript(self, conversation_id: str) -> str:
        self.transcript_calls.append(conversation_id)
        return self.transcripts[conversation_id]

    async def list_project_conversations(
        self,
        project_id: str,
        limit: int = 20,
        conversation_id: str | None = None,
        transcript_query: str | None = None,
    ) -> dict:
        self.project_conversations_calls.append(
            {
                "project_id": project_id,
                "limit": limit,
                "conversation_id": conversation_id,
                "transcript_query": transcript_query,
            }
        )
        if conversation_id and conversation_id in self.project_conversations_payload_by_id:
            return self.project_conversations_payload_by_id[conversation_id]
        if (
            transcript_query
            and transcript_query in self.project_conversations_payload_by_transcript_query
        ):
            return self.project_conversations_payload_by_transcript_query[transcript_query]
        return self.project_conversations_payload

    async def close(self) -> None:
        self.closed = True


class _FakeEchoClientFactory:
    def __init__(
        self,
        *,
        search_payload: dict | None,
        search_payload_by_query: dict[str, dict] | None = None,
        transcripts: dict[str, str],
        project_conversations_payload: dict | None = None,
        project_conversations_payload_by_id: dict[str, dict] | None = None,
        project_conversations_payload_by_transcript_query: dict[str, dict] | None = None,
    ):
        self.search_payload = search_payload
        self.search_payload_by_query = search_payload_by_query
        self.transcripts = transcripts
        self.project_conversations_payload = project_conversations_payload
        self.project_conversations_payload_by_id = project_conversations_payload_by_id
        self.project_conversations_payload_by_transcript_query = (
            project_conversations_payload_by_transcript_query
        )
        self.instances: list[_FakeEchoClient] = []

    def __call__(self, bearer_token: str) -> _FakeEchoClient:
        client = _FakeEchoClient(
            bearer_token=bearer_token,
            search_payload=self.search_payload,
            search_payload_by_query=self.search_payload_by_query,
            transcripts=self.transcripts,
            project_conversations_payload=self.project_conversations_payload,
            project_conversations_payload_by_id=self.project_conversations_payload_by_id,
            project_conversations_payload_by_transcript_query=self.project_conversations_payload_by_transcript_query,
        )
        self.instances.append(client)
        return client


def _tool_map(tools) -> dict[str, object]:  # noqa: ANN001
    return {tool.name: tool for tool in tools}


def test_system_prompt_contains_conversational_and_research_directives():
    prompt = SYSTEM_PROMPT.lower()
    # Conversational-first behavior
    assert "conversational" in prompt
    assert "greetings" in prompt
    assert "do not use tools for greetings" in prompt
    # Research guidelines still present
    assert "2-5 short verbatim quotes" in prompt
    assert "[conversation_id:<id>]" in SYSTEM_PROMPT
    assert "never fabricate quotes" in prompt
    # Project context awareness
    assert "project context" in prompt
    assert "background info" in prompt


@pytest.mark.asyncio
async def test_find_convos_by_keywords_filters_to_current_project():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        project_conversations_payload_by_transcript_query={
            "policy": {
                "project_id": "project-1",
                "count": 1,
                "conversations": [
                    {
                        "conversation_id": "conv-1",
                        "participant_name": "Alice",
                        "status": "done",
                        "summary": "summary one",
                        "started_at": "2026-01-01T00:00:00Z",
                        "last_chunk_at": "2026-01-01T01:00:00Z",
                    }
                ],
            }
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
    assert factory.instances[0].search_calls == []
    assert factory.instances[0].project_conversations_calls == [
        {
            "project_id": "project-1",
            "limit": 7,
            "conversation_id": None,
            "transcript_query": "policy",
        }
    ]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_find_convos_by_keywords_uses_single_transcript_query_call_for_long_input():
    llm = _CaptureLLM()
    long_query = "Bad Bunny Super Bowl halftime show Dembrane TPUSA Turning Point USA"
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        project_conversations_payload_by_transcript_query={
            long_query: {
                "project_id": "project-1",
                "count": 2,
                "conversations": [
                    {
                        "conversation_id": "conv-1",
                        "participant_name": "Alice",
                        "status": "done",
                        "summary": "talked about budget",
                        "started_at": "2026-01-01T00:00:00Z",
                        "last_chunk_at": "2026-01-01T01:00:00Z",
                    },
                    {
                        "conversation_id": "conv-2",
                        "participant_name": "Bob",
                        "status": "done",
                        "summary": "other conversation",
                        "started_at": "2026-01-02T00:00:00Z",
                        "last_chunk_at": "2026-01-02T01:00:00Z",
                    },
                ],
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

    result = await tools["findConvosByKeywords"].ainvoke({"keywords": long_query, "limit": 5})

    assert result["project_id"] == "project-1"
    assert result["count"] == 2
    assert [conversation["conversation_id"] for conversation in result["conversations"]] == [
        "conv-1",
        "conv-2",
    ]
    assert factory.instances[0].search_calls == []
    assert factory.instances[0].project_conversations_calls == [
        {
            "project_id": "project-1",
            "limit": 5,
            "conversation_id": None,
            "transcript_query": long_query,
        }
    ]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_find_convos_by_keywords_rejects_low_signal_query():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        transcripts={},
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["findConvosByKeywords"].ainvoke({"keywords": "ok", "limit": 5})

    assert result["count"] == 0
    assert result["conversations"] == []
    assert result["guardrail"]["code"] == "LOW_SIGNAL_QUERY"
    assert result["guardrail"]["stop_search"] is False


@pytest.mark.asyncio
async def test_find_convos_by_keywords_stops_after_repeated_empty_results():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        transcripts={},
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    await tools["findConvosByKeywords"].ainvoke({"keywords": "representation", "limit": 5})
    await tools["findConvosByKeywords"].ainvoke({"keywords": "minority", "limit": 5})

    result = await tools["findConvosByKeywords"].ainvoke({"keywords": "media", "limit": 5})

    assert result["count"] == 0
    assert result["guardrail"]["code"] == "NO_MATCHES_AFTER_RETRIES"
    assert result["guardrail"]["stop_search"] is True
    assert result["guardrail"]["attempts"] == 3


@pytest.mark.asyncio
async def test_find_convos_by_keywords_resets_empty_counter_after_success():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        project_conversations_payload_by_transcript_query={
            "success-topic": {
                "project_id": "project-1",
                "count": 1,
                "conversations": [
                    {
                        "conversation_id": "conv-1",
                        "participant_name": "Alice",
                        "status": "done",
                    }
                ],
            }
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

    await tools["findConvosByKeywords"].ainvoke({"keywords": "representation", "limit": 5})
    success_result = await tools["findConvosByKeywords"].ainvoke(
        {"keywords": "success-topic", "limit": 5}
    )
    first_empty_after_success = await tools["findConvosByKeywords"].ainvoke(
        {"keywords": "minority", "limit": 5}
    )
    second_empty_after_success = await tools["findConvosByKeywords"].ainvoke(
        {"keywords": "media", "limit": 5}
    )
    third_empty_after_success = await tools["findConvosByKeywords"].ainvoke(
        {"keywords": "narratives", "limit": 5}
    )

    assert success_result["count"] == 1
    assert first_empty_after_success["count"] == 0
    assert "guardrail" not in first_empty_after_success
    assert second_empty_after_success["count"] == 0
    assert "guardrail" not in second_empty_after_success
    assert third_empty_after_success["guardrail"]["code"] == "NO_MATCHES_AFTER_RETRIES"
    assert third_empty_after_success["guardrail"]["attempts"] == 3


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
async def test_list_project_conversations_returns_project_scoped_cards():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        transcripts={},
        project_conversations_payload={
            "project_id": "project-1",
            "count": 2,
            "conversations": [
                {"conversation_id": "conv-1", "participant_name": "Alice", "status": "done"},
                {"conversation_id": "conv-2", "participant_name": "Bob", "status": "live"},
            ],
        },
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["listProjectConversations"].ainvoke({"limit": 9})

    assert result["project_id"] == "project-1"
    assert result["count"] == 2
    assert result["conversations"][0]["conversation_id"] == "conv-1"
    assert factory.instances[0].project_conversations_calls == [
        {
            "project_id": "project-1",
            "limit": 9,
            "conversation_id": None,
            "transcript_query": None,
        }
    ]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_list_convo_full_transcript_uses_scoped_lookup_for_exact_id():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        transcripts={"conv-1": "line one"},
        project_conversations_payload_by_id={
            "conv-1": {
                "project_id": "project-1",
                "count": 1,
                "conversations": [
                    {
                        "conversation_id": "conv-1",
                        "participant_name": "Alice",
                        "status": "done",
                    }
                ],
            }
        },
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["listConvoFullTranscript"].ainvoke({"conversation_id": "conv-1"})

    assert result["conversation_id"] == "conv-1"
    assert result["transcript"] == "line one"
    assert factory.instances[0].project_conversations_calls == [
        {
            "project_id": "project-1",
            "limit": 1,
            "conversation_id": "conv-1",
            "transcript_query": None,
        }
    ]
    assert factory.instances[0].search_calls == []


@pytest.mark.asyncio
async def test_grep_convo_snippets_returns_matches_for_in_scope_conversation():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={
            "conversations": [
                {
                    "id": "conv-1",
                    "projectId": "project-1",
                    "displayLabel": "Alice",
                    "status": "done",
                }
            ]
        },
        transcripts={
            "conv-1": "Minority representation matters for trust.\n"
            "Some participants discussed representation gaps in media.\n"
            "Other topics were unrelated.",
        },
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["grepConvoSnippets"].ainvoke(
        {"conversation_id": "conv-1", "query": "representation", "limit": 5}
    )

    assert result["project_id"] == "project-1"
    assert result["conversation_id"] == "conv-1"
    assert result["count"] == 2
    assert result["matches"][0]["snippet"]
    assert factory.instances[-1].closed is True


@pytest.mark.asyncio
async def test_grep_convo_snippets_returns_empty_matches_when_no_hits():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={
            "conversations": [
                {
                    "id": "conv-1",
                    "projectId": "project-1",
                    "displayLabel": "Alice",
                    "status": "done",
                }
            ]
        },
        transcripts={"conv-1": "No relevant term in this transcript."},
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["grepConvoSnippets"].ainvoke(
        {"conversation_id": "conv-1", "query": "representation", "limit": 5}
    )

    assert result["count"] == 0
    assert result["matches"] == []


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

    with pytest.raises(ValueError, match="Conversation not found in current project scope"):
        await tools["grepConvoSnippets"].ainvoke(
            {"conversation_id": "conv-9", "query": "representation", "limit": 3}
        )
