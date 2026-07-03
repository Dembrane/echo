"""Real-time monitor fan-out over Redis pub/sub.

The host monitor consumes an SSE stream. Rather than fixed-interval polling,
the stream waits on a per-project Redis channel and recomputes its snapshot
when a writer nudges it: a participant ping, a transcription result, or a
finish. A short timeout on the wait is the safety net, so the stream still
refreshes even if a publish is missed or pub/sub is briefly unavailable.

Publishing is always best-effort. A failure here must never break a ping, a
transcription, or a finish, so callers do not need to guard it.
"""

from __future__ import annotations

import logging

from dembrane.redis_async import get_redis_client

logger = logging.getLogger("monitor_stream")

_CHANNEL_PREFIX = "monitor:project:"


def channel_for_project(project_id: str) -> str:
    return f"{_CHANNEL_PREFIX}{project_id}"


async def publish_monitor_dirty(project_id: str) -> None:
    """Nudge any open monitor streams for this project to recompute.

    Best-effort: swallows every error (including a missing/unavailable Redis).
    """
    if not project_id:
        return
    try:
        client = await get_redis_client()
        await client.publish(channel_for_project(project_id), b"1")
    except Exception as exc:  # noqa: BLE001
        logger.warning("monitor publish failed for %s: %s", project_id, exc)
