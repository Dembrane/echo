from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from datetime import datetime, timezone, timedelta
from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

import dembrane.api.v2.bff.conversations as conv_bff
from dembrane.api.dependency_auth import DirectusSession, require_directus_session
from dembrane.api.v2.bff.conversations import (
    MONITOR_LIVE_WINDOW_SECONDS,
    MONITOR_ERROR_MESSAGE_MAX_LEN,
    router as conversations_router,
    _build_monitor_payload,
    _parse_directus_timestamp,
)


def _iso(dt: datetime) -> str:
    # Mimic Directus's trailing-Z UTC serialization.
    return dt.astimezone(timezone.utc).replace(tzinfo=None).isoformat() + "Z"


# ── pure helper: liveness threshold + error detection ─────────────────


def test_parse_directus_timestamp_handles_z_suffix() -> None:
    parsed = _parse_directus_timestamp("2026-07-02T12:00:00.000Z")
    assert parsed is not None
    assert parsed.tzinfo is not None
    assert parsed.year == 2026 and parsed.hour == 12


def test_parse_directus_timestamp_rejects_junk() -> None:
    assert _parse_directus_timestamp(None) is None
    assert _parse_directus_timestamp("") is None
    assert _parse_directus_timestamp("not-a-date") is None


def test_monitor_liveness_threshold() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    live_ts = _iso(now - timedelta(seconds=10))  # within 45s window
    stale_ts = _iso(now - timedelta(seconds=120))  # outside window

    recent_chunks = [
        {"conversation_id": {"id": "c-live", "participant_name": "Ada"}, "timestamp": live_ts, "error": None},
        {"conversation_id": {"id": "c-stale", "participant_name": "Bo"}, "timestamp": stale_ts, "error": None},
    ]
    chunk_counts = {"c-live": 3, "c-stale": 9}

    payload = _build_monitor_payload(recent_chunks, chunk_counts, now, live_window_seconds=45)

    by_id = {c["id"]: c for c in payload["conversations"]}
    assert by_id["c-live"]["is_live"] is True
    assert by_id["c-live"]["label"] == "Ada"
    assert by_id["c-live"]["chunk_count"] == 3
    assert by_id["c-stale"]["is_live"] is False
    assert by_id["c-stale"]["chunk_count"] == 9

    assert payload["summary"]["live"] == 1
    assert payload["summary"]["total"] == 2
    assert payload["summary"]["with_errors"] == 0
    assert payload["live_window_seconds"] == 45

    # Live conversation is sorted to the top.
    assert payload["conversations"][0]["id"] == "c-live"


def test_monitor_error_detection_takes_most_recent_error() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    newer_ts = _iso(now - timedelta(seconds=5))
    older_ts = _iso(now - timedelta(seconds=30))

    # Newest-first ordering, as the endpoint queries with sort=-timestamp.
    recent_chunks = [
        {"conversation_id": {"id": "c-err", "participant_name": None}, "timestamp": newer_ts, "error": "newer boom"},
        {"conversation_id": {"id": "c-err", "participant_name": None}, "timestamp": older_ts, "error": "older boom"},
    ]

    payload = _build_monitor_payload(recent_chunks, {"c-err": 2}, now, live_window_seconds=45)
    entry = payload["conversations"][0]

    assert entry["has_error"] is True
    assert entry["error_message"] == "newer boom"
    assert entry["label"] is None  # falls back to None when no participant name
    assert payload["summary"]["with_errors"] == 1


def test_monitor_error_message_is_truncated() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    long_error = "x" * (MONITOR_ERROR_MESSAGE_MAX_LEN + 100)
    recent_chunks = [
        {"conversation_id": {"id": "c1", "participant_name": "Q"}, "timestamp": _iso(now), "error": long_error},
    ]
    payload = _build_monitor_payload(recent_chunks, {"c1": 1}, now, live_window_seconds=45)
    assert len(payload["conversations"][0]["error_message"]) == MONITOR_ERROR_MESSAGE_MAX_LEN


