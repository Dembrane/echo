from __future__ import annotations

from typing import Any, AsyncIterator
from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

import dembrane.api.agentic as agentic_api
from tests.agentic.fakes import InMemoryDirectus
from dembrane.api.agentic import AgenticRouter
from dembrane.service.agentic import AgenticRunService
from dembrane.api.dependency_auth import DirectusSession, require_directus_session


class _FakeProjectService:
    def __init__(self, owner_by_project_id: dict[str, Any]) -> None:
        self._owner_by_project_id = owner_by_project_id

    def get_by_id_or_raise(self, project_id: str, with_tags: bool = False) -> dict[str, Any]:  # noqa: ARG002
        owner_entry = self._owner_by_project_id.get(project_id)
        if owner_entry is None:
            raise ValueError("project not found")
        if isinstance(owner_entry, dict):
            return {
                "id": project_id,
                "directus_user_id": owner_entry.get("directus_user_id"),
                "name": owner_entry.get("name"),
                "context": owner_entry.get("context"),
            }
        return {
            "id": project_id,
            "directus_user_id": owner_entry,
            "name": f"Project {project_id}",
            "context": f"Context for {project_id}",
        }


class _FakeChatService:
    def __init__(self) -> None:
        self.created_messages: list[dict[str, str]] = []

    def create_message(self, chat_id: str, message_from: str, text: str) -> dict[str, str]:
        message = {
            "id": f"msg-{len(self.created_messages) + 1}",
            "project_chat_id": chat_id,
            "message_from": message_from,
            "text": text,
        }
        self.created_messages.append(message)
        return message


