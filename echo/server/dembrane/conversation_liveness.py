"""Participant liveness pings.

While a participant is recording, the portal pings the server every few
seconds. We stash the latest ping per conversation in Redis with a short TTL
so the host-facing monitor can tell a conversation is still live *before* the
next audio chunk lands (chunks can be tens of seconds apart, or gap during a
pause). This is deliberately a lightweight Redis key, not a DB write on every
ping.
"""

from __future__ import annotations

from typing import Optional
from datetime import datetime, timezone

from dembrane.redis_async import get_redis_client

# Participants ping ~every 5s. Keep the key alive long enough to ride out a
# few missed pings or a brief network gap without flapping the live state.
LIVENESS_TTL_SECONDS = 90

_LIVENESS_KEY_PREFIX = "conversation_liveness:"


def _key(conversation_id: str) -> str:
    return f"{_LIVENESS_KEY_PREFIX}{conversation_id}"


def _parse(value: str) -> Optional[datetime]:
    raw = value.strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


async def mark_conversation_seen(
    conversation_id: str, *, now: Optional[datetime] = None
) -> None:
    """Record a participant liveness ping (best-effort).

    A Redis hiccup must never interfere with the participant's recording, so
    callers should swallow exceptions from this.
    """
    stamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()
    client = await get_redis_client()
    await client.set(_key(conversation_id), stamp, ex=LIVENESS_TTL_SECONDS)


async def get_last_seen_many(
    conversation_ids: list[str],
) -> dict[str, datetime]:
    """Return {conversation_id: last_seen_utc} for ids with a live ping.

    Missing or expired keys are simply absent from the result.
    """
    if not conversation_ids:
        return {}
    client = await get_redis_client()
    values = await client.mget([_key(cid) for cid in conversation_ids])
    out: dict[str, datetime] = {}
    for conversation_id, raw in zip(conversation_ids, values, strict=False):
        if raw is None:
            continue
        text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        parsed = _parse(text)
        if parsed is not None:
            out[conversation_id] = parsed
    return out
