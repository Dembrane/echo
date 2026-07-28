"""Pre-conversation visitor sessions for the host funnel.

The host "funnel" monitor needs to see participants BEFORE a conversation row
exists: from the moment they land on the portal (QR scan), through consent,
mic check, and name entry. None of that has a conversation_id yet, so the
portal mints a client-side ``visitor_id`` (persisted in localStorage) and
beacons its funnel stage here, keyed by ``(project_id, visitor_id)``.

Storage mirrors conversation liveness: a short-TTL JSON key per visitor plus a
per-project sorted-set index so the monitor can enumerate who is currently in
the funnel. All of it is best-effort — a Redis hiccup must never break the
participant's onboarding.
"""

from __future__ import annotations

import json
from typing import Any, Optional
from datetime import datetime, timezone

from dembrane.redis_async import get_redis_client

# Visitors ping ~every 10s while onboarding. Keep the key alive across a few
# missed pings; once they leave the page it expires and the dot drops off.
VISITOR_TTL_SECONDS = 45

_VISITOR_KEY_PREFIX = "visitor:"
_VISITOR_INDEX_PREFIX = "monitor:visitors:"
_VISITOR_INDEX_TTL_SECONDS = 2100
# Cap the per-project visitor index so a public flood of unique ids can't grow it
# unbounded (which would bloat the host-side read). Well above any real crowd.
_MAX_VISITOR_INDEX_MEMBERS = 2000
# visitor_id -> conversation_id: a short bridge from initiate to the first ping
# (live conversations graduate via telemetry; a long TTL would suppress re-scans).
_LINK_KEY_PREFIX = "visitor_conversation:"
_LINK_TTL_SECONDS = 120

# Funnel stages the portal reports. Mic carries its outcome so the host can see
# a skip or a block, not just "advanced".
VALID_VISITOR_STAGES = frozenset(
    {
        "scanned",  # landed on the portal (QR)
        "terms",  # accepted / advanced past consent
        "mic_ok",  # mic check passed
        "mic_skipped",  # mic check skipped
        "mic_blocked",  # mic permission denied / blocked
        "profile",  # on the name/details step
    }
)

_TELEMETRY_FIELDS = (
    "stage",
    "name",
    "tags",
    "tags_preselected",
    "scan_count",
    "network",
    "battery",
    "device",
)


def _key(project_id: str, visitor_id: str) -> str:
    return f"{_VISITOR_KEY_PREFIX}{project_id}:{visitor_id}"


def _index_key(project_id: str) -> str:
    return f"{_VISITOR_INDEX_PREFIX}{project_id}"


def _now_iso(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()


def _parse_dt(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


async def mark_visitor_seen(
    project_id: str,
    visitor_id: str,
    *,
    now: Optional[datetime] = None,
    telemetry: Optional[dict[str, Any]] = None,
    score: Optional[float] = None,
) -> None:
    """Record a visitor funnel ping (best-effort). ``telemetry`` is caller-sanitised."""
    if not project_id or not visitor_id:
        return
    seen_iso = _now_iso(now)
    payload: dict[str, Any] = {"seen": seen_iso, "id": visitor_id}
    if telemetry:
        for field in _TELEMETRY_FIELDS:
            value = telemetry.get(field)
            if value is not None:
                payload[field] = value
    client = await get_redis_client()
    key = _key(project_id, visitor_id)

    # Accumulate a per-stage first-seen timestamp across pings, so the host can
    # see a timeline of what the participant did and when (read-modify-write;
    # cheap at a 10s ping cadence).
    stages: dict[str, str] = {}
    first_seen = seen_iso
    try:
        existing_raw = await client.get(key)
        if existing_raw:
            text = (
                existing_raw.decode("utf-8")
                if isinstance(existing_raw, (bytes, bytearray))
                else str(existing_raw)
            )
            existing = json.loads(text)
            if isinstance(existing, dict):
                if isinstance(existing.get("stages"), dict):
                    stages = existing["stages"]
                if isinstance(existing.get("first_seen"), str):
                    first_seen = existing["first_seen"]
    except Exception:  # noqa: BLE001
        pass
    current_stage = payload.get("stage")
    if isinstance(current_stage, str) and current_stage not in stages:
        stages[current_stage] = seen_iso
    payload["stages"] = stages
    payload["first_seen"] = first_seen

    stamp = score if score is not None else (now or datetime.now(timezone.utc)).timestamp()
    await client.set(key, json.dumps(payload), ex=VISITOR_TTL_SECONDS)
    index_key = _index_key(project_id)
    await client.zadd(index_key, {visitor_id: stamp})
    await client.expire(index_key, _VISITOR_INDEX_TTL_SECONDS)
    # Keep only the newest _MAX_VISITOR_INDEX_MEMBERS; drop the oldest beyond it.
    await client.zremrangebyrank(index_key, 0, -(_MAX_VISITOR_INDEX_MEMBERS + 1))


async def get_active_visitor_ids(project_id: str, *, min_score: float) -> list[str]:
    """Return visitor ids pinged since ``min_score`` (epoch seconds); prunes older."""
    try:
        client = await get_redis_client()
        key = _index_key(project_id)
        await client.zremrangebyscore(key, "-inf", f"({min_score}")
        members = await client.zrangebyscore(key, min_score, "+inf")
    except Exception:  # noqa: BLE001
        return []
    return [
        m.decode("utf-8") if isinstance(m, (bytes, bytearray)) else str(m)
        for m in members
    ]


async def link_visitor_conversation(
    visitor_id: Optional[str], conversation_id: Optional[str]
) -> None:
    """Record that a visitor initiated a conversation (best-effort)."""
    if not visitor_id or not conversation_id:
        return
    try:
        client = await get_redis_client()
        await client.set(
            f"{_LINK_KEY_PREFIX}{visitor_id}", conversation_id, ex=_LINK_TTL_SECONDS
        )
    except Exception:  # noqa: BLE001
        pass


async def get_linked_visitor_ids(visitor_ids: list[str]) -> set[str]:
    """Return the subset of visitor_ids that have graduated into a conversation."""
    if not visitor_ids:
        return set()
    try:
        client = await get_redis_client()
        values = await client.mget([f"{_LINK_KEY_PREFIX}{vid}" for vid in visitor_ids])
    except Exception:  # noqa: BLE001
        return set()
    return {
        vid
        for vid, value in zip(visitor_ids, values, strict=False)
        if value is not None
    }


async def get_visitors_many(
    project_id: str, visitor_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """Return {visitor_id: telemetry} for ids with a live session key."""
    if not visitor_ids:
        return {}
    client = await get_redis_client()
    values = await client.mget([_key(project_id, vid) for vid in visitor_ids])
    out: dict[str, dict[str, Any]] = {}
    for visitor_id, raw in zip(visitor_ids, values, strict=False):
        if raw is None:
            continue
        text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            continue
        if not isinstance(parsed, dict):
            continue
        seen = _parse_dt(parsed.get("seen"))
        if seen is None:
            continue
        parsed["seen"] = seen
        out[visitor_id] = parsed
    return out
