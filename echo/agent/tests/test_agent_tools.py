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
        project_chats_payload: list[dict] | None = None,
        chat_messages_payload: list[dict] | None = None,
        memory_payload: dict | None = None,
        write_memory_response: dict | None = None,
        canvases_payload: list[dict] | None = None,
        canvas_loop_response: dict | None = None,
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
        self.project_chats_payload = project_chats_payload or []
        self.chat_messages_payload = chat_messages_payload or []
        self.search_calls: list[dict[str, object]] = []
        self.transcript_calls: list[str] = []
        self.project_conversations_calls: list[dict[str, object]] = []
        self.project_chats_calls: list[dict[str, object]] = []
        self.read_chat_calls: list[dict[str, object]] = []
        self.support_request_calls: list[dict[str, object]] = []
        self.memory_payload = memory_payload or {}
        self.write_memory_response = write_memory_response or {}
        self.canvases_payload = canvases_payload or []
        self.canvas_loop_response = canvas_loop_response or {}
        self.search_calls: list[dict[str, object]] = []
        self.transcript_calls: list[str] = []
        self.project_conversations_calls: list[dict[str, object]] = []
        self.list_memory_calls: list[str] = []
        self.write_memory_calls: list[dict[str, object]] = []
        self.list_canvases_calls: list[str] = []
        self.canvas_loop_calls: list[dict[str, str]] = []
        self.closed = False

    async def search_home(self, query: str, limit: int = 5) -> dict:
        self.search_calls.append({"query": query, "limit": limit})
        return self.search_payload_by_query.get(query, self.search_payload)

    async def get_conversation_transcript(self, conversation_id: str) -> str:
        self.transcript_calls.append(conversation_id)
        return self.transcripts[conversation_id]

    # Class-level so a test can set the payload without threading it through
    # the factory; every fake instance shares it.
    monitor_payload: dict = {}

    async def get_project_monitor(self, project_id: str, window_seconds: int = 45) -> dict:  # noqa: ARG002
        return type(self).monitor_payload

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

    async def list_project_chats(
        self,
        project_id: str,
        limit: int = 30,
        workspace_wide: bool = False,
    ) -> list[dict]:
        self.project_chats_calls.append(
            {
                "project_id": project_id,
                "limit": limit,
                "workspace_wide": workspace_wide,
            }
        )
        return self.project_chats_payload

    async def read_chat(self, chat_id: str, limit: int = 100) -> list[dict]:
        self.read_chat_calls.append({"chat_id": chat_id, "limit": limit})
        return self.chat_messages_payload

    async def create_support_request(
        self,
        project_id: str,
        message: str,
        page_context: str | None = None,
        chat_id: str | None = None,
        app_user_id: str | None = None,
        message_id: str | None = None,
    ) -> dict:
        self.support_request_calls.append(
            {
                "project_id": project_id,
                "message": message,
                "page_context": page_context,
                "chat_id": chat_id,
                "app_user_id": app_user_id,
                "message_id": message_id,
            }
        )
        return {"id": "sr-1", "status": "new"}
    async def list_memory(self, project_id: str) -> dict:
        self.list_memory_calls.append(project_id)
        return self.memory_payload

    async def list_canvases(self, project_id: str) -> list[dict]:
        self.list_canvases_calls.append(project_id)
        return self.canvases_payload

    async def update_canvas_loop(
        self,
        project_id: str,
        canvas_id: str,
        action: str,
    ) -> dict:
        self.canvas_loop_calls.append(
            {"project_id": project_id, "canvas_id": canvas_id, "action": action}
        )
        return self.canvas_loop_response

    async def write_memory(
        self,
        project_id: str,
        scope: str,
        content: str,
        memory_key: str | None = None,
    ) -> dict:
        self.write_memory_calls.append(
            {
                "project_id": project_id,
                "scope": scope,
                "content": content,
                "memory_key": memory_key,
            }
        )
        return self.write_memory_response

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
        project_chats_payload: list[dict] | None = None,
        chat_messages_payload: list[dict] | None = None,
        memory_payload: dict | None = None,
        write_memory_response: dict | None = None,
        canvases_payload: list[dict] | None = None,
        canvas_loop_response: dict | None = None,
    ):
        self.search_payload = search_payload
        self.search_payload_by_query = search_payload_by_query
        self.transcripts = transcripts
        self.project_conversations_payload = project_conversations_payload
        self.project_conversations_payload_by_id = project_conversations_payload_by_id
        self.project_conversations_payload_by_transcript_query = (
            project_conversations_payload_by_transcript_query
        )
        self.project_chats_payload = project_chats_payload
        self.chat_messages_payload = chat_messages_payload
        self.memory_payload = memory_payload
        self.write_memory_response = write_memory_response
        self.canvases_payload = canvases_payload
        self.canvas_loop_response = canvas_loop_response
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
            project_chats_payload=self.project_chats_payload,
            chat_messages_payload=self.chat_messages_payload,
            memory_payload=self.memory_payload,
            write_memory_response=self.write_memory_response,
            canvases_payload=self.canvases_payload,
            canvas_loop_response=self.canvas_loop_response,
        )
        self.instances.append(client)
        return client


