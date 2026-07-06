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

    payload = _build_monitor_payload(
        recent_chunks, chunk_counts, chunk_counts, now, live_window_seconds=45
    )

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


def test_monitor_finished_conversation_is_not_live() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    recent_ts = _iso(now - timedelta(seconds=10))  # within the live window

    # A finished conversation with a fresh chunk must still read as not-live:
    # the finish button is a definitive end signal.
    recent_chunks = [
        {
            "conversation_id": {"id": "c-fin", "participant_name": "Ada", "is_finished": True},
            "timestamp": recent_ts,
            "error": None,
        },
        {
            "conversation_id": {"id": "c-live", "participant_name": "Bo", "is_finished": False},
            "timestamp": recent_ts,
            "error": None,
        },
    ]

    payload = _build_monitor_payload(
        recent_chunks, {"c-fin": 5, "c-live": 2}, {"c-fin": 5, "c-live": 2}, now, live_window_seconds=45
    )
    by_id = {c["id"]: c for c in payload["conversations"]}

    assert by_id["c-fin"]["is_finished"] is True
    assert by_id["c-fin"]["is_live"] is False
    assert by_id["c-live"]["is_finished"] is False
    assert by_id["c-live"]["is_live"] is True
    assert payload["summary"]["live"] == 1
    assert payload["summary"]["finished"] == 1


def test_monitor_error_detection_takes_most_recent_error() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    newer_ts = _iso(now - timedelta(seconds=5))
    older_ts = _iso(now - timedelta(seconds=30))

    # Newest-first ordering, as the endpoint queries with sort=-timestamp.
    recent_chunks = [
        {"conversation_id": {"id": "c-err", "participant_name": None}, "timestamp": newer_ts, "error": "newer boom"},
        {"conversation_id": {"id": "c-err", "participant_name": None}, "timestamp": older_ts, "error": "older boom"},
    ]

    payload = _build_monitor_payload(
        recent_chunks, {"c-err": 2}, {"c-err": 0}, now, live_window_seconds=45
    )
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
    payload = _build_monitor_payload(
        recent_chunks, {"c1": 1}, {"c1": 0}, now, live_window_seconds=45
    )
    assert len(payload["conversations"][0]["error_message"]) == MONITOR_ERROR_MESSAGE_MAX_LEN


def test_monitor_empty_project() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    payload = _build_monitor_payload([], {}, {}, now, live_window_seconds=45)
    assert payload["conversations"] == []
    assert payload["summary"] == {
        "live": 0,
        "finished": 0,
        "transcribing": 0,
        "with_errors": 0,
        "not_receiving": 0,
        "total": 0,
        "pending_transcription": 0,
        "catch_up_eta_seconds": 0,
    }


def test_monitor_transcription_progress_and_status() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    fresh = _iso(now - timedelta(seconds=5))
    recent_chunks = [
        # live, mid-stream: 5 chunks in, 3 transcribed -> transcribing
        {"conversation_id": {"id": "c-mid", "participant_name": "Ada"}, "timestamp": fresh, "error": None},
        # done transcribing: 4/4 -> up_to_date
        {"conversation_id": {"id": "c-done", "participant_name": "Bo"}, "timestamp": fresh, "error": None},
        # failing: a chunk carries an error -> failing regardless of counts
        {"conversation_id": {"id": "c-bad", "participant_name": "Cy"}, "timestamp": fresh, "error": "boom"},
    ]
    chunk_counts = {"c-mid": 5, "c-done": 4, "c-bad": 3}
    transcribed_counts = {"c-mid": 3, "c-done": 4, "c-bad": 1}

    payload = _build_monitor_payload(
        recent_chunks, chunk_counts, transcribed_counts, now, live_window_seconds=45
    )
    by_id = {c["id"]: c for c in payload["conversations"]}

    assert by_id["c-mid"]["transcription_status"] == "transcribing"
    assert by_id["c-mid"]["transcribed_count"] == 3
    assert by_id["c-mid"]["pending_transcription"] == 2

    assert by_id["c-done"]["transcription_status"] == "up_to_date"
    assert by_id["c-done"]["pending_transcription"] == 0

    assert by_id["c-bad"]["transcription_status"] == "failing"

    assert payload["summary"]["transcribing"] == 1


