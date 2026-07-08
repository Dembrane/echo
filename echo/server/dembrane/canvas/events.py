"""Redis nudges for canvas generation updates."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from redis.asyncio.client import PubSub

from dembrane.redis_async import get_redis_client

logger = logging.getLogger("dembrane.canvas.events")


def generation_channel(report_id: str) -> str:
    return f"canvas:generation:{report_id}"


async def publish_generation_nudge(report_id: str) -> None:
    """Best-effort publish for future live canvas refresh consumers."""
    if not report_id:
        return
    try:
        client = await get_redis_client()
        await client.publish(generation_channel(report_id), b"1")
    except Exception as exc:  # noqa: BLE001
        logger.warning("canvas generation publish failed for %s: %s", report_id, exc)


@asynccontextmanager
async def subscribe_generation_nudges(report_id: str) -> AsyncIterator[PubSub]:
    client = await get_redis_client()
    channel = generation_channel(report_id)
    pubsub = client.pubsub()
    await pubsub.subscribe(channel)
    try:
        yield pubsub
    finally:
        try:
            await pubsub.unsubscribe(channel)
        finally:
            await pubsub.aclose()


async def read_generation_nudge(
    pubsub: PubSub,
    timeout_seconds: float = 1.0,
) -> str | None:
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
