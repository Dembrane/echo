"""Server-sent events over Redis pub/sub, for pages that follow background work.

Any process on any pod (an API request, a network or cpu worker) publishes an
event to a named channel. Each API process that holds an SSE connection
subscribes to that channel for the lifetime of the connection and forwards what
arrives. The browser keeps one connection open and never polls.

Pub/sub keeps nothing: an event published while nobody listens is gone. So every
stream opens with a `connected` event, and a client (re)loads the state it shows
when it receives one. An event is a nudge that says what changed; the saved rows
stay the truth.
"""

from __future__ import annotations

import json
import time
import logging
import weakref
from typing import Any, Callable
from contextlib import asynccontextmanager
from collections.abc import Awaitable, AsyncIterator

from fastapi import Request, HTTPException
from redis.exceptions import ConnectionError as RedisConnectionError
from fastapi.responses import StreamingResponse
from redis.asyncio.client import PubSub

from dembrane.redis_async import get_redis_client

logger = logging.getLogger("dembrane.live_events")

HEARTBEAT_SECONDS = 15.0
SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _encode(event: dict[str, Any]) -> str:
    return json.dumps(event, separators=(",", ":"), default=str)


async def publish(channel: str, event: dict[str, Any]) -> None:
    """Best effort. A lost event is not replayed and no later one is promised;
    a page catches up on its own safety read, or when its stream reconnects."""
    if not channel:
        return
    try:
        client = await get_redis_client()
        await client.publish(channel, _encode(event))
    except Exception as exc:  # noqa: BLE001
        logger.warning("live event publish failed on %s: %s", channel, exc)


def publish_sync(channel: str, event: dict[str, Any]) -> None:
    """The same, for synchronous code (a Dramatiq actor outside an event loop)."""
    if not channel:
        return
    from dembrane.coordination import _get_sync_redis_client

    try:
        client = _get_sync_redis_client()
        try:
            client.publish(channel, _encode(event))
        finally:
            client.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("live event publish failed on %s: %s", channel, exc)


@asynccontextmanager
async def subscribe(channel: str) -> AsyncIterator[PubSub]:
    client = await get_redis_client()
    pubsub = client.pubsub()
    await pubsub.subscribe(channel)
    try:
        yield pubsub
    finally:
        try:
            await pubsub.unsubscribe(channel)
        finally:
            await pubsub.aclose()


def decode_event(data: Any) -> dict[str, Any]:
    """An event as a dict. A bare payload (the older `b"1"` nudges) is an update."""
    text = data.decode("utf-8", errors="ignore") if isinstance(data, bytes) else str(data)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"type": "update"}
    return parsed if isinstance(parsed, dict) else {"type": "update"}


async def read(pubsub: PubSub, timeout_seconds: float = 1.0) -> dict[str, Any] | None:
    message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=timeout_seconds)
    if not message or message.get("data") is None:
        return None
    return decode_event(message["data"])


def format_sse(event: dict[str, Any], name: str | None = None) -> str:
    return f"event: {name or event.get('type') or 'update'}\ndata: {_encode(event)}\n\n"


class _OpenStreams:
    """Streams open in this process, in total and per caller key. The counters
    live in memory, so a cap bounds one API process, not the deployment."""

    def __init__(self) -> None:
        self.total = 0
        self.by_key: dict[str, int] = {}

    def take(self, key: str | None, max_streams: int | None, max_per_key: int | None) -> bool:
        if max_streams is not None and self.total >= max_streams:
            return False
        if key is not None and max_per_key is not None and self.by_key.get(key, 0) >= max_per_key:
            return False
        self.total += 1
        if key is not None:
            self.by_key[key] = self.by_key.get(key, 0) + 1
        return True

    def give_back(self, key: str | None) -> None:
        self.total = max(0, self.total - 1)
        if key is not None:
            left = self.by_key.get(key, 0) - 1
            if left > 0:
                self.by_key[key] = left
            else:
                self.by_key.pop(key, None)


open_streams = _OpenStreams()


async def _still_allowed(check: Callable[[], Awaitable[bool]]) -> bool:
    try:
        return bool(await check())
    except Exception as exc:  # noqa: BLE001
        # Fail closed: the browser reconnects, and the connect check decides.
        logger.warning("live event access check failed: %s", exc)
        return False


def sse_response(
    request: Request,
    channels: list[str],
    *,
    transform: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None,
    heartbeat_seconds: float = HEARTBEAT_SECONDS,
    max_streams: int | None = None,
    key: str | None = None,
    max_streams_per_key: int | None = None,
    still_allowed: Callable[[], Awaitable[bool]] | None = None,
) -> StreamingResponse:
    """One SSE stream fed by one or more channels, closed when the client leaves.

    `transform` may rename, filter (return None) or reshape an event before it
    reaches the browser, for example to drop fields a public page must not see.
    Access must be checked before calling this: the stream itself does not.

    `max_streams` caps the streams open in this process and
    `max_streams_per_key` those sharing `key`; past either the caller gets a
    429 before any Redis connection is made. `still_allowed` is asked again at
    every heartbeat, and the stream ends once it answers False."""

    streams = open_streams
    if not streams.take(key, max_streams, max_streams_per_key):
        raise HTTPException(status_code=429, detail="Too many open streams. Try again later.")
    released = False

    def release() -> None:
        nonlocal released
        if not released:
            released = True
            streams.give_back(key)

    async def stream() -> AsyncIterator[str]:
        try:
            client = await get_redis_client()
            pubsub = client.pubsub()
            try:
                # Subscribed before `connected`: a page reloads on `connected`,
                # and a write published between that reload and the
                # subscription would otherwise be lost for good.
                await pubsub.subscribe(*channels)
                yield format_sse({"type": "connected"})
                last_heartbeat = time.monotonic()
                while True:
                    if await request.is_disconnected():
                        break
                    event = await read(pubsub, timeout_seconds=1.0)
                    if event is not None:
                        shaped = transform(event) if transform else event
                        if shaped is not None:
                            yield format_sse(shaped)
                        continue
                    now = time.monotonic()
                    if now - last_heartbeat >= heartbeat_seconds:
                        # Access can be withdrawn while a stream is open.
                        if still_allowed is not None and not await _still_allowed(still_allowed):
                            break
                        yield ": keep-alive\n\n"
                        last_heartbeat = now
            except RedisConnectionError:
                # Redis dropped the subscription; the browser reconnects and reloads.
                return
            finally:
                try:
                    await pubsub.unsubscribe(*channels)
                finally:
                    await pubsub.aclose()
        finally:
            release()

    body = stream()
    # A response that is never sent never starts its body, and an unstarted
    # generator runs no `finally`: its slot comes back when it is collected.
    weakref.finalize(body, release)
    return StreamingResponse(body, media_type="text/event-stream", headers=SSE_HEADERS)
