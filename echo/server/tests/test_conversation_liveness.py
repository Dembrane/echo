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

    return asyncio.new_event_loop().run_until_complete(coro)


def test_mark_sets_key_with_ttl(fake_redis: _FakeRedis) -> None:
    now = datetime(2026, 7, 3, 10, 0, 0, tzinfo=timezone.utc)
    _run(liveness.mark_conversation_seen("conv-1", now=now))

    key = "conversation_liveness:conv-1"
    assert key in fake_redis.store
    assert fake_redis.expires[key] == liveness.LIVENESS_TTL_SECONDS
    assert fake_redis.store[key].decode() == now.isoformat()


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