class _FakeDirectusClient:
    def __init__(self, rows_by_collection: dict[str, list[dict[str, Any]]]) -> None:
        self.rows_by_collection = rows_by_collection
        self.calls: list[dict[str, Any]] = []

    @classmethod
    def _matches_condition(cls, value: Any, condition: Any) -> bool:
        if not isinstance(condition, dict):
            return value == condition

        for key, expected in condition.items():
            if key == "_eq":
                if value != expected:
                    return False
                continue
            if key == "_icontains":
                haystack = str(value or "").lower()
                needle = str(expected or "").lower()
                if not needle or needle not in haystack:
                    return False
                continue
            if key == "_and":
                if not isinstance(expected, list):
                    return False
                if not all(cls._matches_condition(value, item) for item in expected):
                    return False
                continue
            if key == "_or":
                if not isinstance(expected, list):
                    return False
                if not any(cls._matches_condition(value, item) for item in expected):
                    return False
                continue
            if not isinstance(value, dict):
                return False
            if not cls._matches_condition(value.get(key), expected):
                return False
        return True

    @classmethod
    def _matches_filter(cls, row: dict[str, Any], filter_data: Any) -> bool:
        if not isinstance(filter_data, dict):
            return True

        for key, expected in filter_data.items():
            if key == "_and":
                if not isinstance(expected, list):
                    return False
                if not all(cls._matches_filter(row, item) for item in expected):
                    return False
                continue
            if key == "_or":
                if not isinstance(expected, list):
                    return False
                if not any(cls._matches_filter(row, item) for item in expected):
                    return False
                continue
            if not cls._matches_condition(row.get(key), expected):
                return False
        return True

    @staticmethod
    def _apply_sort(rows: list[dict[str, Any]], sort_spec: Any) -> list[dict[str, Any]]:
        sort_fields: list[str]
        if isinstance(sort_spec, str):
            sort_fields = [sort_spec]
        elif isinstance(sort_spec, list):
            sort_fields = [field for field in sort_spec if isinstance(field, str)]
        else:
            return rows

        for sort_field in reversed(sort_fields):
            descending = sort_field.startswith("-")
            field_name = sort_field[1:] if descending else sort_field
            rows.sort(
                key=lambda row: (row.get(field_name) is None, row.get(field_name)),
                reverse=descending,
            )
        return rows

    def get_items(self, collection: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        self.calls.append(
            {
                "collection": collection,
                "params": params,
            }
        )
        rows = list(self.rows_by_collection.get(collection, []))
        query = (params or {}).get("query", {})
        filter_data = query.get("filter", {})
        if isinstance(filter_data, dict):
            rows = [row for row in rows if self._matches_filter(row, filter_data)]

        rows = self._apply_sort(rows, query.get("sort"))

        limit = query.get("limit")
        if isinstance(limit, int):
            rows = rows[:limit]
        return rows


@asynccontextmanager
async def _build_api_client(
    *,
    monkeypatch,
    session: DirectusSession,
    run_service: AgenticRunService,
    owner_by_project_id: dict[str, Any],
    lease_result: bool = False,
    lease_calls: list[dict[str, Any]] | None = None,
    start_calls: list[dict[str, Any]] | None = None,
    cancel_calls: list[tuple[str, int]] | None = None,
    start_impl: Any | None = None,
    chat_service: _FakeChatService | None = None,
) -> AsyncIterator[AsyncClient]:
    app = FastAPI()
    app.include_router(AgenticRouter, prefix="/api/agentic")

    monkeypatch.setattr(agentic_api, "project_service", _FakeProjectService(owner_by_project_id))
    monkeypatch.setattr(agentic_api, "agentic_run_service", run_service)
    if chat_service is not None:
        monkeypatch.setattr(agentic_api, "chat_service", chat_service)

    lease_calls_list = lease_calls if lease_calls is not None else []
    start_calls_list = start_calls if start_calls is not None else []
    cancel_calls_list = cancel_calls if cancel_calls is not None else []

    async def _fake_acquire_turn_lease(
        run_id: str,
        turn_seq: int,
        owner: str,
        ttl_seconds: int,
    ) -> bool:
        lease_calls_list.append(
            {
                "run_id": run_id,
                "turn_seq": turn_seq,
                "owner": owner,
                "ttl_seconds": ttl_seconds,
            }
        )
        return lease_result

    async def _fake_start_claimed_turn(**kwargs: Any) -> None:
        start_calls_list.append(kwargs)

    async def _fake_request_cancel(run_id: str, turn_seq: int, ttl_seconds: int = 900) -> None:  # noqa: ARG001
        cancel_calls_list.append((run_id, turn_seq))

    @asynccontextmanager
    async def _fake_subscribe_live_events(run_id: str):  # noqa: ARG001
        yield object()

    async def _fake_read_live_event(pubsub: object, timeout_seconds: float = 1.0):  # noqa: ARG001
        return None

    monkeypatch.setattr(agentic_api, "acquire_turn_lease", _fake_acquire_turn_lease)
    monkeypatch.setattr(
        agentic_api,
        "_start_claimed_turn",
        start_impl or _fake_start_claimed_turn,
    )
    monkeypatch.setattr(agentic_api, "request_cancel", _fake_request_cancel)
    monkeypatch.setattr(agentic_api, "subscribe_live_events", _fake_subscribe_live_events)
    monkeypatch.setattr(agentic_api, "read_live_event", _fake_read_live_event)
    monkeypatch.setattr(agentic_api, "SSE_HEARTBEAT_SECONDS", 0.01)

    async with agentic_api._ACTIVE_RUN_TASKS_LOCK:
        agentic_api._ACTIVE_RUN_TASKS.clear()

    async def _override_session() -> DirectusSession:
        return session

    app.dependency_overrides[require_directus_session] = _override_session
    transport = ASGITransport(app=app)

    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client



def _make_session(
    *,
    user_id: str,
    is_admin: bool = False,
    access_token: str | None = "token-1",
    client: Any | None = None,
) -> DirectusSession:
    return DirectusSession(
        user_id=user_id,
        is_admin=is_admin,
        access_token=access_token,
        client=client,
    )


@pytest.mark.asyncio
async def test_create_run_persists_user_message_without_dispatch(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    fake_chat_service = _FakeChatService()
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
        chat_service=fake_chat_service,
    ) as client:
        response = await client.post(
            "/api/agentic/runs",
            json={"project_id": "project-1", "project_chat_id": "chat-1", "message": "hello"},
        )

    assert response.status_code == 201
    payload = response.json()
    assert payload["status"] == "queued"
    assert payload["project_id"] == "project-1"
    assert fake_chat_service.created_messages == [
        {
            "id": "msg-1",
            "project_chat_id": "chat-1",
            "message_from": "user",
            "text": "hello",
        }
    ]
    events = run_service.list_events(payload["id"])
    assert len(events) == 1
    assert events[0]["event_type"] == "user.message"
    assert events[0]["payload"]["content"] == "hello"
    assert events[0]["payload"]["agent_prompt_content"] == (
        "Project Name: Project project-1\n"
        "Project Context: Context for project-1\n\n"
        "User Message: hello"
    )


@pytest.mark.asyncio
async def test_create_run_rejects_missing_passthrough_token(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    session = _make_session(user_id="user-1", access_token=None)

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
    ) as client:
        response = await client.post(
            "/api/agentic/runs",
            json={"project_id": "project-1", "project_chat_id": "chat-1", "message": "hello"},
        )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_append_message_rejects_inflight_run(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="user-1", status="running")
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
    ) as client:
        response = await client.post(
            f"/api/agentic/runs/{run['id']}/messages",
            json={"message": "hello-again"},
        )

    assert response.status_code == 409