def test_monitor_transcribed_count_clamped_to_total() -> None:
    # A late total-count read could momentarily trail the transcribed read;
    # transcribed must never exceed total, and pending never goes negative.
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    recent_chunks = [
        {"conversation_id": {"id": "c1", "participant_name": "Q"}, "timestamp": _iso(now), "error": None},
    ]
    payload = _build_monitor_payload(
        recent_chunks, {"c1": 2}, {"c1": 5}, now, live_window_seconds=45
    )
    entry = payload["conversations"][0]
    assert entry["transcribed_count"] == 2
    assert entry["pending_transcription"] == 0
    assert entry["transcription_status"] == "up_to_date"


def test_monitor_ping_keeps_conversation_live_without_recent_chunk() -> None:
    # A conversation whose last chunk is stale but which is still pinging
    # (participant recording through a gap) must read as live: the ping is
    # the primary signal.
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    stale_chunk = _iso(now - timedelta(seconds=120))  # outside the window
    recent_chunks = [
        {"conversation_id": {"id": "c-ping", "participant_name": "Ada"}, "timestamp": stale_chunk, "error": None},
    ]
    telemetry = {"c-ping": {"seen": now - timedelta(seconds=6)}}  # pinged 6s ago

    payload = _build_monitor_payload(
        recent_chunks, {"c-ping": 3}, {"c-ping": 3}, now, 45, telemetry
    )
    entry = payload["conversations"][0]
    assert entry["is_live"] is True
    assert entry["last_seen_at"] is not None
    assert payload["summary"]["live"] == 1


def test_monitor_finished_conversation_ignores_ping() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    recent_chunks = [
        {
            "conversation_id": {"id": "c-fin", "participant_name": "Ada", "is_finished": True},
            "timestamp": _iso(now - timedelta(seconds=5)),
            "error": None,
        },
    ]
    # Even a fresh ping cannot revive a finished conversation.
    telemetry = {"c-fin": {"seen": now - timedelta(seconds=2)}}
    payload = _build_monitor_payload(
        recent_chunks, {"c-fin": 2}, {"c-fin": 2}, now, 45, telemetry
    )
    assert payload["conversations"][0]["is_live"] is False


def test_monitor_lifecycle_state_prefers_reported_then_observed() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    fresh = _iso(now - timedelta(seconds=5))
    recent_chunks = [
        # reported paused (still pinging) -> paused, even with a fresh chunk
        {"conversation_id": {"id": "c-paused", "participant_name": "Ada"}, "timestamp": fresh, "error": None},
        # reported verifying -> verifying
        {"conversation_id": {"id": "c-verify", "participant_name": "Bo"}, "timestamp": fresh, "error": None},
        # no telemetry, fresh chunk -> observed recording
        {"conversation_id": {"id": "c-rec", "participant_name": "Cy"}, "timestamp": fresh, "error": None},
        # finished wins over any reported state
        {
            "conversation_id": {"id": "c-fin", "participant_name": "Di", "is_finished": True},
            "timestamp": fresh,
            "error": None,
        },
    ]
    telemetry = {
        "c-paused": {"seen": now - timedelta(seconds=3), "state": "paused"},
        "c-verify": {"seen": now - timedelta(seconds=3), "state": "verifying"},
        "c-fin": {"seen": now - timedelta(seconds=3), "state": "recording"},
    }
    counts = {"c-paused": 2, "c-verify": 1, "c-rec": 3, "c-fin": 4}
    payload = _build_monitor_payload(recent_chunks, counts, counts, now, 45, telemetry)
    by_id = {c["id"]: c for c in payload["conversations"]}
    assert by_id["c-paused"]["state"] == "paused"
    assert by_id["c-verify"]["state"] == "verifying"
    assert by_id["c-rec"]["state"] == "recording"
    assert by_id["c-fin"]["state"] == "finished"


