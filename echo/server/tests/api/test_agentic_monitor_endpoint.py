from __future__ import annotations

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

import dembrane.api.agentic as agentic_api
import dembrane.api.v2.bff.conversations as conv_bff
from dembrane.api.agentic import AgenticRouter
from dembrane.api.dependency_auth import DirectusSession, require_directus_session


@pytest.mark.asyncio
async def test_agentic_monitor_endpoint_gates_and_returns_payload(monkeypatch) -> None:
    app = FastAPI()
    app.include_router(AgenticRouter, prefix="/api/agentic")

    gate_calls: list[str] = []

    async def _fake_assert(project_id: str, auth) -> None:  # noqa: ARG001
        gate_calls.append(project_id)

    monkeypatch.setattr(agentic_api, "_assert_project_access", _fake_assert)

    payload = {
        "summary": {"live": 1, "transcribing": 0, "with_errors": 0, "total": 1},
        "conversations": [{"id": "c1", "is_live": True}],
        "live_window_seconds": 45,
    }

    async def _fake_gather(project_id: str, window_seconds: int) -> dict:  # noqa: ARG001
        return payload

    monkeypatch.setattr(conv_bff, "gather_project_monitor", _fake_gather)

    async def _override() -> DirectusSession:
        return DirectusSession(user_id="u1", is_admin=False, access_token="t", client=None)

    app.dependency_overrides[require_directus_session] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        res = await client.get("/api/agentic/projects/p1/monitor")

    assert res.status_code == 200
    assert res.json() == payload
    assert gate_calls == ["p1"]
