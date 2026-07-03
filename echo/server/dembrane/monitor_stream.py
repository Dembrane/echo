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
# Per-project sorted set of recently-active conversation ids, scored by the
# epoch of their last ping. This is how a just-initiated conversation (which
# is pinging but has no audio chunk yet) becomes visible in the monitor
# instantly, instead of only appearing once its first chunk lands.
_ACTIVE_PREFIX = "monitor:active:"
# Keep the index a little longer than the monitor lookback so a brief gap
# doesn't drop a session; stale members are pruned on read anyway.
_ACTIVE_TTL_SECONDS = 2100


def channel_for_project(project_id: str) -> str:
    return f"{_CHANNEL_PREFIX}{project_id}"


def _active_key(project_id: str) -> str:
    return f"{_ACTIVE_PREFIX}{project_id}"


async def register_active_conversation(
    project_id: str, conversation_id: str, *, score: float
) -> None:
    """Record that a conversation is active (pinged) in its project's index.

    `score` is epoch seconds of the ping. Best-effort. Refreshes the key TTL so
    the index self-cleans once a project goes quiet.
    """
    if not project_id or not conversation_id:
        return
    try:
        client = await get_redis_client()
        key = _active_key(project_id)
        await client.zadd(key, {conversation_id: score})
        await client.expire(key, _ACTIVE_TTL_SECONDS)
    except Exception as exc:  # noqa: BLE001
        logger.warning("monitor active-index add failed for %s: %s", project_id, exc)


async def get_active_conversation_ids(
    project_id: str, *, min_score: float
) -> list[str]:
    """Return conversation ids pinged since `min_score` (epoch seconds).

    Prunes members older than the cutoff on the way, so the index stays small.
    Best-effort: returns [] if Redis is unavailable.
    """
    try:
        client = await get_redis_client()
        key = _active_key(project_id)
        await client.zremrangebyscore(key, "-inf", f"({min_score}")
        members = await client.zrangebyscore(key, min_score, "+inf")
    except Exception as exc:  # noqa: BLE001
        logger.warning("monitor active-index read failed for %s: %s", project_id, exc)
        return []
    return [
        m.decode("utf-8") if isinstance(m, (bytes, bytearray)) else str(m)
        for m in members
    ]


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