def _tool_map(tools) -> dict[str, object]:  # noqa: ANN001
    return {tool.name: tool for tool in tools}


def test_system_prompt_contains_conversational_and_research_directives():
    prompt = SYSTEM_PROMPT.lower()
    # Brand voice: the word AI is banned, dembrane stays lowercase
    assert 'never use the word "ai"' in prompt
    assert "dembrane" in prompt and "Dembrane" not in SYSTEM_PROMPT
    # Conversational-first behavior
    assert "do not use tools for greetings" in prompt
    # Honesty + scope + turn-instruction sections exist
    assert "honesty" in prompt
    assert "conversation scope" in prompt
    assert "turn instructions" in prompt
    # The agent never applies changes itself
    assert "you never apply" in prompt
    # Citation policy still anchors output quality (format is load-bearing:
    # parsed by AgenticChatPanel.tsx)
    assert '"[participant name]: quoted text"' in prompt
    assert "[conversation_id:<id>;chunk_id:<chunk_id>]" in SYSTEM_PROMPT
    assert "[conversation_id:<id>]" in SYSTEM_PROMPT
    assert "worked from summaries only" in prompt
    assert "read the full transcript" in prompt
    assert "never fabricate quotes" in prompt
    # Project + workspace context awareness
    assert "project context" in prompt
    assert "workspace context" in prompt
    assert "guidance and background" in prompt
    # Memories are host-visible and host-deletable
    assert "hosts can delete them" in prompt
    # Canvas guidance explains the living Library page and loop expiry.
    assert "a canvas is a living page" in prompt
    assert "always say the expiry plainly" in prompt
    # Never leak internal machinery to the host
    assert "internal machinery" in prompt
    # Steer batched lookups over one-at-a-time calls
    assert "batch your lookups" in prompt


def _make_doc_tools():
    llm = _CaptureLLM()
    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=_FakeEchoClientFactory(
            search_payload={"conversations": []},
            project_conversations_payload_by_transcript_query={},
            transcripts={},
        ),
    )
    return _tool_map(llm.bound_tools)


@pytest.mark.asyncio
async def test_get_live_conversation_status_returns_monitor_payload(monkeypatch):
    payload = {
        "summary": {"live": 2, "transcribing": 1, "with_errors": 0, "total": 3},
        "conversations": [{"id": "c1", "is_live": True}],
        "live_window_seconds": 45,
    }
    monkeypatch.setattr(_FakeEchoClient, "monitor_payload", payload)
    tools = _make_doc_tools()

    result = await tools["getLiveConversationStatus"].ainvoke({})

    assert result == payload
    assert result["summary"]["live"] == 2


@pytest.mark.asyncio
async def test_read_doc_reads_multiple_pages_in_one_call(monkeypatch):
    import knowledge

    calls: list[tuple[str, int, int]] = []

    def _fake_read_doc(path: str, offset: int = 1, limit: int = 200) -> str:
        calls.append((path, offset, limit))
        return f"body of {path}"

    monkeypatch.setattr(knowledge, "read_doc", _fake_read_doc)
    tools = _make_doc_tools()

    result = await tools["readDoc"].ainvoke(
        {"paths": ["features/portal-editor.md", "index.md"]}
    )

    assert result == {
        "docs": [
            {"path": "features/portal-editor.md", "content": "body of features/portal-editor.md"},
            {"path": "index.md", "content": "body of index.md"},
        ]
    }
    assert [c[0] for c in calls] == ["features/portal-editor.md", "index.md"]


@pytest.mark.asyncio
async def test_read_doc_rejects_empty_paths():
    tools = _make_doc_tools()
    with pytest.raises(ValueError):
        await tools["readDoc"].ainvoke({"paths": []})


@pytest.mark.asyncio
async def test_grep_docs_searches_multiple_patterns_in_one_call(monkeypatch):
    import knowledge

    def _fake_grep(pattern: str):
        return [{"path": "index.md", "line": 1, "text": f"hit for {pattern}"}]

    monkeypatch.setattr(knowledge, "grep_docs", _fake_grep)
    tools = _make_doc_tools()

    result = await tools["grepDocs"].ainvoke({"patterns": ["fizz", "aftertaste"]})

    assert [r["pattern"] for r in result["results"]] == ["fizz", "aftertaste"]
    assert result["results"][0]["matches"][0]["text"] == "hit for fizz"