def test_monitor_surfaces_metadata_and_telemetry() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    fresh = _iso(now - timedelta(seconds=5))
    older = _iso(now - timedelta(seconds=40))
    recent_chunks = [
        # newest chunk carries the latest transcript + language
        {
            "conversation_id": {"id": "c1", "participant_name": "Ada"},
            "timestamp": fresh,
            "error": None,
            "transcript": "the newest thing said",
            "desired_language": "nl",
        },
        {
            "conversation_id": {"id": "c1", "participant_name": "Ada"},
            "timestamp": older,
            "error": None,
            "transcript": "older words",
            "detected_language": "en",
        },
    ]
    telemetry = {
        "c1": {
            "seen": now - timedelta(seconds=3),
            "state": "recording",
            "mode": "voice",
            "network": {"effective_type": "3g"},
            "battery": {"level": 0.2, "charging": False},
        }
    }
    tag_map = {"c1": ["Morning session", "Team A"]}
    payload = _build_monitor_payload(recent_chunks, {"c1": 2}, {"c1": 1}, now, 45, telemetry, tag_map)
    entry = payload["conversations"][0]
    assert entry["latest_transcript"] == "the newest thing said"
    assert entry["language"] == "nl"
    assert entry["mode"] == "voice"
    assert entry["tags"] == ["Morning session", "Team A"]
    assert entry["network"] == {"effective_type": "3g"}
    assert entry["battery"] == {"level": 0.2, "charging": False}


def test_monitor_surfaces_audio_level_and_defaults_null() -> None:
    # The participant's live mic level flows from the beacon into the payload so
    # the host sees a signal meter; it's null when the portal doesn't report it.
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    fresh = _iso(now - timedelta(seconds=5))
    recent_chunks = [
        {"conversation_id": {"id": "c-loud", "participant_name": "Ada"}, "timestamp": fresh, "error": None},
        {"conversation_id": {"id": "c-quiet", "participant_name": "Bo"}, "timestamp": fresh, "error": None},
    ]
    telemetry = {
        "c-loud": {"seen": now - timedelta(seconds=2), "state": "recording", "audio_level": 0.42},
        "c-quiet": {"seen": now - timedelta(seconds=2), "state": "recording"},
    }
    counts = {"c-loud": 3, "c-quiet": 3}
    payload = _build_monitor_payload(recent_chunks, counts, counts, now, 45, telemetry)
    by_id = {c["id"]: c for c in payload["conversations"]}
    assert by_id["c-loud"]["audio_level"] == 0.42
    assert by_id["c-quiet"]["audio_level"] is None


def test_monitor_flags_stalled_recording() -> None:
    # A live conversation that had audio but hasn't received a chunk in a while
    # (dropped connection) must read as "stalled", not benign "waiting".
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    stale = _iso(now - timedelta(seconds=90))
    recent_chunks = [
        {"conversation_id": {"id": "c-stall", "participant_name": "Ada"}, "timestamp": stale, "error": None},
    ]
    telemetry = {"c-stall": {"seen": now - timedelta(seconds=3), "state": "recording"}}
    payload = _build_monitor_payload(
        recent_chunks, {"c-stall": 4}, {"c-stall": 4}, now, 45, telemetry
    )
    entry = payload["conversations"][0]
    assert entry["is_live"] is True
    assert entry["recording_health"] == "stalled"
    assert payload["summary"]["not_receiving"] == 1