def test_monitor_empty_project() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    payload = _build_monitor_payload([], {}, now, live_window_seconds=45)
    assert payload["conversations"] == []
    assert payload["summary"] == {"live": 0, "with_errors": 0, "total": 0}


# ── endpoint wiring: access gate + two-query aggregation ──────────────


class _AsyncFakeDirectus:
    """Async stand-in for async_directus. Returns canned rows for the
    recent-chunk read and the grouped count read."""

    def __init__(self, recent_chunks: list[dict], counts: dict[str, int]) -> None:
        self._recent_chunks = recent_chunks
        self._counts = counts
        self.queries: list[dict] = []

    async def get_items(self, collection: str, params: dict) -> list[dict]:
        query = (params or {}).get("query", {})
        self.queries.append({"collection": collection, "query": query})
        if "aggregate" in query:
            return [
                {"conversation_id": cid, "count": {"id": cnt}}
                for cid, cnt in self._counts.items()
            ]
        return list(self._recent_chunks)


@asynccontextmanager
async def _build_client(monkeypatch, recent_chunks: list[dict], counts: dict[str, int]):
    app = FastAPI()
    app.include_router(conversations_router, prefix="/conversations")

    fake_directus = _AsyncFakeDirectus(recent_chunks, counts)
    monkeypatch.setattr(conv_bff, "async_directus", fake_directus)

    async def _fake_resolve_project_access(project_id: str, auth: Any) -> Any:  # noqa: ARG001
        return SimpleNamespace(require=lambda _policy: None, role="owner", project={})

    monkeypatch.setattr(conv_bff, "resolve_project_access", _fake_resolve_project_access)

    async def _override_session() -> DirectusSession:
        return DirectusSession(user_id="user-1", is_admin=False, access_token="t", client=None)

    app.dependency_overrides[require_directus_session] = _override_session

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client, fake_directus


@pytest.mark.asyncio
async def test_monitor_endpoint_returns_rollup(monkeypatch) -> None:
    now = datetime.now(timezone.utc)
    recent_chunks = [
        {
            "conversation_id": {"id": "c-live", "participant_name": "Ada"},
            "timestamp": _iso(now - timedelta(seconds=5)),
            "error": None,
        },
        {
            "conversation_id": {"id": "c-err", "participant_name": "Bo"},
            "timestamp": _iso(now - timedelta(seconds=8)),
            "error": "transcription failed",
        },
    ]
    counts = {"c-live": 4, "c-err": 2}

    async with _build_client(monkeypatch, recent_chunks, counts) as (client, fake_directus):
        res = await client.get("/conversations/monitor", params={"project_id": "p-1"})

    assert res.status_code == 200
    body = res.json()
    assert body["summary"]["total"] == 2
    assert body["summary"]["live"] == 2
    assert body["summary"]["with_errors"] == 1
    assert body["live_window_seconds"] == MONITOR_LIVE_WINDOW_SECONDS

    err = next(c for c in body["conversations"] if c["id"] == "c-err")
    assert err["has_error"] is True
    assert err["error_message"] == "transcription failed"
    assert err["chunk_count"] == 2

    # Exactly two Directus reads: the recent-chunk read + the grouped count.
    assert len(fake_directus.queries) == 2
    assert "aggregate" in fake_directus.queries[1]["query"]


@pytest.mark.asyncio
async def test_monitor_endpoint_empty_skips_count_query(monkeypatch) -> None:
    async with _build_client(monkeypatch, [], {}) as (client, fake_directus):
        res = await client.get("/conversations/monitor", params={"project_id": "p-1"})

    assert res.status_code == 200
    body = res.json()
    assert body["conversations"] == []
    assert body["summary"] == {"live": 0, "with_errors": 0, "total": 0}
    # No conversation ids → no second (count) query.
    assert len(fake_directus.queries) == 1
