"""Coordination locks must be atomic (SET NX EX) and self-heal.

Production Redis DB 2 held 232 coord:* keys with no TTL: the process died
between setnx and expire, so the lock lived forever and the catch-up
scheduler re-enqueued the conversation every five minutes to hit
"already in progress" until someone deleted the key by hand.
"""

from __future__ import annotations

import pytest

import dembrane.coordination as coordination


class FakeRedis:
    def __init__(self, existing: dict[str, int] | None = None):
        # key -> ttl (-1 means no expiry)
        self.store: dict[str, int] = dict(existing or {})
        self.calls: list[tuple] = []

    def set(self, key, value, nx=False, ex=None):
        self.calls.append(("set", key, value, nx, ex))
        if nx and key in self.store:
            return None
        self.store[key] = ex if ex is not None else -1
        return True

    def setnx(self, *_a, **_k):
        raise AssertionError("setnx is not atomic with expire; use set(nx=True, ex=ttl)")

    def ttl(self, key):
        self.calls.append(("ttl", key))
        if key not in self.store:
            return -2
        return self.store[key]

    def expire(self, key, ttl):
        self.calls.append(("expire", key, ttl))
        self.store[key] = ttl
        return True

    def close(self):
        pass

    def decr(self, key):
        self.counts = getattr(self, "counts", {})
        self.counts[key] = self.counts.get(key, 0) - 1
        return self.counts[key]

    def pipeline(self, transaction=True):
        assert transaction, "counter increment and expire must be one transaction"
        return FakePipeline(self)


class FakePipeline:
    def __init__(self, redis):
        self.redis = redis
        self.ops: list[tuple] = []

    def incrby(self, key, count):
        self.ops.append(("incrby", key, count))
        return self

    def expire(self, key, ttl):
        self.ops.append(("expire", key, ttl))
        return self

    def execute(self):
        results = []
        for op in self.ops:
            if op[0] == "incrby":
                self.redis.counts = getattr(self.redis, "counts", {})
                self.redis.counts[op[1]] = self.redis.counts.get(op[1], 0) + op[2]
                results.append(self.redis.counts[op[1]])
            else:
                self.redis.store[op[1]] = op[2]
                results.append(True)
        return results


LOCKS = [
    (
        coordination.mark_processing_started,
        coordination._processing_started_key,
        coordination._KEY_TTL_SECONDS,
    ),
    (
        coordination.mark_finish_in_progress,
        coordination._finish_in_progress_key,
        coordination._FINISH_LOCK_TTL_SECONDS,
    ),
    (
        coordination.mark_finalize_in_progress,
        coordination._finalize_in_progress_key,
        coordination._FINALIZE_LOCK_TTL_SECONDS,
    ),
    (
        coordination.mark_summarize_in_progress,
        coordination._summarize_in_progress_key,
        coordination._SUMMARIZE_LOCK_TTL_SECONDS,
    ),
]


@pytest.mark.parametrize("mark, key_fn, ttl", LOCKS)
def test_lock_is_acquired_atomically_with_ttl(monkeypatch, mark, key_fn, ttl):
    fake = FakeRedis()
    monkeypatch.setattr(coordination, "_get_sync_redis_client", lambda: fake)

    assert mark("c1") is True
    assert fake.store[key_fn("c1")] == ttl
    assert ("set", key_fn("c1"), "1", True, ttl) in fake.calls


@pytest.mark.parametrize("mark, key_fn, ttl", LOCKS)
def test_held_lock_is_not_reacquired(monkeypatch, mark, key_fn, ttl):
    fake = FakeRedis({key_fn("c1"): 42})
    monkeypatch.setattr(coordination, "_get_sync_redis_client", lambda: fake)

    assert mark("c1") is False
    assert fake.store[key_fn("c1")] == 42, "a live lock's TTL must not be touched"


@pytest.mark.parametrize("mark, key_fn, ttl", LOCKS)
def test_orphan_lock_without_ttl_is_given_one(monkeypatch, mark, key_fn, ttl):
    fake = FakeRedis({key_fn("c1"): -1})
    monkeypatch.setattr(coordination, "_get_sync_redis_client", lambda: fake)

    assert mark("c1") is False, "the current caller still yields; the orphan expires on its own"
    assert fake.store[key_fn("c1")] == ttl
    assert ("expire", key_fn("c1"), ttl) in fake.calls


def test_chunk_decremented_marker_is_atomic(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(coordination, "_get_sync_redis_client", lambda: fake)

    assert coordination.mark_chunk_decremented("c1", "k1") is True
    key = coordination._chunk_decremented_key("c1", "k1")
    assert fake.store[key] == coordination._CHUNK_DECREMENT_TTL_SECONDS
    assert coordination.mark_chunk_decremented("c1", "k1") is False


def test_pending_chunk_counter_increments_and_expires_atomically(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(coordination, "_get_sync_redis_client", lambda: fake)

    assert coordination.increment_pending_chunks("c1", 3) == 3
    assert coordination.increment_pending_chunks("c1", 2) == 5
    assert fake.store[coordination._pending_chunks_key("c1")] == coordination._KEY_TTL_SECONDS


def test_negative_counter_clamp_keeps_a_ttl(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(coordination, "_get_sync_redis_client", lambda: fake)

    assert coordination.decrement_pending_chunks("c1") == 0
    key = coordination._pending_chunks_key("c1")
    assert fake.store[key] == coordination._KEY_TTL_SECONDS
