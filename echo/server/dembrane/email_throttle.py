"""Per-recipient, per-event-code email throttle with digest fallback.

When a staff member receives >5 emails of the same event code within a
trailing 24h window, subsequent emails are queued for a daily digest
instead of sent individually. In-app notifications are unaffected.

Redis data structures:
- Sorted set ``email_throttle:{event_code}:{recipient_id}`` — scores are
  Unix-epoch timestamps of recorded sends. TTL 25h (auto-cleanup).
- List ``digest_queue:{recipient_id}`` — JSON items awaiting the daily
  digest flush. TTL 48h as a safety net.
- Set ``digest_pending_recipients`` — recipient IDs with queued items,
  so the flush actor doesn't need to SCAN.

The pure decision function ``should_send_now`` is deliberately free of
I/O so it can be unit-tested without Redis.
"""

from __future__ import annotations

import json
import time
from typing import Any, Literal, Awaitable, cast
from logging import getLogger

from dembrane.settings import get_settings

logger = getLogger("dembrane.email_throttle")

THROTTLE_THRESHOLD = 5
_WINDOW_SECONDS = 60 * 60 * 24  # 24 hours
_SORTED_SET_TTL = 60 * 60 * 25  # 25 hours (auto-cleanup margin)
_DIGEST_QUEUE_TTL = 60 * 60 * 48  # 48 hours safety net
_KEY_PREFIX = "email_throttle"
_DIGEST_KEY_PREFIX = "digest_queue"
_DIGEST_RECIPIENTS_KEY = "digest_pending_recipients"


def should_send_now(
    _recipient: str,
    _event_code: str,
    history_24h: int,
) -> Literal["individual", "queue_for_digest"]:
    """Pure throttle decision — no I/O.

    ``history_24h`` is the count of emails of *this event code* sent to
    *this recipient* in the trailing 24h window, **excluding** the
    current event. Returns ``"individual"`` for the first 5
    (history 0–4), ``"queue_for_digest"`` for the 6th onward
    (history 5+).
    """
    if history_24h < THROTTLE_THRESHOLD:
        return "individual"
    return "queue_for_digest"


def _throttle_key(event_code: str, recipient_id: str) -> str:
    return f"{_KEY_PREFIX}:{event_code}:{recipient_id}"


def _digest_queue_key(recipient_id: str) -> str:
    return f"{_DIGEST_KEY_PREFIX}:{recipient_id}"


# ── Async helpers (FastAPI endpoints) ────────────────────────────────


async def record_and_check_throttle(
    recipient_id: str,
    event_code: str,
) -> Literal["individual", "queue_for_digest"]:
    """Record an email event and return the throttle decision.

    1. Prune entries older than 24h from the sorted set.
    2. Count remaining entries (= history before this event).
    3. Add the current timestamp.
    4. Return the decision.
    """
    from dembrane.redis_async import get_redis_client

    now = time.time()
    cutoff = now - _WINDOW_SECONDS
    key = _throttle_key(event_code, recipient_id)

    try:
        client = await get_redis_client()
        await client.zremrangebyscore(key, "-inf", cutoff)
        count_bytes = await client.zcard(key)
        count = int(count_bytes) if count_bytes else 0
        await client.zadd(key, {str(now): now})
        await client.expire(key, _SORTED_SET_TTL)

        decision = should_send_now(recipient_id, event_code, count)
        return decision
    except Exception:
        logger.warning("record_and_check_throttle failed, defaulting to individual", exc_info=True)
        return "individual"


async def queue_digest_item(recipient_id: str, item: dict[str, Any]) -> None:
    """Push an email payload onto the recipient's digest queue."""
    from dembrane.redis_async import get_redis_client

    try:
        client = await get_redis_client()
        payload = json.dumps(item, default=str).encode("utf-8")
        key = _digest_queue_key(recipient_id)
        await cast(Awaitable[int], client.rpush(key, payload))
        await client.expire(key, _DIGEST_QUEUE_TTL)
        await cast(
            Awaitable[int], client.sadd(_DIGEST_RECIPIENTS_KEY, recipient_id.encode("utf-8"))
        )
    except Exception:
        logger.warning("queue_digest_item failed for recipient %s", recipient_id, exc_info=True)


# ── Sync helpers (Dramatiq actors) ───────────────────────────────────


def _get_sync_redis() -> Any:
    """Sync Redis client for Dramatiq actors (DB 0, decode_responses=True)."""
    import redis as sync_redis

    settings = get_settings()
    url = settings.cache.redis_url
    ssl_params = ""
    if url.startswith("rediss://") and "?ssl_cert_reqs=" not in url:
        ssl_params = "?ssl_cert_reqs=none"
    return sync_redis.from_url(f"{url}{ssl_params}", decode_responses=True)


def flush_all_digests_sync() -> dict[str, list[dict[str, Any]]]:
    """Drain all digest queues, returning items grouped by recipient.

    Called by the daily 09:00 UTC Dramatiq actor. Each call atomically
    pops items and removes the recipient from the pending set.
    """
    client = _get_sync_redis()
    result: dict[str, list[dict[str, Any]]] = {}
    try:
        recipient_ids: set[str] = client.smembers(_DIGEST_RECIPIENTS_KEY) or set()
        for rid in recipient_ids:
            key = _digest_queue_key(rid)
            items: list[dict[str, Any]] = []
            while True:
                raw = client.lpop(key)
                if raw is None:
                    break
                try:
                    items.append(json.loads(raw))
                except (json.JSONDecodeError, TypeError):
                    logger.warning("corrupt digest item for %s, skipping", rid)
            if items:
                result[rid] = items
            client.srem(_DIGEST_RECIPIENTS_KEY, rid)
        return result
    except Exception:
        logger.warning("flush_all_digests_sync failed", exc_info=True)
        return result
    finally:
        client.close()
