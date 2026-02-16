from __future__ import annotations

from typing import Any, Optional, Awaitable, AsyncIterator, cast
from contextlib import asynccontextmanager

from redis.asyncio.client import PubSub

from dembrane.redis_async import get_redis_client

_LEASE_KEY_PREFIX = "agentic:run"
_EVENT_CHANNEL_PREFIX = "agentic:run"
_DEFAULT_CANCEL_TTL_SECONDS = 15 * 60

_REFRESH_LEASE_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("expire", KEYS[1], ARGV[2])
else
    return 0
end
"""

_RELEASE_LEASE_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""


def turn_lease_key(run_id: str, turn_seq: int) -> str:
    return f"{_LEASE_KEY_PREFIX}:{run_id}:turn:{turn_seq}:lease"


def turn_cancel_key(run_id: str, turn_seq: int) -> str:
    return f"{_LEASE_KEY_PREFIX}:{run_id}:turn:{turn_seq}:cancel"


def live_event_channel(run_id: str) -> str:
    return f"{_EVENT_CHANNEL_PREFIX}:{run_id}:events"


def _as_bytes(value: str) -> bytes:
    return value.encode("utf-8")


async def acquire_turn_lease(run_id: str, turn_seq: int, owner: str, ttl_seconds: int) -> bool:
    client = await get_redis_client()
    return bool(
        await client.set(
            turn_lease_key(run_id, turn_seq),
            _as_bytes(owner),
            ex=max(1, int(ttl_seconds)),
            nx=True,
        )
    )


async def refresh_turn_lease(run_id: str, turn_seq: int, owner: str, ttl_seconds: int) -> bool:
    client = await get_redis_client()
    raw_result = cast(Any, client).eval(
        _REFRESH_LEASE_SCRIPT,
        1,
        turn_lease_key(run_id, turn_seq),
        _as_bytes(owner),
        max(1, int(ttl_seconds)),
    )
    result = await cast(Awaitable[Any], raw_result)
    return bool(result)


async def release_turn_lease(run_id: str, turn_seq: int, owner: str) -> bool:
    client = await get_redis_client()
    raw_result = cast(Any, client).eval(
        _RELEASE_LEASE_SCRIPT,
        1,
        turn_lease_key(run_id, turn_seq),
        _as_bytes(owner),
    )
    result = await cast(Awaitable[Any], raw_result)
    return bool(result)


async def get_turn_lease_owner(run_id: str, turn_seq: int) -> Optional[str]:
    client = await get_redis_client()
    value = await client.get(turn_lease_key(run_id, turn_seq))
    if value is None:
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="ignore")
    return str(value)


async def publish_live_event(run_id: str, event_json: str) -> None:
    client = await get_redis_client()
    await client.publish(live_event_channel(run_id), event_json)


@asynccontextmanager
async def subscribe_live_events(run_id: str) -> AsyncIterator[PubSub]:
    client = await get_redis_client()
    channel = live_event_channel(run_id)
    pubsub = client.pubsub()
    await pubsub.subscribe(channel)
    try:
        yield pubsub
    finally:
        try:
            await pubsub.unsubscribe(channel)
        finally:
            await pubsub.aclose()


async def read_live_event(pubsub: PubSub, timeout_seconds: float = 1.0) -> Optional[str]:
    message = await pubsub.get_message(
        ignore_subscribe_messages=True,
        timeout=timeout_seconds,
    )
    if not message:
        return None

    data = message.get("data")
    if data is None:
        return None
    if isinstance(data, bytes):
        return data.decode("utf-8", errors="ignore")
    return str(data)


async def request_cancel(
    run_id: str,
    turn_seq: int,
    ttl_seconds: int = _DEFAULT_CANCEL_TTL_SECONDS,
) -> None:
    client = await get_redis_client()
    await client.set(
        turn_cancel_key(run_id, turn_seq),
        b"1",
        ex=max(1, int(ttl_seconds)),
    )


async def is_cancel_requested(run_id: str, turn_seq: int) -> bool:
    client = await get_redis_client()
    return bool(await client.exists(turn_cancel_key(run_id, turn_seq)))


async def clear_cancel(run_id: str, turn_seq: int) -> None:
    client = await get_redis_client()
    await client.delete(turn_cancel_key(run_id, turn_seq))
