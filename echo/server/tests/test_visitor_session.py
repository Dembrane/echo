from __future__ import annotations

import asyncio
from typing import Optional
from datetime import datetime, timezone

import pytest

import dembrane.visitor_session as vs


class _FakeRedis:
    """Async Redis stand-in supporting the string + sorted-set ops the
    visitor session uses (set/mget/zadd/expire/zrangebyscore/zremrangebyscore)."""

    def __init__(self) -> None:
        self.kv: dict[str, bytes] = {}
        self.zsets: dict[str, dict[str, float]] = {}

    async def set(self, key: str, value: str, ex: Optional[int] = None) -> None:  # noqa: ARG002
        self.kv[key] = value.encode("utf-8")

    async def mget(self, keys: list[str]) -> list[Optional[bytes]]:
        return [self.kv.get(k) for k in keys]

    async def zadd(self, key: str, mapping: dict[str, float]) -> None:
        self.zsets.setdefault(key, {}).update(mapping)

    async def expire(self, key: str, ttl: int) -> None:  # noqa: ARG002
        return None

    async def zremrangebyscore(self, key: str, _min, mx) -> None:
        # Only used as ("-inf", f"({cutoff}") => drop members strictly below cutoff.
        z = self.zsets.get(key, {})
        cutoff = float(str(mx).lstrip("("))
        for member in [m for m, s in z.items() if s < cutoff]:
            del z[member]

    async def zrangebyscore(self, key: str, mn, _max) -> list[str]:
        z = self.zsets.get(key, {})
        lo = float(mn)
        return sorted((m for m, s in z.items() if s >= lo), key=lambda m: z[m])


@pytest.fixture
def fake_redis(monkeypatch) -> _FakeRedis:
    client = _FakeRedis()

    async def _get_client():
        return client

    monkeypatch.setattr(vs, "get_redis_client", _get_client)
    return client


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_mark_and_read_visitor(fake_redis: _FakeRedis) -> None:
    now = datetime(2026, 7, 3, 12, 0, 0, tzinfo=timezone.utc)
    _run(
        vs.mark_visitor_seen(
            "proj-1",
            "vis-1",
            now=now,
            score=now.timestamp(),
            telemetry={
                "stage": "mic_skipped",
                "name": "Ada",
                "tags": ["Table 3"],
                "tags_preselected": True,
                "scan_count": 2,
            },
        )
    )
    result = _run(vs.get_visitors_many("proj-1", ["vis-1", "missing"]))
    assert set(result.keys()) == {"vis-1"}
    entry = result["vis-1"]
    assert entry["seen"] == now
    assert entry["stage"] == "mic_skipped"
    assert entry["name"] == "Ada"
    assert entry["tags"] == ["Table 3"]
    assert entry["scan_count"] == 2


def test_active_index_filters_and_prunes(fake_redis: _FakeRedis) -> None:
    now = datetime(2026, 7, 3, 12, 0, 0, tzinfo=timezone.utc)
    fresh = now.timestamp()
    stale = fresh - 10_000
    _run(vs.mark_visitor_seen("proj-1", "fresh", now=now, score=fresh))
    _run(vs.mark_visitor_seen("proj-1", "stale", now=now, score=stale))

    ids = _run(vs.get_active_visitor_ids("proj-1", min_score=fresh - 60))
    assert ids == ["fresh"]
    # The stale member was pruned from the index on read.
    assert "stale" not in fake_redis.zsets["monitor:visitors:proj-1"]


def test_get_active_visitor_ids_handles_redis_down(monkeypatch) -> None:
    async def _boom():
        raise RuntimeError("redis down")

    monkeypatch.setattr(vs, "get_redis_client", _boom)
    assert _run(vs.get_active_visitor_ids("p", min_score=0)) == []
