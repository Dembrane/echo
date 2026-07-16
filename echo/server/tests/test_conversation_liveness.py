from __future__ import annotations

from typing import Optional
from datetime import datetime, timezone, timedelta

import pytest

import dembrane.conversation_liveness as liveness


class _FakeRedis:
    """Minimal async Redis stand-in: set with ex, mget."""

    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}
        self.expires: dict[str, int] = {}

    async def set(self, key: str, value: str, ex: Optional[int] = None) -> None:
        self.store[key] = value.encode("utf-8")
        if ex is not None:
            self.expires[key] = ex

    async def get(self, key: str) -> Optional[bytes]:
        return self.store.get(key)

    async def mget(self, keys: list[str]) -> list[Optional[bytes]]:
        return [self.store.get(k) for k in keys]


@pytest.fixture
def fake_redis(monkeypatch) -> _FakeRedis:
    client = _FakeRedis()

    async def _get_client():
        return client

    monkeypatch.setattr(liveness, "get_redis_client", _get_client)
    return client


def _run(coro):
    import asyncio

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def test_mark_sets_key_with_ttl(fake_redis: _FakeRedis) -> None:
    import json

    now = datetime(2026, 7, 3, 10, 0, 0, tzinfo=timezone.utc)
    _run(liveness.mark_conversation_seen("conv-1", now=now))

    key = "conversation_liveness:conv-1"
    assert key in fake_redis.store
    assert fake_redis.expires[key] == liveness.LIVENESS_TTL_SECONDS
    stored = json.loads(fake_redis.store[key].decode())
    assert stored["seen"] == now.isoformat()


def test_sticky_states_use_longer_ttl(fake_redis: _FakeRedis) -> None:
    # Non-capture states (left, paused, ...) must outlive the normal TTL so the
    # monitor holds the calm state until the catch-up finishes it, rather than
    # decaying into a misleading "offline".
    now = datetime(2026, 7, 3, 10, 0, 0, tzinfo=timezone.utc)
    assert liveness.STICKY_STATE_TTL_SECONDS > liveness.LIVENESS_TTL_SECONDS
    for state in ("left", "paused"):
        _run(
            liveness.mark_conversation_seen(
                f"conv-{state}", now=now, telemetry={"state": state}
            )
        )
        assert (
            fake_redis.expires[f"conversation_liveness:conv-{state}"]
            == liveness.STICKY_STATE_TTL_SECONDS
        )
    # An active-capture state keeps the short TTL.
    _run(liveness.mark_conversation_seen("conv-rec", now=now, telemetry={"state": "recording"}))
    assert fake_redis.expires["conversation_liveness:conv-rec"] == liveness.LIVENESS_TTL_SECONDS


def test_stale_ping_does_not_clobber_newer_state(fake_redis: _FakeRedis) -> None:
    # A late in-flight ping (earlier client_ts) must not overwrite a newer
    # terminal "left"; this is the left -> offline race on tab close.
    now = datetime(2026, 7, 3, 10, 0, 0, tzinfo=timezone.utc)
    _run(
        liveness.mark_conversation_seen(
            "c1", now=now, telemetry={"state": "left", "client_ts": 2000}
        )
    )
    _run(
        liveness.mark_conversation_seen(
            "c1", now=now, telemetry={"state": "recording", "client_ts": 1000}
        )
    )
    result = _run(liveness.get_telemetry_many(["c1"]))
    assert result["c1"]["state"] == "left"


def test_newer_ping_overrides_prior_state(fake_redis: _FakeRedis) -> None:
    # A genuine later resume (newer client_ts) still wins over "left".
    now = datetime(2026, 7, 3, 10, 0, 0, tzinfo=timezone.utc)
    _run(
        liveness.mark_conversation_seen(
            "c1", now=now, telemetry={"state": "left", "client_ts": 1000}
        )
    )
    _run(
        liveness.mark_conversation_seen(
            "c1", now=now, telemetry={"state": "recording", "client_ts": 3000}
        )
    )
    result = _run(liveness.get_telemetry_many(["c1"]))
    assert result["c1"]["state"] == "recording"


def test_mark_persists_telemetry(fake_redis: _FakeRedis) -> None:
    now = datetime(2026, 7, 3, 10, 0, 0, tzinfo=timezone.utc)
    _run(
        liveness.mark_conversation_seen(
            "conv-1",
            now=now,
            telemetry={
                "state": "paused",
                "mode": "voice",
                "network": {"effective_type": "4g"},
                "battery": {"level": 0.5},
            },
        )
    )
    result = _run(liveness.get_telemetry_many(["conv-1"]))
    entry = result["conv-1"]
    assert entry["seen"] == now
    assert entry["state"] == "paused"
    assert entry["mode"] == "voice"
    assert entry["network"] == {"effective_type": "4g"}
    assert entry["battery"] == {"level": 0.5}


def test_get_telemetry_many_reads_legacy_bare_timestamp(fake_redis: _FakeRedis) -> None:
    # A value written by the pre-telemetry code is a bare ISO string.
    now = datetime(2026, 7, 3, 10, 0, 0, tzinfo=timezone.utc)
    fake_redis.store["conversation_liveness:legacy"] = now.isoformat().encode("utf-8")

    result = _run(liveness.get_telemetry_many(["legacy"]))
    assert result["legacy"]["seen"] == now
    assert "state" not in result["legacy"]

    seen = _run(liveness.get_last_seen_many(["legacy"]))
    assert seen["legacy"] == now


def test_get_last_seen_many_parses_and_skips_missing(fake_redis: _FakeRedis) -> None:
    now = datetime(2026, 7, 3, 10, 0, 0, tzinfo=timezone.utc)
    _run(liveness.mark_conversation_seen("conv-1", now=now))
    _run(liveness.mark_conversation_seen("conv-2", now=now - timedelta(seconds=30)))

    result = _run(liveness.get_last_seen_many(["conv-1", "conv-2", "conv-missing"]))

    assert set(result.keys()) == {"conv-1", "conv-2"}
    assert result["conv-1"] == now
    assert result["conv-1"].tzinfo is not None
    assert "conv-missing" not in result


def test_get_last_seen_many_empty_input_short_circuits(fake_redis: _FakeRedis) -> None:
    assert _run(liveness.get_last_seen_many([])) == {}
