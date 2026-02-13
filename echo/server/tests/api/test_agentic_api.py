from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import dembrane.api.agentic as agentic_api
from dembrane.api.agentic import AgenticRouter
from dembrane.api.dependency_auth import DirectusSession, require_directus_session
from dembrane.service.agentic import AgenticRunService
from tests.agentic.fakes import InMemoryDirectus


class _FakeProjectService:
    def __init__(self, owner_by_project_id: dict[str, str]) -> None:
        self._owner_by_project_id = owner_by_project_id

    def get_by_id_or_raise(self, project_id: str, with_tags: bool = False) -> dict[str, Any]:  # noqa: ARG002
        owner = self._owner_by_project_id.get(project_id)
        if owner is None:
            raise ValueError("project not found")
        return {"id": project_id, "directus_user_id": owner}


@asynccontextmanager
async def _build_api_client(
    *,
    monkeypatch,
    session: DirectusSession,
    run_service: AgenticRunService,
    owner_by_project_id: dict[str, str],
    enqueue_calls: list[dict[str, str]],
) -> AsyncIterator[AsyncClient]:
    app = FastAPI()
    app.include_router(AgenticRouter, prefix="/api/agentic")

    monkeypatch.setattr(agentic_api, "project_service", _FakeProjectService(owner_by_project_id))
    monkeypatch.setattr(agentic_api, "agentic_run_service", run_service)
    monkeypatch.setattr(
        agentic_api,
        "enqueue_agentic_run",
        lambda **kwargs: enqueue_calls.append(kwargs),
    )
    monkeypatch.setattr(agentic_api, "SSE_HEARTBEAT_SECONDS", 0.01)

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
) -> DirectusSession:
    return DirectusSession(
        user_id=user_id,
        is_admin=is_admin,
        access_token=access_token,
    )


@pytest.mark.asyncio
async def test_create_run_enqueues_worker_with_token(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    enqueue_calls: list[dict[str, str]] = []
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
        enqueue_calls=enqueue_calls,
    ) as client:
        response = await client.post(
            "/api/agentic/runs",
            json={"project_id": "project-1", "project_chat_id": "chat-1", "message": "hello"},
        )

    assert response.status_code == 201
    payload = response.json()
    assert payload["status"] == "queued"
    assert payload["project_id"] == "project-1"
    assert len(enqueue_calls) == 1
    assert enqueue_calls[0]["bearer_token"] == "token-1"
    assert enqueue_calls[0]["user_message"] == "hello"


@pytest.mark.asyncio
async def test_create_run_rejects_missing_passthrough_token(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    enqueue_calls: list[dict[str, str]] = []
    session = _make_session(user_id="user-1", access_token=None)

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
        enqueue_calls=enqueue_calls,
    ) as client:
        response = await client.post(
            "/api/agentic/runs",
            json={"project_id": "project-1", "project_chat_id": "chat-1", "message": "hello"},
        )

    assert response.status_code == 401
    assert len(enqueue_calls) == 0


@pytest.mark.asyncio
async def test_create_run_requires_project_authorization(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    enqueue_calls: list[dict[str, str]] = []
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "different-user"},
        enqueue_calls=enqueue_calls,
    ) as client:
        response = await client.post(
            "/api/agentic/runs",
            json={"project_id": "project-1", "project_chat_id": "chat-1", "message": "hello"},
        )

    assert response.status_code == 403
    assert len(enqueue_calls) == 0


@pytest.mark.asyncio
async def test_append_message_requires_run_ownership(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="owner-user")
    enqueue_calls: list[dict[str, str]] = []
    session = _make_session(user_id="other-user")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "owner-user"},
        enqueue_calls=enqueue_calls,
    ) as client:
        response = await client.post(
            f"/api/agentic/runs/{run['id']}/messages",
            json={"message": "hello-again"},
        )

    assert response.status_code == 403
    assert len(enqueue_calls) == 0


@pytest.mark.asyncio
async def test_polling_events_respects_after_seq(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="user-1")
    run_service.append_event(run["id"], "assistant.delta", {"content": "hel"})
    run_service.append_event(run["id"], "assistant.message", {"content": "hello"})
    enqueue_calls: list[dict[str, str]] = []
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
        enqueue_calls=enqueue_calls,
    ) as client:
        response = await client.get(f"/api/agentic/runs/{run['id']}/events", params={"after_seq": 1})

    assert response.status_code == 200
    payload = response.json()
    assert [event["seq"] for event in payload["events"]] == [2]
    assert payload["next_seq"] == 2
    assert payload["done"] is False


@pytest.mark.asyncio
async def test_sse_stream_returns_backfill(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="user-1")
    run_service.append_event(run["id"], "assistant.delta", {"content": "hel"})
    run_service.append_event(run["id"], "assistant.message", {"content": "hello"})
    run_service.set_status(run["id"], "completed", latest_output="hello")

    enqueue_calls: list[dict[str, str]] = []
    session = _make_session(user_id="user-1")

    async with _build_api_client(
        monkeypatch=monkeypatch,
        session=session,
        run_service=run_service,
        owner_by_project_id={"project-1": "user-1"},
        enqueue_calls=enqueue_calls,
    ) as client:
        response = await client.get(
            f"/api/agentic/runs/{run['id']}/events",
            headers={"Accept": "text/event-stream"},
        )

    assert response.status_code == 200
    assert "id: 1" in response.text
    assert "id: 2" in response.text
    assert "assistant.message" in response.text


@pytest.mark.asyncio
async def test_sse_stream_emits_heartbeat_when_idle(monkeypatch) -> None:
    run_service = AgenticRunService(directus_client=InMemoryDirectus())
    run = run_service.create_run(project_id="project-1", directus_user_id="user-1")
    monkeypatch.setattr(agentic_api, "agentic_run_service", run_service)
    monkeypatch.setattr(agentic_api, "SSE_HEARTBEAT_SECONDS", 0.01)

    generator = agentic_api._event_stream(run_id=run["id"], after_seq=0)
    first = await generator.__anext__()
    await generator.aclose()

    assert first == "event: heartbeat\n"
