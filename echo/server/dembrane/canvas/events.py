"""Redis nudges for canvas generation updates."""

from __future__ import annotations

import logging

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
