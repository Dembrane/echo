"""recording_sessions: the per-account live set behind the concurrent
portal recording meter. Exercised against a small fake async Redis; the
real MULTI pipeline is covered for real in test_recording_sessions_redis.py."""

from __future__ import annotations

import asyncio
from typing import Any, Optional

import pytest

import dembrane.recording_sessions as rs


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakePipeline:
    """Records commands, executes them in order against the fake on execute()."""

    def __init__(self, redis: "_FakeRedis") -> None:
        self._redis = redis
        self._ops: list[tuple[str, tuple]] = []

    def zremrangebyscore(self, *a):
        self._ops.append(("zremrangebyscore", a))
        return self

    def zadd(self, *a, **k):
        self._ops.append(("zadd", (a, k)))
        return self

    def expire(self, *a):
        self._ops.append(("expire", a))
        return self

    def zcard(self, *a):
        self._ops.append(("zcard", a))
        return self

    async def execute(self) -> list:
        out = []
        for name, args in self._ops:
            if name == "zadd":
                out.append(await self._redis.zadd(*args[0], **args[1]))
            else:
                out.append(await getattr(self._redis, name)(*args))
        return out

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeRedis:
    """Enough of redis.asyncio for the module: one sorted set per key."""

    def __init__(self) -> None:
        self.sets: dict[str, dict[str, float]] = {}
        self.ttls: dict[str, Any] = {}
        self.store: dict[str, bytes] = {}

    async def set(
        self, key: str, value: Any, ex: Optional[int] = None, nx: bool = False, xx: bool = False
    ) -> Optional[bool]:
        if nx and key in self.store:
            return None
        if xx and key not in self.store:
            return None
        self.store[key] = value.encode() if isinstance(value, str) else value
        self.ttls[key] = ex
        return True

    async def get(self, key: str):
        return self.store.get(key)

    def pipeline(self, transaction: bool = True) -> _FakePipeline:
        return _FakePipeline(self)

    async def zadd(self, key: str, mapping: dict[str, float], xx: bool = False) -> int:
        zset = self.sets.setdefault(key, {})
        added = 0
        for m, s in mapping.items():
            if xx and m not in zset:
                continue
            if m not in zset:
                added += 1
            zset[m] = s
        return added

    async def zrem(self, key: str, *members: str) -> int:
        zset = self.sets.get(key, {})
        return sum(1 for m in members if zset.pop(m, None) is not None)

    async def zremrangebyscore(self, key: str, lo: str, hi: str) -> int:
        zset = self.sets.get(key, {})
        cutoff = float(hi[1:]) if isinstance(hi, str) and hi.startswith("(") else float(hi)
        stale = [m for m, s in zset.items() if s < cutoff]
        for m in stale:
            del zset[m]
        return len(stale)

    async def zcard(self, key: str) -> int:
        return len(self.sets.get(key, {}))

    async def zrange(self, key: str, start: int, end: int) -> list[bytes]:
        zset = self.sets.get(key, {})
        return [m.encode() for m, _ in sorted(zset.items(), key=lambda kv: kv[1])]

    async def expire(self, key: str, ttl: int) -> bool:
        self.ttls[key] = ttl
        return True


class _RaisingRedis:
    def pipeline(self, transaction: bool = True):
        raise ConnectionError("redis down")

    def __getattr__(self, _name: str):
        async def _boom(*_a: Any, **_k: Any) -> None:
            raise ConnectionError("redis down")

        return _boom


@pytest.fixture
def fake_redis(monkeypatch) -> _FakeRedis:
    client = _FakeRedis()

    async def _get() -> _FakeRedis:
        return client

    monkeypatch.setattr(rs, "get_redis_client", _get)
    return client


@pytest.fixture
def raising_redis(monkeypatch) -> None:
    async def _get() -> _RaisingRedis:
        return _RaisingRedis()

    monkeypatch.setattr(rs, "get_redis_client", _get)


def test_key_is_namespaced() -> None:
    assert rs.session_key("acct-1") == "recording_sessions:acct-1"