@pytest.mark.asyncio
async def test_grep_docs_rejects_empty_patterns():
    tools = _make_doc_tools()
    with pytest.raises(ValueError):
        await tools["grepDocs"].ainvoke({"patterns": []})


@pytest.mark.asyncio
async def test_propose_custom_verification_topic_returns_suggestion_payload():
    tools = _make_doc_tools()

    result = await tools["proposeCustomVerificationTopic"].ainvoke(
        {
            "label": "Sweetness feedback",
            "prompt": "Did the participant comment on how sweet the drink was?",
            "reason": "You asked for a bespoke check on taste feedback.",
        }
    )

    assert result["kind"] == "custom_verification_topic_suggestion"
    assert result["project_id"] == "project-1"
    assert result["label"] == "Sweetness feedback"
    assert result["prompt"] == "Did the participant comment on how sweet the drink was?"
    assert result["visible_to_user"] is True


@pytest.mark.asyncio
async def test_propose_custom_verification_topic_rejects_empty_fields():
    tools = _make_doc_tools()
    with pytest.raises(ValueError):
        await tools["proposeCustomVerificationTopic"].ainvoke(
            {"label": "  ", "prompt": "something"}
        )
    with pytest.raises(ValueError):
        await tools["proposeCustomVerificationTopic"].ainvoke(
            {"label": "Name", "prompt": "   "}
        )


@pytest.mark.asyncio
async def test_propose_canvas_returns_structured_proposal():
    tools = _make_doc_tools()

    result = await tools["proposeCanvas"].ainvoke(
        {
            "name": "Live pulse",
            "brief": "Show the three most important emerging themes.",
            "gather_window_minutes": 45,
            "cadence_minutes": 5,
            "expires_in_hours": 4,
        }
    )

    assert result["type"] == "canvas_proposal"
    assert result["name"] == "Live pulse"
    assert result["brief"] == "Show the three most important emerging themes."
    assert result["gather_spec"] == {"window_minutes": 45}
    assert result["cadence_minutes"] == 5
    assert result["expires_at"].endswith("+00:00")
    assert result["visible_to_user"] is True


