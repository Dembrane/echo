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
from typing import Any, Callable
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import Request
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
    """Best effort: a lost event only means a page reloads on its next one."""
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


def sse_response(
    request: Request,
    channels: list[str],
    *,
    transform: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None,
    heartbeat_seconds: float = HEARTBEAT_SECONDS,
) -> StreamingResponse:
    """One SSE stream fed by one or more channels, closed when the client leaves.

    `transform` may rename, filter (return None) or reshape an event before it
    reaches the browser, for example to drop fields a public page must not see.
    Access must be checked before calling this: the stream itself does not."""

    async def stream() -> AsyncIterator[str]:
        yield format_sse({"type": "connected"})
        last_heartbeat = time.monotonic()
        client = await get_redis_client()
        pubsub = client.pubsub()
        try:
            await pubsub.subscribe(*channels)
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

    return StreamingResponse(stream(), media_type="text/event-stream", headers=SSE_HEADERS)
