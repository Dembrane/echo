from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

import dembrane.api.v2.bff.conversations as conv_bff
from dembrane.api.dependency_auth import DirectusSession, require_directus_session
from dembrane.api.v2.bff.conversations import router as conversations_router


class _FakeDirectus:
    """Routes the reads list_conversations makes: the conversation page, the
    artifact embed, and the three conversation_chunk reads (lean / transcript
    presence / error presence), keyed by the filter shape."""

    def __init__(self, convs: list[dict], error_conv_ids: list[str]) -> None:
        self._convs = convs
        self._error_conv_ids = error_conv_ids

    async def get_items(self, collection: str, params: dict) -> list[dict]:
        query = (params or {}).get("query", {})
        filt = query.get("filter", {})
        if collection == "conversation":
            return [dict(c) for c in self._convs]
        if collection == "conversation_artifact":
            return []
        if collection == "conversation_chunk":
            if "error" in filt:
                return [{"conversation_id": cid} for cid in self._error_conv_ids]
            if "transcript" in filt:
                # transcript-present read: pretend every conversation has one
                return [{"conversation_id": c["id"]} for c in self._convs]
            # lean read: one audio chunk each
            return [
                {
                    "conversation_id": c["id"],
                    "source": "PORTAL_AUDIO",
                    "timestamp": "2026-07-03T10:00:00Z",
                    "created_at": "2026-07-03T10:00:00Z",
                }
                for c in self._convs
            ]
        return []


@asynccontextmanager
async def _client(monkeypatch, convs: list[dict], error_conv_ids: list[str]):
    app = FastAPI()
    app.include_router(conversations_router, prefix="/conversations")
    monkeypatch.setattr(conv_bff, "async_directus", _FakeDirectus(convs, error_conv_ids))

    async def _fake_access(project_id: str, auth: Any) -> Any:  # noqa: ARG001
        return SimpleNamespace(require=lambda _p: None, tier=None, role="owner", project={})

    monkeypatch.setattr(conv_bff, "resolve_project_access", _fake_access)

    async def _override() -> DirectusSession:
        return DirectusSession(user_id="u1", is_admin=False, access_token="t", client=None)

    app.dependency_overrides[require_directus_session] = _override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


@pytest.mark.asyncio
async def test_list_flags_conversations_with_transcription_errors(monkeypatch) -> None:
    convs = [
        {"id": "c-ok", "project_id": "p1", "source": "PORTAL_AUDIO"},
        {"id": "c-bad", "project_id": "p1", "source": "upload"},
    ]
    async with _client(monkeypatch, convs, error_conv_ids=["c-bad"]) as client:
        res = await client.get("/conversations", params={"project_id": "p1"})

    assert res.status_code == 200
    by_id = {c["id"]: c for c in res.json()}
    # Source-agnostic: an uploaded conversation's failure surfaces too.
    assert by_id["c-bad"]["has_transcription_error"] is True
    assert by_id["c-ok"]["has_transcription_error"] is False


@pytest.mark.asyncio
async def test_list_no_errors_flags_nothing(monkeypatch) -> None:
    convs = [{"id": "c1", "project_id": "p1", "source": "PORTAL_AUDIO"}]
    async with _client(monkeypatch, convs, error_conv_ids=[]) as client:
        res = await client.get("/conversations", params={"project_id": "p1"})

    assert res.status_code == 200
    assert res.json()[0]["has_transcription_error"] is False
