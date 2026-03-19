"""
Redis pub/sub helpers for real-time report generation progress.

Follows the pattern from agentic_runtime.py (publish_live_event / subscribe_live_events / read_live_event).

- publish_report_progress: sync, for use in Dramatiq workers
- subscribe_report_events: async context manager, for use in FastAPI SSE endpoints
- read_report_event: async, reads a single event from pub/sub
"""

import json
from typing import Optional
from logging import getLogger
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from redis.asyncio.client import PubSub

logger = getLogger("dembrane.report_events")


def _channel(report_id: int) -> str:
    return f"report:{report_id}:progress"


def publish_report_progress(
    report_id: int,
    event_type: str,
    message: str,
    detail: Optional[dict] = None,
) -> None:
    """
    Publish a progress event for a report (sync, for Dramatiq workers).
    Uses _get_sync_redis_client from coordination.py.
    """
    from dembrane.coordination import _get_sync_redis_client

    payload = json.dumps({
        "type": event_type,
        "message": message,
        "detail": detail,
    })
    client = _get_sync_redis_client()
    try:
        client.publish(_channel(report_id), payload)
    finally:
        client.close()


@asynccontextmanager
async def subscribe_report_events(report_id: int) -> AsyncIterator[PubSub]:
    """
    Async context manager to subscribe to report progress events.
    Uses get_redis_client from redis_async.py (for FastAPI context).
    """
    from dembrane.redis_async import get_redis_client

    client = await get_redis_client()
    channel = _channel(report_id)
    pubsub = client.pubsub()
    await pubsub.subscribe(channel)
    try:
        yield pubsub
    finally:
        try:
            await pubsub.unsubscribe(channel)
        finally:
            await pubsub.aclose()


async def read_report_event(pubsub: PubSub, timeout_seconds: float = 1.0) -> Optional[str]:
    """
    Read a single event from the pub/sub channel.
    Returns decoded JSON string or None on timeout.
    """
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
