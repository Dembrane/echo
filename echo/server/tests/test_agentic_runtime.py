from __future__ import annotations

from typing import Any
from collections import defaultdict
from dataclasses import field, dataclass

import pytest

import dembrane.agentic_runtime as runtime


@dataclass
class _FakePubSub:
    redis: "_FakeRedis"
    channels: set[str] = field(default_factory=set)
    queue: list[dict[str, Any]] = field(default_factory=list)

    async def subscribe(self, channel: str) -> None:
        self.channels.add(channel)
        self.redis.subscribers[channel].append(self)

    async def unsubscribe(self, channel: str) -> None:
        if channel in self.channels:
            self.channels.remove(channel)
        subscribers = self.redis.subscribers[channel]
        if self in subscribers:
            subscribers.remove(self)

    async def aclose(self) -> None:
        for channel in list(self.channels):
            await self.unsubscribe(channel)

    async def get_message(
        self,
        ignore_subscribe_messages: bool = True,  # noqa: ARG002
        timeout: float = 1.0,  # noqa: ARG002
    ) -> dict[str, Any] | None:
        if not self.queue:
            return None
        return self.queue.pop(0)


class _FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}
        self.subscribers: dict[str, list[_FakePubSub]] = defaultdict(list)

    async def set(
        self,
        key: str,
        value: bytes,
        ex: int | None = None,  # noqa: ARG002
        nx: bool = False,
    ) -> bool:
        if nx and key in self.store:
            return False
        self.store[key] = value if isinstance(value, bytes) else str(value).encode("utf-8")
        return True

    async def get(self, key: str) -> bytes | None:
        return self.store.get(key)

    async def exists(self, key: str) -> int:
        return 1 if key in self.store else 0

    async def delete(self, key: str) -> int:
        return 1 if self.store.pop(key, None) is not None else 0

    async def publish(self, channel: str, data: str) -> int:
        payload = data.encode("utf-8") if isinstance(data, str) else data
        for subscriber in self.subscribers[channel]:
            subscriber.queue.append({"type": "message", "data": payload})
        return len(self.subscribers[channel])

    def pubsub(self) -> _FakePubSub:
        return _FakePubSub(redis=self)

    async def eval(self, script: str, numkeys: int, key: str, *args: Any) -> int:  # noqa: ARG002
        current = self.store.get(key)
        owner = args[0]
        if current != owner:
            return 0

        if "expire" in script:
            return 1
        if "del" in script:
            self.store.pop(key, None)
            return 1
        return 0


@pytest.mark.asyncio
async def test_turn_lease_acquire_refresh_release(monkeypatch) -> None:
    fake_redis = _FakeRedis()

    async def _fake_get_redis_client() -> _FakeRedis:
        return fake_redis

    monkeypatch.setattr(runtime, "get_redis_client", _fake_get_redis_client)

    acquired = await runtime.acquire_turn_lease("run-1", 3, "owner-a", 30)
    assert acquired is True

    owner = await runtime.get_turn_lease_owner("run-1", 3)
    assert owner == "owner-a"

    refreshed = await runtime.refresh_turn_lease("run-1", 3, "owner-a", 30)
    assert refreshed is True

    refreshed_with_wrong_owner = await runtime.refresh_turn_lease("run-1", 3, "owner-b", 30)
    assert refreshed_with_wrong_owner is False

    released_wrong_owner = await runtime.release_turn_lease("run-1", 3, "owner-b")
    assert released_wrong_owner is False

    released = await runtime.release_turn_lease("run-1", 3, "owner-a")
    assert released is True

    owner_after_release = await runtime.get_turn_lease_owner("run-1", 3)
    assert owner_after_release is None


@pytest.mark.asyncio
async def test_cancel_key_lifecycle(monkeypatch) -> None:
    fake_redis = _FakeRedis()

    async def _fake_get_redis_client() -> _FakeRedis:
        return fake_redis

    monkeypatch.setattr(runtime, "get_redis_client", _fake_get_redis_client)

    assert await runtime.is_cancel_requested("run-1", 5) is False

    await runtime.request_cancel("run-1", 5)
    assert await runtime.is_cancel_requested("run-1", 5) is True

    await runtime.clear_cancel("run-1", 5)
    assert await runtime.is_cancel_requested("run-1", 5) is False


@pytest.mark.asyncio
async def test_publish_and_subscribe_live_event(monkeypatch) -> None:
    fake_redis = _FakeRedis()

    async def _fake_get_redis_client() -> _FakeRedis:
        return fake_redis

    monkeypatch.setattr(runtime, "get_redis_client", _fake_get_redis_client)

    async with runtime.subscribe_live_events("run-abc") as pubsub:
        await runtime.publish_live_event("run-abc", '{"seq":1}')
        payload = await runtime.read_live_event(pubsub, timeout_seconds=0)

    assert payload == '{"seq":1}'
