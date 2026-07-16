"""Tests for the public participant liveness beacons (dembrane.api.participant):
`POST /participant/conversations/{id}/ping` and
`POST /participant/projects/{pid}/visitors/{vid}/ping`.

Both endpoints are called every few seconds by unauthenticated portal clients,
so they must be cheap and never disrupt recording: a Redis blip, an
over-the-soft-limit caller, or an absurd id all degrade to a silent
`{"ok": ...}` rather than raising. Calls the route coroutines directly
(no ASGI transport needed — no auth dependency and no streaming response
here), matching the direct-call style used for the monitor stream tests in
test_conversation_monitor.py.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any, Optional

import pytest

import dembrane.api.participant as participant


def _run(coro: Any) -> Any:
    return asyncio.new_event_loop().run_until_complete(coro)


class _FakeRequest:
    """Stand-in for FastAPI's `Request`. `_participant_client_ip` only reads
    `.headers` (dict-like, for X-Forwarded-For) and `.client.host`."""

    def __init__(self, *, ip: str = "203.0.113.1", forwarded_for: Optional[str] = None) -> None:
        self.headers: dict[str, str] = {"x-forwarded-for": forwarded_for} if forwarded_for else {}
        self.client = SimpleNamespace(host=ip)


@pytest.fixture(autouse=True)
def _bypass_rate_limits(monkeypatch):
    """Keep these tests fast and Redis-free by default. The rate-limit tests
    below re-patch `allow` on top of this to simulate an over-limit caller."""

    async def _allow(_identifier: str) -> bool:
        return True

    monkeypatch.setattr(participant._conversation_ping_rate_limiter, "allow", _allow)
    monkeypatch.setattr(participant._visitor_ping_rate_limiter, "allow", _allow)


# ── conversation ping ──────────────────────────────────────────────────


def test_ping_conversation_returns_ok(monkeypatch) -> None:
    seen: list[tuple[str, object]] = []

    async def _fake_mark(conversation_id: str, *, telemetry: Any = None) -> None:
        seen.append((conversation_id, telemetry))

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)

    result = _run(participant.ping_conversation("conv-1", _FakeRequest()))

    assert result == {"ok": True}
    assert seen == [("conv-1", None)]


def test_ping_conversation_persists_and_publishes_telemetry(monkeypatch) -> None:
    seen: list[tuple[str, object]] = []
    published: list[str] = []
    registered: list[tuple[str, str]] = []

    async def _fake_mark(conversation_id: str, *, telemetry: Any = None) -> None:
        seen.append((conversation_id, telemetry))

    async def _fake_publish(project_id: str) -> None:
        published.append(project_id)

    async def _fake_register(
        project_id: str, conversation_id: str, *, score: float
    ) -> None:  # noqa: ARG001
        registered.append((project_id, conversation_id))

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)
    monkeypatch.setattr(participant, "publish_monitor_dirty", _fake_publish)
    monkeypatch.setattr(participant, "register_active_conversation", _fake_register)

    body = participant.ConversationPingRequest(
        project_id="proj-9",
        state="paused",
        mode="voice",
        network=participant.ConversationNetworkTelemetry(effective_type="3g", online=True),
        battery=participant.ConversationBatteryTelemetry(level=0.4, charging=False),
    )
    result = _run(participant.ping_conversation("conv-1", _FakeRequest(), body))

    assert result == {"ok": True}
    assert seen[0][0] == "conv-1"
    telemetry = seen[0][1]
    assert telemetry["state"] == "paused"
    assert telemetry["mode"] == "voice"
    assert telemetry["network"] == {"effective_type": "3g", "online": True}
    assert telemetry["battery"] == {"level": 0.4, "charging": False}
    assert published == ["proj-9"]
    assert registered == [("proj-9", "conv-1")]


def test_ping_conversation_clamps_audio_level(monkeypatch) -> None:
    captured: list[Any] = []

    async def _fake_mark(conversation_id: str, *, telemetry: Any = None) -> None:  # noqa: ARG001
        captured.append(telemetry)

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)

    def _ping(level: float) -> Any:
        _run(
            participant.ping_conversation(
                "c", _FakeRequest(), participant.ConversationPingRequest(audio_level=level)
            )
        )
        return captured[-1]

    assert _ping(0.4567)["audio_level"] == 0.46
    assert _ping(5.0)["audio_level"] == 1.0
    assert _ping(-2.0)["audio_level"] == 0.0
    # NaN / inf from a misbehaving client are ignored, not stored as junk (and
    # since it's the only field, the whole telemetry collapses to None).
    assert (_ping(float("nan")) or {}).get("audio_level") is None
    assert (_ping(float("inf")) or {}).get("audio_level") is None


def test_ping_conversation_drops_unknown_state(monkeypatch) -> None:
    seen: list[Any] = []

    async def _fake_mark(conversation_id: str, *, telemetry: Any = None) -> None:  # noqa: ARG001
        seen.append(telemetry)

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)

    body = participant.ConversationPingRequest(state="bogus", mode="carrier-pigeon")
    _run(participant.ping_conversation("conv-1", _FakeRequest(), body))

    # Unknown state + unknown mode are both dropped, leaving an empty (None) payload.
    assert seen == [None]


def test_ping_conversation_best_effort_on_redis_error(monkeypatch) -> None:
    """A Redis blip must never raise into the participant's recording loop —
    the endpoint always returns a clean JSON response instead."""

    async def _boom(conversation_id: str, *, telemetry: Any = None) -> None:  # noqa: ARG001
        raise RuntimeError("redis down")

    monkeypatch.setattr(participant, "mark_conversation_seen", _boom)

    result = _run(participant.ping_conversation("conv-1", _FakeRequest()))

    assert result == {"ok": False}


def test_ping_conversation_rate_limited_drops_silently(monkeypatch) -> None:
    """Over the soft per-IP limit: drop the beacon but still report ok, and
    never touch Redis liveness state."""
    calls: list[str] = []

    async def _fake_mark(conversation_id: str, *, telemetry: Any = None) -> None:  # noqa: ARG001
        calls.append(conversation_id)

    async def _deny(_identifier: str) -> bool:
        return False

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)
    monkeypatch.setattr(participant._conversation_ping_rate_limiter, "allow", _deny)

    result = _run(participant.ping_conversation("conv-1", _FakeRequest()))

    assert result == {"ok": True}
    assert calls == []


def test_ping_conversation_absurd_id_length_drops_silently(monkeypatch) -> None:
    calls: list[str] = []

    async def _fake_mark(conversation_id: str, *, telemetry: Any = None) -> None:  # noqa: ARG001
        calls.append(conversation_id)

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)

    long_id = "x" * (participant._MAX_PING_ID_LEN + 1)
    result = _run(participant.ping_conversation(long_id, _FakeRequest()))

    assert result == {"ok": True}
    assert calls == []


def test_ping_conversation_monitor_disabled_drops_silently(monkeypatch) -> None:
    """Server-side kill switch: the beacon no-ops (no Redis write) and reports ok."""
    calls: list[str] = []

    async def _fake_mark(conversation_id: str, *, telemetry: Any = None) -> None:  # noqa: ARG001
        calls.append(conversation_id)

    monkeypatch.setattr(participant, "mark_conversation_seen", _fake_mark)
    monkeypatch.setattr(participant.settings.feature_flags, "enable_monitor", False)

    result = _run(participant.ping_conversation("conv-1", _FakeRequest()))

    assert result == {"ok": True}
    assert calls == []


# ── visitor ping ───────────────────────────────────────────────────────


def test_ping_visitor_sanitises_and_publishes(monkeypatch) -> None:
    marked: list[tuple[str, str, object]] = []
    published: list[str] = []

    async def _fake_mark(project_id, visitor_id, *, telemetry=None, score=None):  # noqa: ANN001, ARG001
        marked.append((project_id, visitor_id, telemetry))

    async def _fake_publish(project_id: str) -> None:
        published.append(project_id)

    monkeypatch.setattr(participant, "mark_visitor_seen", _fake_mark)
    monkeypatch.setattr(participant, "publish_monitor_dirty", _fake_publish)

    body = participant.VisitorPingRequest(
        stage="mic_skipped",
        name="Ada",
        tags=["Table 3", "  "],
        tags_preselected=True,
        scan_count=2,
    )
    result = _run(participant.ping_visitor("proj-1", "vis-1", _FakeRequest(), body))

    assert result == {"ok": True}
    project_id, visitor_id, telemetry = marked[0]
    assert (project_id, visitor_id) == ("proj-1", "vis-1")
    assert telemetry["stage"] == "mic_skipped"
    assert telemetry["name"] == "Ada"
    assert telemetry["tags"] == ["Table 3"]  # blank tag dropped
    assert telemetry["tags_preselected"] is True
    assert telemetry["scan_count"] == 2
    assert published == ["proj-1"]


def test_ping_visitor_drops_unknown_stage(monkeypatch) -> None:
    marked: list[Any] = []

    async def _fake_mark(project_id, visitor_id, *, telemetry=None, score=None):  # noqa: ANN001, ARG001
        marked.append(telemetry)

    async def _fake_publish(project_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr(participant, "mark_visitor_seen", _fake_mark)
    monkeypatch.setattr(participant, "publish_monitor_dirty", _fake_publish)

    body = participant.VisitorPingRequest(stage="banana")
    _run(participant.ping_visitor("proj-1", "vis-1", _FakeRequest(), body))
    # Unknown stage dropped -> empty telemetry -> None passed to mark.
    assert marked == [None]


def test_ping_visitor_best_effort_on_redis_error(monkeypatch) -> None:
    async def _boom(project_id, visitor_id, *, telemetry=None, score=None):  # noqa: ANN001, ARG001
        raise RuntimeError("redis down")

    monkeypatch.setattr(participant, "mark_visitor_seen", _boom)

    result = _run(participant.ping_visitor("proj-1", "vis-1", _FakeRequest()))

    assert result == {"ok": False}


def test_ping_visitor_rate_limited_drops_silently(monkeypatch) -> None:
    marked: list[Any] = []

    async def _fake_mark(project_id, visitor_id, *, telemetry=None, score=None):  # noqa: ANN001, ARG001
        marked.append((project_id, visitor_id))

    async def _deny(_identifier: str) -> bool:
        return False

    monkeypatch.setattr(participant, "mark_visitor_seen", _fake_mark)
    monkeypatch.setattr(participant._visitor_ping_rate_limiter, "allow", _deny)

    result = _run(participant.ping_visitor("proj-1", "vis-1", _FakeRequest()))

    assert result == {"ok": True}
    assert marked == []


def test_ping_visitor_absurd_id_length_drops_silently(monkeypatch) -> None:
    marked: list[Any] = []

    async def _fake_mark(project_id, visitor_id, *, telemetry=None, score=None):  # noqa: ANN001, ARG001
        marked.append((project_id, visitor_id))

    monkeypatch.setattr(participant, "mark_visitor_seen", _fake_mark)

    long_id = "y" * (participant._MAX_PING_ID_LEN + 1)
    result = _run(participant.ping_visitor(long_id, "vis-1", _FakeRequest()))

    assert result == {"ok": True}
    assert marked == []


def test_ping_visitor_monitor_disabled_drops_silently(monkeypatch) -> None:
    """Server-side kill switch: the funnel beacon no-ops and reports ok."""
    marked: list[Any] = []

    async def _fake_mark(project_id, visitor_id, *, telemetry=None, score=None):  # noqa: ANN001, ARG001
        marked.append((project_id, visitor_id))

    monkeypatch.setattr(participant, "mark_visitor_seen", _fake_mark)
    monkeypatch.setattr(participant.settings.feature_flags, "enable_monitor", False)

    result = _run(participant.ping_visitor("proj-1", "vis-1", _FakeRequest()))

    assert result == {"ok": True}
    assert marked == []