def test_monitor_receiving_and_waiting_recording_health() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    fresh = _iso(now - timedelta(seconds=5))
    recent_chunks = [
        {"conversation_id": {"id": "c-ok", "participant_name": "Ada"}, "timestamp": fresh, "error": None},
    ]
    telemetry = {
        "c-ok": {"seen": now - timedelta(seconds=2), "state": "recording"},
        "c-wait": {"seen": now - timedelta(seconds=2), "state": "waiting"},
    }
    extras = [
        {"id": "c-wait", "participant_name": "Bo", "is_finished": False, "created_at": fresh, "duration": None},
    ]
    payload = _build_monitor_payload(
        recent_chunks, {"c-ok": 3}, {"c-ok": 3}, now, 45, telemetry, None, extras
    )
    by_id = {c["id"]: c for c in payload["conversations"]}
    assert by_id["c-ok"]["recording_health"] == "receiving"
    assert by_id["c-wait"]["recording_health"] == "waiting"
    assert payload["summary"]["not_receiving"] == 0


def test_monitor_reported_recording_no_chunk_is_not_stalled() -> None:
    # Recording reported, mic on, but no chunk has EVER landed (first chunk is
    # p50 ~45s / p90 minutes after landing). This must NOT alarm — it's still
    # "waiting" until audio actually flows. Guards the false "No audio" bug.
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    telemetry = {"c-new": {"seen": now - timedelta(seconds=2), "state": "recording"}}
    extras = [
        {
            "id": "c-new",
            "participant_name": "Ada",
            "is_finished": False,
            "created_at": _iso(now - timedelta(minutes=10)),
            "duration": None,
        }
    ]
    payload = _build_monitor_payload([], {}, {}, now, 45, telemetry, None, extras)
    entry = payload["conversations"][0]
    assert entry["recording_health"] == "waiting"
    assert payload["summary"]["not_receiving"] == 0


def test_monitor_backgrounded_is_gentle_not_stalled() -> None:
    # Phone locked / tab hidden while recording -> reported "backgrounded".
    # Even with a stale chunk, this reads as "backgrounded", not "stalled".
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    stale = _iso(now - timedelta(seconds=120))
    recent_chunks = [
        {"conversation_id": {"id": "c-bg", "participant_name": "Ada"}, "timestamp": stale, "error": None},
    ]
    telemetry = {"c-bg": {"seen": now - timedelta(seconds=3), "state": "backgrounded"}}
    payload = _build_monitor_payload(
        recent_chunks, {"c-bg": 4}, {"c-bg": 4}, now, 45, telemetry
    )
    entry = payload["conversations"][0]
    assert entry["recording_health"] == "backgrounded"
    assert payload["summary"]["not_receiving"] == 0


def test_monitor_seeds_initiated_conversation_without_chunks() -> None:
    # A just-initiated session pings but has no chunk yet. It must still appear,
    # seeded from extra_conversations + its telemetry state.
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    extras = [
        {
            "id": "c-new",
            "participant_name": "Ada",
            "is_finished": False,
            "created_at": _iso(now - timedelta(seconds=8)),
            "duration": None,
        }
    ]
    telemetry = {"c-new": {"seen": now - timedelta(seconds=2), "state": "waiting"}}
    payload = _build_monitor_payload([], {}, {}, now, 45, telemetry, None, extras)
    entry = payload["conversations"][0]
    assert entry["id"] == "c-new"
    assert entry["label"] == "Ada"
    assert entry["state"] == "waiting"
    assert entry["is_live"] is True  # a fresh ping keeps it live even with no chunk
    assert entry["chunk_count"] == 0
    assert payload["summary"]["live"] == 1


def test_monitor_carries_created_at_and_duration() -> None:
    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    created = _iso(now - timedelta(minutes=3))
    recent_chunks = [
        {
            "conversation_id": {
                "id": "c1",
                "participant_name": "Ada",
                "created_at": created,
                "duration": 182,
            },
            "timestamp": _iso(now - timedelta(seconds=5)),
            "error": None,
        },
    ]
    payload = _build_monitor_payload(recent_chunks, {"c1": 2}, {"c1": 2}, now, 45)
    entry = payload["conversations"][0]
    assert entry["created_at"] == created
    assert entry["duration"] == 182