@pytest.mark.asyncio
async def test_propose_canvas_rejects_invalid_inputs():
    tools = _make_doc_tools()
    with pytest.raises(ValueError):
        await tools["proposeCanvas"].ainvoke({"name": "n", "brief": "  "})
    with pytest.raises(ValueError):
        await tools["proposeCanvas"].ainvoke(
            {"name": "n", "brief": "brief", "cadence_minutes": 1}
        )
    with pytest.raises(ValueError):
        await tools["proposeCanvas"].ainvoke(
            {"name": "n", "brief": "brief", "expires_in_hours": 169}
        )


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
        project_conversations_payload_by_transcript_query={
            "representation": {
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
                        "matches": [
                            {
                                "chunk_id": "chunk-1",
                                "timestamp": "2026-01-01T00:10:00Z",
                                "snippet": "Minority representation matters for trust.",
                            },
                            {
                                "chunk_id": "chunk-2",
                                "timestamp": "2026-01-01T00:20:00Z",
                                "snippet": "Some participants discussed representation gaps in media.",
                            },
                        ],
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

    result = await tools["grepConvoSnippets"].ainvoke(
        {"conversation_id": "conv-1", "query": "representation", "limit": 5}
    )

    assert result["project_id"] == "project-1"
    assert result["conversation_id"] == "conv-1"
    assert result["count"] == 2
    assert result["matches"][0] == {
        "chunk_id": "chunk-1",
        "timestamp": "2026-01-01T00:10:00Z",
        "snippet": "Minority representation matters for trust.",
    }
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
        project_conversations_payload_by_transcript_query={
            "representation": {
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
                        "matches": [],
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


@pytest.mark.asyncio
async def test_list_project_chats_scopes_to_current_project():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        transcripts={},
        project_chats_payload=[
            {
                "id": "chat-1",
                "name": "Budget discussion",
                "chat_mode": "agent",
                "is_private": False,
                "is_own": True,
                "date_updated": "2026-02-01T00:00:00Z",
                "project_id": "project-1",
            }
        ],
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["listProjectChats"].ainvoke({"limit": 5})

    assert result["chats"][0]["id"] == "chat-1"
    assert factory.instances[0].project_chats_calls == [
        {"project_id": "project-1", "limit": 5, "workspace_wide": False}
    ]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_read_chat_passes_chat_id_and_returns_messages():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        transcripts={},
        chat_messages_payload=[
            {
                "message_from": "user",
                "text": "what did we decide",
                "date_created": "2026-02-01T00:00:00Z",
            },
            {
                "message_from": "assistant",
                "text": "we decided to widen the scope",
                "date_created": "2026-02-01T00:01:00Z",
            },
        ],
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["readChat"].ainvoke({"chat_id": "chat-1"})

    assert [m["message_from"] for m in result["messages"]] == ["user", "assistant"]
    assert factory.instances[0].read_chat_calls == [{"chat_id": "chat-1", "limit": 100}]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_reach_out_to_dembrane_sends_support_request_for_current_project():
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
        chat_id="chat-1",
        app_user_id="app-user-1",
        message_id="run-event-1",
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["reachOutToDembrane"].ainvoke(
        {"message": "My exports are failing", "context": "on the reports page"}
    )

    assert result["sent"] is True
    assert result["support_request_id"] == "sr-1"
    assert factory.instances[0].support_request_calls == [
        {
            "project_id": "project-1",
            "message": "My exports are failing",
            "page_context": "on the reports page",
            "chat_id": "chat-1",
            "app_user_id": "app-user-1",
            "message_id": "run-event-1",
        }
    ]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_read_memory_returns_memories():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        transcripts={},
        memory_payload={
            "project_id": "project-1",
            "count": 1,
            "memories": [
                {
                    "id": "mem-1",
                    "scope": "project",
                    "memory_key": "focus",
                    "content": "Focus on housing themes.",
                    "source": "agent",
                    "updated_at": "2026-02-01T00:00:00Z",
                }
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

    result = await tools["readMemory"].ainvoke({})

    assert result["memories"][0]["memory_key"] == "focus"
    assert result["memories"][0]["content"] == "Focus on housing themes."
    assert factory.instances[0].list_memory_calls == ["project-1"]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_list_canvases_returns_project_canvases():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        transcripts={},
        canvases_payload=[
            {
                "id": "canvas-1",
                "name": "Pulse wall",
                "kind": "canvas",
                "created_at": "2026-07-07T10:00:00Z",
                "latest_generation_at": None,
                "loop": {"status": "active", "expires_at": "later", "cadence_minutes": 5},
            }
        ],
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["listCanvases"].ainvoke({})

    assert result["canvases"][0]["id"] == "canvas-1"
    assert factory.instances[0].list_canvases_calls == ["project-1"]
    assert factory.instances[0].closed is True


@pytest.mark.asyncio
async def test_canvas_loop_tools_call_expected_actions():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        transcripts={},
        canvas_loop_response={
            "status": "paused",
            "expires_at": "later",
            "cadence_minutes": 5,
        },
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    pause = await tools["pauseCanvasLoop"].ainvoke({"canvas_id": " canvas-1 "})
    resume = await tools["resumeCanvasLoop"].ainvoke({"canvas_id": "canvas-1"})
    stop = await tools["stopCanvasLoop"].ainvoke({"canvas_id": "canvas-1"})

    assert pause["canvas_id"] == "canvas-1"
    assert resume["loop"]["status"] == "paused"
    assert stop["loop"]["status"] == "paused"
    assert [instance.canvas_loop_calls[0]["action"] for instance in factory.instances] == [
        "pause",
        "resume",
        "stop",
    ]
    assert all(instance.closed for instance in factory.instances)


@pytest.mark.asyncio
async def test_remember_saves_memory_scoped_to_project_by_default():
    llm = _CaptureLLM()
    factory = _FakeEchoClientFactory(
        search_payload={"conversations": []},
        transcripts={},
        write_memory_response={"id": "mem-1", "scope": "project", "action": "created"},
    )

    create_agent_graph(
        project_id="project-1",
        bearer_token="token-1",
        llm=llm,
        echo_client_factory=factory,
    )
    tools = _tool_map(llm.bound_tools)

    result = await tools["remember"].ainvoke(
        {"content": "The host prefers short summaries.", "memory_key": "summary_style"}
    )

    assert result["action"] == "created"
    assert result["scope"] == "project"
    assert result["memory_key"] == "summary_style"
    assert factory.instances[0].write_memory_calls == [
        {
            "project_id": "project-1",
            "scope": "project",
            "content": "The host prefers short summaries.",
            "memory_key": "summary_style",
        }
    ]
    assert factory.instances[0].closed is True


def test_system_prompt_offers_dembrane_support_path():
    prompt = SYSTEM_PROMPT.lower()
    assert "getting help from the dembrane team" in prompt
    assert "the dembrane team" in prompt
