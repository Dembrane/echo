"""Participant liveness + telemetry pings.

While a participant is in a conversation, the portal pings the server every
few seconds. We stash the latest ping per conversation in Redis with a short
TTL so the host-facing monitor can tell what the participant is doing *before*
the next audio chunk lands (chunks can be tens of seconds apart, or gap during
a pause). This is deliberately a lightweight Redis key, not a DB write on
every ping.

The ping now carries lightweight telemetry (lifecycle state, capture mode,
screen, and best-effort network/battery). All of it is optional and
best-effort: older portals (and browsers without the Network/Battery APIs)
simply omit fields, and the value degrades to a bare "last seen" timestamp.
"""

from __future__ import annotations

import json
from typing import Any, Optional
from datetime import datetime, timezone

from dembrane.redis_async import get_redis_client

# Participants ping ~every 5s. Keep the key alive long enough to ride out a
# few missed pings or a brief network gap without flapping the live state.
LIVENESS_TTL_SECONDS = 90

_LIVENESS_KEY_PREFIX = "conversation_liveness:"

# Lifecycle states the portal may report. The monitor renders unknown values
# as a neutral "active", so this is a soft allowlist for sanitising input from
# the public (unauthenticated) ping endpoint, not a hard contract.
VALID_PARTICIPANT_STATES = frozenset(
    {
        "initiated",  # conversation created, recording not started yet
        "waiting",  # on the recording screen, no chunk yet
        "recording",
        "paused",
        "verifying",  # on the verify flow
        "refining",  # on the "go deeper" / echo hub
        "finishing",  # finish request in flight
        "finished",
        "text",  # text-mode capture
        "backgrounded",  # tab hidden / phone locked (mic suspended)
    }
)

# Telemetry fields we persist beyond "seen". Everything is optional.
# `audio_level` is the participant's live mic input level (0..1 RMS) — proof
# that audio is actually flowing, and a way to spot a silent/muted mic.
_TELEMETRY_FIELDS = ("state", "mode", "screen", "network", "battery", "audio_level")


def _key(conversation_id: str) -> str:
    return f"{_LIVENESS_KEY_PREFIX}{conversation_id}"


def _parse_dt(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
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


def _now_iso(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()


def _parse_value(text: str) -> Optional[dict[str, Any]]:
    """Parse a stored liveness value into a telemetry dict with a `seen` datetime.

    Handles both the new JSON payload and the legacy bare-ISO-timestamp value.
    """
    raw = text.strip()
    if not raw:
        return None
    if raw.startswith("{"):
        try:
            obj = json.loads(raw)
        except (ValueError, TypeError):
            return None
        if not isinstance(obj, dict):
            return None
        seen = _parse_dt(obj.get("seen"))
        if seen is None:
            return None
        obj["seen"] = seen
        return obj
    # Legacy format: the value was just an ISO timestamp.
    seen = _parse_dt(raw)
    if seen is None:
        return None
    return {"seen": seen}


async def mark_conversation_seen(
    conversation_id: str,
    *,
    now: Optional[datetime] = None,
    telemetry: Optional[dict[str, Any]] = None,
) -> None:
    """Record a participant liveness ping with optional telemetry (best-effort).

    A Redis hiccup must never interfere with the participant's recording, so
    callers should swallow exceptions from this. `telemetry` should already be
    sanitised by the caller (the public ping endpoint validates it).
    """
    payload: dict[str, Any] = {"seen": _now_iso(now)}
    if telemetry:
        for field in _TELEMETRY_FIELDS:
            value = telemetry.get(field)
            if value is not None:
                payload[field] = value
    client = await get_redis_client()
    await client.set(_key(conversation_id), json.dumps(payload), ex=LIVENESS_TTL_SECONDS)


async def get_telemetry_many(
    conversation_ids: list[str],
) -> dict[str, dict[str, Any]]:
    """Return {conversation_id: telemetry} for ids with a live ping.

    Each telemetry dict has a `seen` datetime (UTC) plus any reported fields
    (state, mode, screen, network, battery). Missing/expired keys are absent.
    """
    if not conversation_ids:
        return {}
    client = await get_redis_client()
    values = await client.mget([_key(cid) for cid in conversation_ids])
    out: dict[str, dict[str, Any]] = {}
    for conversation_id, raw in zip(conversation_ids, values, strict=False):
        if raw is None:
            continue
        text = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else str(raw)
        parsed = _parse_value(text)
        if parsed is not None:
            out[conversation_id] = parsed
    return out


async def get_last_seen_many(
    conversation_ids: list[str],
) -> dict[str, datetime]:
    """Return {conversation_id: last_seen_utc} for ids with a live ping.

    Thin compatibility wrapper over :func:`get_telemetry_many`.
    """
    telemetry = await get_telemetry_many(conversation_ids)
    return {
        conversation_id: value["seen"]
        for conversation_id, value in telemetry.items()
        if isinstance(value.get("seen"), datetime)
    }
