"""Live portal recording sessions, one Redis sorted set per billing account.

Member is the conversation id, score the epoch of its last ping. Entries not
refreshed within ACTIVITY_WINDOW_SECONDS stop counting and are pruned on the
next write or read. Nothing here decides anything: record_presence reports
the live count and dembrane.recording_overage judges it against the cap.
Every function fails open; the meter must never disturb recording.
"""

from __future__ import annotations

import logging
from time import time
from typing import Optional

from redis.asyncio import Redis

from dembrane.redis_async import get_redis_client

logger = logging.getLogger("recording_sessions")

_KEY_PREFIX = "recording_sessions:"
_CONVERSATION_PREFIX = "recording_conversation:"
ACTIVITY_WINDOW_SECONDS = 120
SESSION_KEY_TTL_SECONDS = 600
CONVERSATION_KEY_TTL_SECONDS = 86400
NEGATIVE_MARKER = "-"
NEGATIVE_TTL_SECONDS = 600


def _now() -> float:
    return time()


def session_key(account_id: str) -> str:
    return f"{_KEY_PREFIX}{account_id}"


def conversation_key(conversation_id: str) -> str:
    return f"{_CONVERSATION_PREFIX}{conversation_id}"


async def register_conversation(account_id: str, conversation_id: str) -> None:
    """Claim a conversation for an account so later pings can be trusted."""
    if not account_id or not conversation_id:
        return
    try:
        client = await get_redis_client()
        await client.set(
            conversation_key(conversation_id), account_id, ex=CONVERSATION_KEY_TTL_SECONDS
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("recording register failed for %s/%s: %s", account_id, conversation_id, exc)


async def register_negative(conversation_id: str) -> None:
    """Remember that a conversation id does not belong here, so repeated pings
    for a forged or foreign id cost no further lookups."""
    if not conversation_id:
        return
    try:
        client = await get_redis_client()
        await client.set(
            conversation_key(conversation_id), NEGATIVE_MARKER, ex=NEGATIVE_TTL_SECONDS
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("recording negative register failed for %s: %s", conversation_id, exc)


async def account_for_conversation(conversation_id: str) -> Optional[str]:
    """The account a conversation was registered under. None on miss or error,
    NEGATIVE_MARKER when the id was checked and does not belong here."""
    if not conversation_id:
        return None
    try:
        client = await get_redis_client()
        raw = await client.get(conversation_key(conversation_id))
    except Exception as exc:  # noqa: BLE001
        logger.warning("recording lookup failed for %s: %s", conversation_id, exc)
        return None
    if raw is None:
        return None
    return raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)


def _cutoff(now: float) -> str:
    return repr(now - ACTIVITY_WINDOW_SECONDS)


async def record_presence(account_id: str, conversation_id: str) -> int:
    """Add or refresh the conversation and return the live count. 0 on error."""
    if not account_id or not conversation_id:
        return 0
    now = _now()
    try:
        client = await get_redis_client()
        key = session_key(account_id)
        pipe = client.pipeline(transaction=True)
        pipe.zremrangebyscore(key, "-inf", f"({_cutoff(now)}")
        pipe.zadd(key, {conversation_id: now})
        pipe.expire(key, SESSION_KEY_TTL_SECONDS)
        pipe.zcard(key)
        results = await pipe.execute()
        return int(results[-1])
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "recording presence failed open for %s/%s: %s", account_id, conversation_id, exc
        )
        return 0


async def refresh_if_present(account_id: str, conversation_id: str) -> None:
    """Refresh an existing entry's score. Never creates one."""
    if not account_id or not conversation_id:
        return
    try:
        client = await get_redis_client()
        key = session_key(account_id)
        await client.zadd(key, {conversation_id: _now()}, xx=True)
        await client.expire(key, SESSION_KEY_TTL_SECONDS)
    except Exception as exc:  # noqa: BLE001
        logger.warning("recording refresh failed for %s/%s: %s", account_id, conversation_id, exc)


async def close_session(account_id: str, conversation_id: str) -> None:
    if not account_id or not conversation_id:
        return
    try:
        client = await get_redis_client()
        await client.zrem(session_key(account_id), conversation_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("recording close failed for %s/%s: %s", account_id, conversation_id, exc)


async def _prune(client: Redis, key: str, now: float) -> None:
    await client.zremrangebyscore(key, "-inf", f"({_cutoff(now)}")


async def list_active(account_id: str) -> list[str]:
    if not account_id:
        return []
    try:
        client = await get_redis_client()
        key = session_key(account_id)
        await _prune(client, key, _now())
        members = await client.zrange(key, 0, -1)
    except Exception as exc:  # noqa: BLE001
        logger.warning("recording list failed for %s: %s", account_id, exc)
        return []
    return [m.decode("utf-8") if isinstance(m, (bytes, bytearray)) else str(m) for m in members]


async def count_active(account_id: str) -> int:
    if not account_id:
        return 0
    try:
        client = await get_redis_client()
        key = session_key(account_id)
        await _prune(client, key, _now())
        return int(await client.zcard(key))
    except Exception as exc:  # noqa: BLE001
        logger.warning("recording count failed for %s: %s", account_id, exc)
        return 0