def test_monitor_transcript_snippet_truncated() -> None:
    from dembrane.api.v2.bff.conversations import MONITOR_TRANSCRIPT_SNIPPET_MAX_LEN

    now = datetime(2026, 7, 2, 12, 0, 0, tzinfo=timezone.utc)
    long_text = "y" * (MONITOR_TRANSCRIPT_SNIPPET_MAX_LEN + 200)
    recent_chunks = [
        {
            "conversation_id": {"id": "c1", "participant_name": "Q"},
            "timestamp": _iso(now),
            "error": None,
            "transcript": long_text,
        },
    ]
    payload = _build_monitor_payload(recent_chunks, {"c1": 1}, {"c1": 1}, now, 45)
    assert len(payload["conversations"][0]["latest_transcript"]) == MONITOR_TRANSCRIPT_SNIPPET_MAX_LEN


def test_build_funnel_groups_stages_and_dedupes_graduated() -> None:
    from datetime import datetime, timezone

    from dembrane.api.v2.bff.conversations import _build_funnel

    now = datetime(2026, 7, 3, 12, 0, 0, tzinfo=timezone.utc)
    visitors = {
        "v-scan": {"seen": now, "stage": "scanned", "scan_count": 2},
        "v-mic-skip": {"seen": now, "stage": "mic_skipped"},
        "v-profile": {
            "seen": now,
            "stage": "profile",
            "name": "Ada",
            "tags": ["Table 3"],
            "tags_preselected": True,
        },
        # already graduated into a live conversation -> excluded
        "v-live": {"seen": now, "stage": "profile"},
        # unknown stage -> defaults to scanned
        "v-weird": {"seen": now, "stage": "banana"},
    }
    funnel = _build_funnel(visitors, graduated={"v-live"})
    by_id = {v["id"]: v for v in funnel["visitors"]}

    assert "v-live" not in by_id  # graduated dot is not double-counted
    assert by_id["v-scan"]["scan_count"] == 2
    assert by_id["v-mic-skip"]["stage"] == "mic_skipped"
    assert by_id["v-profile"]["name"] == "Ada"
    assert by_id["v-profile"]["tags"] == ["Table 3"]
    assert by_id["v-profile"]["tags_preselected"] is True
    assert by_id["v-weird"]["stage"] == "scanned"

    assert funnel["summary"]["scanned"] == 2  # v-scan + v-weird
    assert funnel["summary"]["mic_skipped"] == 1
    assert funnel["summary"]["profile"] == 1
    assert funnel["summary"]["total"] == 4


# ── endpoint wiring: access gate + two-query aggregation ──────────────


class _AsyncFakeDirectus:
    """Async stand-in for async_directus. Returns canned rows for the
    recent-chunk read, the grouped total-count read, and the grouped
    transcribed-count read (distinguished by the transcript filter)."""

    def __init__(
        self,
        recent_chunks: list[dict],
        counts: dict[str, int],
        transcribed: dict[str, int] | None = None,
    ) -> None:
        self._recent_chunks = recent_chunks
        self._counts = counts
        self._transcribed = transcribed if transcribed is not None else counts
        self.queries: list[dict] = []

    async def get_items(self, collection: str, params: dict) -> list[dict]:
        query = (params or {}).get("query", {})
        self.queries.append({"collection": collection, "query": query})
        if collection == "conversation_project_tag":
            return []
        if "aggregate" in query:
            # The transcribed-count read carries a transcript filter.
            source = (
                self._transcribed
                if "transcript" in (query.get("filter") or {})
                else self._counts
            )
            return [
                {"conversation_id": cid, "count": {"id": cnt}}
                for cid, cnt in source.items()
            ]
        return list(self._recent_chunks)