@pytest.mark.asyncio
async def test_append_message_persists_user_chat_message(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(
        project_id="project-1",
        project_chat_id="chat-1",
        directus_user_id="user-1",
        status="completed",
    )
    fake_chat_service = _FakeChatService()
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
        chat_service=fake_chat_service,
    ) as client:
        response = await client.post(
            f"/api/agentic/runs/{run['id']}/messages",
            json={"message": "hello-again"},
        )

    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    assert fake_chat_service.created_messages == [
        {
            "id": "msg-1",
            "project_chat_id": "chat-1",
            "message_from": "user",
            "text": "hello-again",
        }
    ]


@pytest.mark.asyncio
async def test_post_stream_claims_when_lease_acquired(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="user-1", status="queued")
    run_service.append_event(run["id"], "user.message", {"content": "hello"})

    lease_calls: list[dict[str, Any]] = []
    start_calls: list[dict[str, Any]] = []
    session = _make_session(user_id="user-1")

    async def _fake_start_claimed_turn(**kwargs: Any) -> None:
        start_calls.append(kwargs)
        run_service.append_event(kwargs["run_id"], "assistant.message", {"content": "done"})
        run_service.set_status(kwargs["run_id"], "completed", latest_output="done")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
        lease_result=True,
        lease_calls=lease_calls,
        start_calls=start_calls,
        start_impl=_fake_start_claimed_turn,
    ) as client:
        response = await client.post(f"/api/agentic/runs/{run['id']}/stream")

    assert response.status_code == 200
    assert len(lease_calls) == 1
    assert len(start_calls) == 1
    assert "assistant.message" in response.text


@pytest.mark.asyncio
async def test_post_stream_uses_hidden_agent_prompt_content_when_available(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="user-1", status="queued")
    run_service.append_event(
        run["id"],
        "user.message",
        {
            "content": "visible-user-message",
            "agent_prompt_content": "hidden-agent-prompt-content",
        },
    )

    start_calls: list[dict[str, Any]] = []
    session = _make_session(user_id="user-1")

    async def _fake_start_claimed_turn(**kwargs: Any) -> None:
        start_calls.append(kwargs)
        run_service.append_event(kwargs["run_id"], "assistant.message", {"content": "done"})
        run_service.set_status(kwargs["run_id"], "completed", latest_output="done")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
        lease_result=True,
        start_calls=start_calls,
        start_impl=_fake_start_claimed_turn,
    ) as client:
        response = await client.post(f"/api/agentic/runs/{run['id']}/stream")

    assert response.status_code == 200
    assert len(start_calls) == 1
    assert start_calls[0]["user_message"] == "hidden-agent-prompt-content"