def test_record_presence_returns_running_count(fake_redis) -> None:
    assert _run(rs.record_presence("a", "c1")) == 1
    assert _run(rs.record_presence("a", "c2")) == 2
    assert _run(rs.record_presence("a", "c1")) == 2  # refresh, not a new member


def test_record_presence_prunes_stale_first(fake_redis, monkeypatch) -> None:
    monkeypatch.setattr(rs, "_now", lambda: 1000.0)
    _run(rs.record_presence("a", "c1"))
    monkeypatch.setattr(rs, "_now", lambda: 1000.0 + rs.ACTIVITY_WINDOW_SECONDS + 1)
    assert _run(rs.record_presence("a", "c2")) == 1
    assert _run(rs.list_active("a")) == ["c2"]


def test_record_presence_refreshes_key_ttl(fake_redis) -> None:
    _run(rs.record_presence("a", "c1"))
    assert fake_redis.ttls[rs.session_key("a")] == rs.SESSION_KEY_TTL_SECONDS


def test_refresh_if_present_never_creates(fake_redis) -> None:
    _run(rs.refresh_if_present("a", "ghost"))
    assert _run(rs.count_active("a")) == 0
    _run(rs.record_presence("a", "c1"))
    _run(rs.refresh_if_present("a", "c1"))
    assert _run(rs.count_active("a")) == 1


def test_close_removes(fake_redis) -> None:
    _run(rs.record_presence("a", "c1"))
    _run(rs.close_session("a", "c1"))
    assert _run(rs.count_active("a")) == 0


def test_fail_open_on_redis_error(raising_redis) -> None:
    assert _run(rs.record_presence("a", "c1")) == 0
    assert _run(rs.count_active("a")) == 0
    assert _run(rs.list_active("a")) == []
    _run(rs.refresh_if_present("a", "c1"))
    _run(rs.close_session("a", "c1"))


def test_empty_ids_are_noops(fake_redis) -> None:
    assert _run(rs.record_presence("", "c1")) == 0
    assert _run(rs.record_presence("a", "")) == 0
    assert fake_redis.sets == {}


# conversation -> account mapping, written at initiate and read on every ping


def test_conversation_key_is_namespaced() -> None:
    assert rs.conversation_key("c1") == "recording_conversation:c1"


def test_register_then_lookup(fake_redis) -> None:
    _run(rs.register_conversation("a", "c1"))
    assert fake_redis.ttls[rs.conversation_key("c1")] == rs.CONVERSATION_KEY_TTL_SECONDS
    assert _run(rs.account_for_conversation("c1")) == "a"


def test_lookup_miss_is_none(fake_redis) -> None:
    assert _run(rs.account_for_conversation("nope")) is None


def test_mapping_empty_ids_are_noops(fake_redis) -> None:
    _run(rs.register_conversation("", "c1"))
    _run(rs.register_conversation("a", ""))
    assert fake_redis.store == {}
    assert _run(rs.account_for_conversation("")) is None


def test_mapping_fails_open_on_redis_error(raising_redis) -> None:
    _run(rs.register_conversation("a", "c1"))
    assert _run(rs.account_for_conversation("c1")) is None


def test_negative_marker_is_distinguishable_from_a_miss(fake_redis) -> None:
    _run(rs.register_negative("ghost"))
    assert fake_redis.ttls[rs.conversation_key("ghost")] == rs.NEGATIVE_TTL_SECONDS
    # The sentinel comes back as-is so callers can tell "absent" from "unknown".
    assert _run(rs.account_for_conversation("ghost")) == rs.NEGATIVE_MARKER
    assert _run(rs.account_for_conversation("other")) is None


def test_register_negative_empty_id_is_a_noop(fake_redis) -> None:
    _run(rs.register_negative(""))
    assert fake_redis.store == {}


def test_register_negative_fails_open_on_redis_error(raising_redis) -> None:
    _run(rs.register_negative("ghost"))


def test_register_conversation_overwrites_a_negative_marker(fake_redis) -> None:
    _run(rs.register_negative("c1"))
    _run(rs.register_conversation("a", "c1"))
    assert _run(rs.account_for_conversation("c1")) == "a"