@asynccontextmanager
async def _build_client(
    monkeypatch,
    recent_chunks: list[dict],
    counts: dict[str, int],
    transcribed: dict[str, int] | None = None,
):
    app = FastAPI()
    app.include_router(conversations_router, prefix="/conversations")

    fake_directus = _AsyncFakeDirectus(recent_chunks, counts, transcribed)
    monkeypatch.setattr(conv_bff, "async_directus", fake_directus)

    # Liveness/telemetry read hits Redis in production; stub it out here.
    async def _fake_telemetry(conversation_ids: list[str]) -> dict:  # noqa: ARG001
        return {}

    monkeypatch.setattr(conv_bff, "get_telemetry_many", _fake_telemetry)

    # Active-index read hits Redis; stub to empty so gather stays chunk-only.
    async def _fake_active(project_id: str, *, min_score: float) -> list:  # noqa: ARG001
        return []

    monkeypatch.setattr(conv_bff, "get_active_conversation_ids", _fake_active)

    # Funnel (visitor) reads also hit Redis; stub to empty.
    async def _fake_active_visitors(project_id: str, *, min_score: float) -> list:  # noqa: ARG001
        return []

    async def _fake_visitors_many(project_id: str, visitor_ids: list) -> dict:  # noqa: ARG001
        return {}

    monkeypatch.setattr(conv_bff, "get_active_visitor_ids", _fake_active_visitors)
    monkeypatch.setattr(conv_bff, "get_visitors_many", _fake_visitors_many)

    # The snapshot cache also uses Redis; stub a always-miss client so the
    # endpoint recomputes (and the Directus query assertions still hold).
    class _NoCacheRedis:
        async def get(self, key):  # noqa: ANN001, ARG002
            return None

        async def set(self, key, value, ex=None, nx=None):  # noqa: ANN001, ARG002
            return True

    async def _fake_redis():
        return _NoCacheRedis()

    monkeypatch.setattr(conv_bff, "get_redis_client", _fake_redis)

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
    transcribed = {"c-live": 1, "c-err": 0}

    async with _build_client(monkeypatch, recent_chunks, counts, transcribed) as (
        client,
        fake_directus,
    ):
        res = await client.get("/conversations/monitor", params={"project_id": "p-1"})

    assert res.status_code == 200
    body = res.json()
    assert body["summary"]["total"] == 2
    assert body["summary"]["live"] == 2
    assert body["summary"]["with_errors"] == 1
    # c-live has 4 chunks, 1 transcribed -> transcribing.
    assert body["summary"]["transcribing"] == 1
    assert body["live_window_seconds"] == MONITOR_LIVE_WINDOW_SECONDS

    live = next(c for c in body["conversations"] if c["id"] == "c-live")
    assert live["transcribed_count"] == 1
    assert live["pending_transcription"] == 3
    assert live["transcription_status"] == "transcribing"

    err = next(c for c in body["conversations"] if c["id"] == "c-err")
    assert err["has_error"] is True
    assert err["error_message"] == "transcription failed"
    assert err["chunk_count"] == 2
    assert err["transcription_status"] == "failing"

    # Four Directus reads: recent-chunk read + total count + transcribed count
    # + the tag read for grouping.
    assert len(fake_directus.queries) == 4
    assert "aggregate" in fake_directus.queries[1]["query"]
    assert "aggregate" in fake_directus.queries[2]["query"]
    assert fake_directus.queries[3]["collection"] == "conversation_project_tag"


@pytest.mark.asyncio
async def test_monitor_endpoint_empty_skips_count_query(monkeypatch) -> None:
    async with _build_client(monkeypatch, [], {}) as (client, fake_directus):
        res = await client.get("/conversations/monitor", params={"project_id": "p-1"})

    assert res.status_code == 200
    body = res.json()
    assert body["conversations"] == []
    assert body["summary"] == {
        "live": 0,
        "finished": 0,
        "transcribing": 0,
        "with_errors": 0,
        "not_receiving": 0,
        "total": 0,
        "pending_transcription": 0,
        "catch_up_eta_seconds": 0,
    }
    # No conversation ids → no count queries.
    assert len(fake_directus.queries) == 1