@pytest.mark.asyncio
async def test_post_stream_does_not_claim_when_lease_not_acquired(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="user-1", status="running")
    run_service.append_event(run["id"], "user.message", {"content": "hello"})
    run_service.set_status(run["id"], "completed", latest_output="hello")

    lease_calls: list[dict[str, Any]] = []
    start_calls: list[dict[str, Any]] = []
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
        lease_result=False,
        lease_calls=lease_calls,
        start_calls=start_calls,
    ) as client:
        response = await client.post(f"/api/agentic/runs/{run['id']}/stream")

    assert response.status_code == 200
    assert len(start_calls) == 0


@pytest.mark.asyncio
async def test_list_project_conversations_returns_expected_shape(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    directus_client = _FakeDirectusClient(
        rows_by_collection={
            "conversation": [
                {
                    "id": "conv-1",
                    "project_id": "project-1",
                    "participant_name": "Alice",
                    "summary": "Summary 1",
                    "is_finished": True,
                    "is_all_chunks_transcribed": True,
                    "created_at": "2026-02-01T12:00:00Z",
                    "chunks": [{"timestamp": "2026-02-01T12:05:00Z"}],
                },
                {
                    "id": "conv-2",
                    "project_id": "project-1",
                    "participant_name": "Bob",
                    "summary": None,
                    "is_finished": False,
                    "is_all_chunks_transcribed": False,
                    "created_at": "2026-02-01T13:00:00Z",
                    "chunks": [],
                },
            ]
        }
    )
    monkeypatch.setattr(agentic_api, "directus", directus_client)
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
    ) as client:
        response = await client.get(
            "/api/agentic/projects/project-1/conversations",
            params={"limit": 20},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["project_id"] == "project-1"
    assert payload["count"] == 2
    assert payload["conversations"][0] == {
        "conversation_id": "conv-1",
        "participant_name": "Alice",
        "status": "done",
        "summary": "Summary 1",
        "started_at": "2026-02-01T12:00:00Z",
        "last_chunk_at": "2026-02-01T12:05:00Z",
    }
    assert payload["conversations"][1]["status"] == "live"

    assert len(directus_client.calls) == 1
    assert directus_client.calls[0]["collection"] == "conversation"
    assert directus_client.calls[0]["params"]["query"]["filter"]["project_id"]["_eq"] == "project-1"
    assert "project_id" in directus_client.calls[0]["params"]["query"]["fields"]


@pytest.mark.asyncio
async def test_list_project_conversations_rejects_unauthorized_user(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    session = _make_session(user_id="user-2")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
    ) as client:
        response = await client.get("/api/agentic/projects/project-1/conversations")

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_list_project_conversations_supports_conversation_id_filter(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    directus_client = _FakeDirectusClient(
        rows_by_collection={
            "conversation": [
                {
                    "id": "conv-1",
                    "project_id": "project-1",
                    "participant_name": "Alice",
                    "summary": "Summary 1",
                    "is_finished": True,
                    "is_all_chunks_transcribed": True,
                    "created_at": "2026-02-01T12:00:00Z",
                },
                {
                    "id": "conv-2",
                    "project_id": "project-1",
                    "participant_name": "Bob",
                    "summary": "Summary 2",
                    "is_finished": True,
                    "is_all_chunks_transcribed": True,
                    "created_at": "2026-02-01T13:00:00Z",
                },
            ]
        }
    )
    monkeypatch.setattr(agentic_api, "directus", directus_client)
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
    ) as client:
        response = await client.get(
            "/api/agentic/projects/project-1/conversations",
            params={"conversation_id": "conv-2", "limit": 20},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 1
    assert payload["conversations"][0]["conversation_id"] == "conv-2"


@pytest.mark.asyncio
async def test_list_project_conversations_transcript_query_scopes_to_project_and_dedupes(
    monkeypatch,
) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    directus_client = _FakeDirectusClient(
        rows_by_collection={
            "conversation_chunk": [
                {
                    "id": "chunk-other",
                    "timestamp": "2026-02-01T13:00:00Z",
                    "created_at": "2026-02-01T13:00:00Z",
                    "transcript": "Bad Bunny halftime show",
                    "raw_transcript": None,
                    "conversation_id": {
                        "id": "conv-other",
                        "project_id": "project-2",
                        "participant_name": "Outside",
                        "summary": "outside project",
                        "is_finished": True,
                        "is_all_chunks_transcribed": True,
                        "created_at": "2026-02-01T12:00:00Z",
                        "updated_at": "2026-02-01T13:00:00Z",
                    },
                },
                {
                    "id": "chunk-2",
                    "timestamp": "2026-02-01T12:30:00Z",
                    "created_at": "2026-02-01T12:30:00Z",
                    "transcript": "Bad Bunny halftime analysis",
                    "raw_transcript": None,
                    "conversation_id": {
                        "id": "conv-1",
                        "project_id": "project-1",
                        "participant_name": "Alice",
                        "summary": "summary one",
                        "is_finished": True,
                        "is_all_chunks_transcribed": True,
                        "created_at": "2026-02-01T10:00:00Z",
                        "updated_at": "2026-02-01T12:30:00Z",
                    },
                },
                {
                    "id": "chunk-1",
                    "timestamp": "2026-02-01T12:15:00Z",
                    "created_at": "2026-02-01T12:15:00Z",
                    "transcript": "Another mention of Bunny",
                    "raw_transcript": None,
                    "conversation_id": {
                        "id": "conv-1",
                        "project_id": "project-1",
                        "participant_name": "Alice",
                        "summary": "summary one",
                        "is_finished": True,
                        "is_all_chunks_transcribed": True,
                        "created_at": "2026-02-01T10:00:00Z",
                        "updated_at": "2026-02-01T12:30:00Z",
                    },
                },
            ]
        }
    )
    monkeypatch.setattr(agentic_api, "directus", directus_client)
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1", "project-2": "user-2"},
    ) as client:
        response = await client.get(
            "/api/agentic/projects/project-1/conversations",
            params={"transcript_query": "Bad Bunny halftime show", "limit": 20},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["project_id"] == "project-1"
    assert payload["count"] == 1
    assert payload["conversations"] == [
        {
            "conversation_id": "conv-1",
            "participant_name": "Alice",
            "status": "done",
            "summary": "summary one",
            "started_at": "2026-02-01T10:00:00Z",
            "last_chunk_at": "2026-02-01T12:30:00Z",
        }
    ]
    assert directus_client.calls[0]["collection"] == "conversation_chunk"
    assert "conversation_id.id" in directus_client.calls[0]["params"]["query"]["fields"]


@pytest.mark.asyncio
async def test_list_project_conversations_transcript_query_token_or_limit_and_order(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    directus_client = _FakeDirectusClient(
        rows_by_collection={
            "conversation_chunk": [
                {
                    "id": "chunk-4",
                    "timestamp": "2026-02-01T12:04:00Z",
                    "created_at": "2026-02-01T12:04:00Z",
                    "transcript": "Budget priorities were discussed",
                    "raw_transcript": None,
                    "conversation_id": {
                        "id": "conv-4",
                        "project_id": "project-1",
                        "participant_name": "Dan",
                        "summary": "budget convo",
                        "is_finished": True,
                        "is_all_chunks_transcribed": True,
                        "created_at": "2026-02-01T10:00:00Z",
                        "updated_at": "2026-02-01T12:04:00Z",
                    },
                },
                {
                    "id": "chunk-3",
                    "timestamp": "2026-02-01T12:06:00Z",
                    "created_at": "2026-02-01T12:06:00Z",
                    "transcript": "Education reform updates",
                    "raw_transcript": None,
                    "conversation_id": {
                        "id": "conv-3",
                        "project_id": "project-1",
                        "participant_name": "Cara",
                        "summary": "education convo",
                        "is_finished": True,
                        "is_all_chunks_transcribed": False,
                        "created_at": "2026-02-01T10:00:00Z",
                        "updated_at": "2026-02-01T12:06:00Z",
                    },
                },
                {
                    "id": "chunk-2",
                    "timestamp": "2026-02-01T12:07:00Z",
                    "created_at": "2026-02-01T12:07:00Z",
                    "transcript": None,
                    "raw_transcript": "Housing affordability concerns",
                    "conversation_id": {
                        "id": "conv-2",
                        "project_id": "project-1",
                        "participant_name": "Bob",
                        "summary": "housing convo",
                        "is_finished": False,
                        "is_all_chunks_transcribed": False,
                        "created_at": "2026-02-01T10:00:00Z",
                        "updated_at": "2026-02-01T12:07:00Z",
                    },
                },
                {
                    "id": "chunk-1",
                    "timestamp": "2026-02-01T12:08:00Z",
                    "created_at": "2026-02-01T12:08:00Z",
                    "transcript": "Climate policy and action",
                    "raw_transcript": None,
                    "conversation_id": {
                        "id": "conv-1",
                        "project_id": "project-1",
                        "participant_name": "Alice",
                        "summary": "climate convo",
                        "is_finished": True,
                        "is_all_chunks_transcribed": True,
                        "created_at": "2026-02-01T10:00:00Z",
                        "updated_at": "2026-02-01T12:08:00Z",
                    },
                },
            ]
        }
    )
    monkeypatch.setattr(agentic_api, "directus", directus_client)
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
    ) as client:
        response = await client.get(
            "/api/agentic/projects/project-1/conversations",
            params={"transcript_query": "Climate housing education budget", "limit": 2},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["project_id"] == "project-1"
    assert payload["count"] == 2
    assert [conversation["conversation_id"] for conversation in payload["conversations"]] == [
        "conv-1",
        "conv-2",
    ]
    assert payload["conversations"][0]["status"] == "done"
    assert payload["conversations"][1]["status"] == "live"

@pytest.mark.asyncio
async def test_stop_run_sets_cancel_request(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="user-1", status="running")
    event = run_service.append_event(run["id"], "user.message", {"content": "hello"})

    cancel_calls: list[tuple[str, int]] = []
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
        cancel_calls=cancel_calls,
    ) as client:
        response = await client.post(f"/api/agentic/runs/{run['id']}/stop")

    assert response.status_code == 200
    assert cancel_calls == [(run["id"], event["seq"])]


@pytest.mark.asyncio
async def test_polling_events_respects_after_seq(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="user-1")
    run_service.append_event(run["id"], "assistant.delta", {"content": "hel"})
    run_service.append_event(run["id"], "assistant.message", {"content": "hello"})
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
    ) as client:
        response = await client.get(f"/api/agentic/runs/{run['id']}/events", params={"after_seq": 1})

    assert response.status_code == 200
    payload = response.json()
    assert [event["seq"] for event in payload["events"]] == [2]
    assert payload["next_seq"] == 2
    assert payload["done"] is False


@pytest.mark.asyncio
async def test_sse_stream_emits_heartbeat_when_idle(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="user-1")
    monkeypatch.setattr(agentic_api, "agentic_run_service", run_service)
    monkeypatch.setattr(agentic_api, "SSE_HEARTBEAT_SECONDS", 0.01)

    generator = agentic_api._event_stream(run_id=run["id"], after_seq=0)
    first = await generator.__anext__()
    await generator.aclose()

    assert first == "event: heartbeat\ndata: {}\n\n"
