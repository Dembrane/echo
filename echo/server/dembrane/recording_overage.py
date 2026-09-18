"""Overage episodes for the concurrent recording meter.

An episode is the span during which a billing account's live recording count
exceeds its cap. observe() opens one on the first count above the cap and
raises its peak on every higher count. The ticks worker closes it once the
count has stayed at or below the cap for CLOSE_QUIET_SECONDS, and posts the
two Slack messages to sam, using the episode's `*_notified_at` columns as its
outbox. Every step fails open; the meter never disturbs recording.

The peak is raised by a read-compare-write per ping, so under concurrent pings
it is a floor on the true maximum, accepted for metering.

If stamping `*_notified_at` fails after the message was posted, the next tick
posts again; sam deduplicates on the payload id, so the composite
`<episode_id>:opened` / `<episode_id>:closed:<ended_at>` ids keep the messages
distinct while making a redelivery a no-op on sam's side.

A close leaves a marker for CLOSED_MARKER_TTL_SECONDS. A count above the cap
within that window reopens the same episode instead of splitting the rush into
two rows, because the close tick reads the count before it stamps. Reopening
clears `closed_notified_at`, so if the closing message had already gone out
Slack shows a second closing for that episode; accepted for the same reason.
That second closing carries the new `ended_at` in its id, so sam sees a new
message rather than a duplicate and Slack gets the corrected peak. A reopen
between a closing post and its stamp is rejected by the stamp's filter, but
Directus resolves that filter with a separate read before the write, so the
filtered write narrows the race and does not close it. What guarantees
delivery is that closing an episode clears the closing stamp in the same
single-row update, so any stale stamp is wiped and the corrected closing goes
out.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone, timedelta

from dembrane.directus import directus_client_context
from dembrane.settings import get_settings
from dembrane.free_tier import BillingContext
from dembrane.redis_async import get_redis_client
from dembrane.sam_forward import post_to_sam, sam_environment, sam_webhook_config
from dembrane.async_helpers import run_async_in_new_loop
from dembrane.directus_async import async_directus
from dembrane.recording_sessions import count_active

logger = logging.getLogger("recording_overage")

EPISODE_COLLECTION = "recording_overage"
CLOSE_QUIET_SECONDS = 300
OPEN_KEY_TTL_SECONDS = 86400
PLACEHOLDER_TTL_SECONDS = 60
CLOSED_MARKER_TTL_SECONDS = CLOSE_QUIET_SECONDS
_OPEN_PREFIX = "recording_overage:open:"
_CLOSED_PREFIX = "recording_overage:closed:"
_TS = "%Y-%m-%d %H:%M"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse(ts: str) -> datetime:
    """Parse a Directus timestamp as UTC. Naive values are assumed UTC."""
    parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def open_key(account_id: str) -> str:
    return f"{_OPEN_PREFIX}{account_id}"


def closed_key(account_id: str) -> str:
    return f"{_CLOSED_PREFIX}{account_id}"


async def _read_json(client: Any, key: str) -> Optional[Dict[str, Any]]:
    raw = await client.get(key)
    if raw is None:
        return None
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8")
    try:
        loaded = json.loads(raw)
    except ValueError:
        return None
    return loaded if isinstance(loaded, dict) else None


async def _read_open(client: Any, account_id: str) -> Optional[Dict[str, Any]]:
    return await _read_json(client, open_key(account_id))


async def _write_closed(client: Any, account_id: str, row: Dict[str, Any], peak: int) -> None:
    """Marker that lets a ping inside the quiet window reopen this episode."""
    await client.set(
        closed_key(account_id),
        json.dumps({"episode_id": row["id"], "peak": peak, "cap": row.get("cap")}),
        ex=CLOSED_MARKER_TTL_SECONDS,
    )


async def _write_open(
    client: Any, account_id: str, state: Dict[str, Any], xx: bool = False
) -> None:
    """xx=True only refreshes an existing key, so a deleted key stays deleted."""
    await client.set(open_key(account_id), json.dumps(state), ex=OPEN_KEY_TTL_SECONDS, xx=xx)


async def _reopen(client: Any, ctx: BillingContext, marker: Dict[str, Any], count: int) -> None:
    """Revive the episode the last tick just closed, instead of opening a
    second row for the same rush."""
    episode_id = marker["episode_id"]
    marker_peak = int(marker.get("peak") or 0)
    raw_cap = marker.get("cap")
    # The row is the truth: a ping between the tick's marker write and its key
    # delete raises the row above the marker, and reopening must not lower it.
    row: Optional[Dict[str, Any]] = None
    try:
        row = await async_directus.get_item(EPISODE_COLLECTION, episode_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("overage reopen could not read episode %s: %s", episode_id, exc)
    if row is None:
        # Writing from the stale marker could lower a peak a ping already
        # stored. Defer: the placeholder expires and a later ping retries.
        logger.warning("overage reopen deferred, episode %s unreadable", episode_id)
        return
    stored_peak = int(row.get("peak") or 0)
    if row.get("cap") is not None:
        raw_cap = row.get("cap")
    cap = int(raw_cap) if raw_cap is not None else int(ctx.cap or 0)
    peak = max(stored_peak, marker_peak, count)
    changes: Dict[str, Any] = {"ended_at": None, "closed_notified_at": None}
    if peak > stored_peak:
        changes["peak"] = peak
        changes["excess"] = peak - cap
    await async_directus.update_item(EPISODE_COLLECTION, episode_id, changes)
    await _write_open(
        client,
        ctx.account_id,
        {"episode_id": episode_id, "peak": peak, "cap": cap, "below_since": None},
    )
    await client.delete(closed_key(ctx.account_id))


async def observe(ctx: BillingContext, count: int, conversation_id: str, project_id: str) -> None:
    """Record `count` against the account's cap. No-op at or below the cap."""
    if ctx.cap is None or count <= ctx.cap:
        return
    try:
        client = await get_redis_client()
        state = await _read_open(client, ctx.account_id)
        if state is None:
            placeholder = json.dumps({"episode_id": None, "peak": 0})
            # Short TTL: a worker that dies before the row write frees the claim.
            won = await client.set(
                open_key(ctx.account_id), placeholder, ex=PLACEHOLDER_TTL_SECONDS, nx=True
            )
            if not won:
                return
            marker = await _read_json(client, closed_key(ctx.account_id))
            if marker and marker.get("episode_id"):
                await _reopen(client, ctx, marker, count)
                return
            now = _utcnow()
            created = await async_directus.create_item(
                EPISODE_COLLECTION,
                {
                    "billing_account_id": ctx.account_id,
                    "started_at": now.isoformat(),
                    "cap": ctx.cap,
                    "peak": count,
                    "excess": count - ctx.cap,
                    "opened_by_project_id": project_id,
                },
            )
            row = created["data"] if isinstance(created, dict) and "data" in created else created
            await _write_open(
                client,
                ctx.account_id,
                {
                    "episode_id": row["id"],
                    "peak": count,
                    "cap": ctx.cap,
                    "below_since": None,
                },
            )
            return
        if state.get("episode_id") is None:
            # Another worker is creating the row.
            return
        changed = False
        if count > int(state.get("peak", 0)):
            # Use the cap frozen at open time so row cap and excess agree.
            cap = int(state.get("cap") or ctx.cap)
            await async_directus.update_item(
                EPISODE_COLLECTION,
                state["episode_id"],
                {"peak": count, "excess": count - cap},
            )
            state["peak"] = count
            changed = True
        if state.get("below_since") is not None:
            state["below_since"] = None
            changed = True
        if changed:
            # xx: the tick may have closed and deleted the episode meanwhile.
            await _write_open(client, ctx.account_id, state, xx=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "overage observe failed open for %s (conversation %s): %s",
            ctx.account_id,
            conversation_id,
            exc,
        )


# ticks worker side (sync)


def _rows(rows: Any, label: str) -> List[Dict[str, Any]]:
    """Directus returns an error dict instead of raising; treat it as empty."""
    if isinstance(rows, list):
        return rows
    logger.warning("overage %s query returned %r, treating as empty", label, rows)
    return []


def _open_episodes(client: Any) -> List[Dict[str, Any]]:
    rows = client.get_items(
        EPISODE_COLLECTION,
        {"query": {"filter": {"ended_at": {"_null": True}}, "fields": ["*"], "limit": -1}},
    )
    return _rows(rows, "open episodes")


async def _clear_open(client: Any, account_id: str) -> None:
    await client.delete(open_key(account_id))


def _close_one(client: Any, row: Dict[str, Any], at: datetime) -> bool:
    """Advance one open episode's quiet clock. True when it was closed."""
    raw_account_id = row.get("billing_account_id")
    if isinstance(raw_account_id, dict):
        raw_account_id = raw_account_id.get("id")
    if not raw_account_id:
        return False
    account_id = str(raw_account_id)
    count = run_async_in_new_loop(lambda: count_active(account_id))
    redis: Any = run_async_in_new_loop(get_redis_client)
    state = run_async_in_new_loop(lambda: _read_open(redis, account_id))
    if state is None:
        # Key lost to a restart or TTL. Rebuild it so observe reattaches here
        # instead of winning SET NX and opening a second row.
        state = {
            "episode_id": row["id"],
            "peak": row.get("peak", 0),
            "cap": row.get("cap"),
            "below_since": None,
        }
        run_async_in_new_loop(lambda: _write_open(redis, account_id, state))
    if count > int(row.get("cap") or 0):
        # Still over: any earlier quiet clock is void.
        if state.get("below_since") is not None:
            state["below_since"] = None
            run_async_in_new_loop(lambda: _write_open(redis, account_id, state))
        return False
    below_since = state.get("below_since")
    if below_since is None:
        state["below_since"] = at.isoformat()
        run_async_in_new_loop(lambda: _write_open(redis, account_id, state))
        return False
    if at - _parse(below_since) < timedelta(seconds=CLOSE_QUIET_SECONDS):
        return False
    # Re-read: the count may have climbed back over the cap since the first read.
    if run_async_in_new_loop(lambda: count_active(account_id)) > int(row.get("cap") or 0):
        state["below_since"] = None
        run_async_in_new_loop(lambda: _write_open(redis, account_id, state))
        return False
    # One row, one UPDATE: closing also clears any stale closing stamp, so a
    # poisoned row cannot stay invisible to the closing query.
    client.update_item(
        EPISODE_COLLECTION,
        row["id"],
        {"ended_at": at.isoformat(), "closed_notified_at": None},
    )
    # The row was read at the top of the tick; the open key is at least as fresh,
    # so a peak a ping raised meanwhile survives the reopen.
    peak = max(int(row.get("peak") or 0), int(state.get("peak") or 0))
    try:
        # Before clearing the open key: a ping landing between the two round
        # trips finds the marker and reopens instead of opening a second row.
        run_async_in_new_loop(lambda: _write_closed(redis, account_id, row, peak))
    except Exception as exc:  # noqa: BLE001
        # Fail open: without the marker the next ping opens a fresh episode.
        logger.warning("overage closed marker failed for episode %s: %s", row.get("id"), exc)
    run_async_in_new_loop(lambda: _clear_open(redis, account_id))
    return True


def close_finished_episodes(now: Optional[datetime] = None) -> int:
    """Close episodes whose count has stayed at or below the cap for
    CLOSE_QUIET_SECONDS. Returns the number closed."""
    at = now or _utcnow()
    closed = 0
    with directus_client_context() as client:
        for row in _open_episodes(client):
            try:
                if _close_one(client, row, at):
                    closed += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("overage close failed for episode %s: %s", row.get("id"), exc)
    return closed


def _account_name(account: Dict[str, Any], account_id: str) -> str:
    return (account.get("label") or "").strip() or account_id


def _fmt(ts: str) -> str:
    return _parse(ts).astimezone(timezone.utc).strftime(_TS)


def format_opening_message(episode: Dict[str, Any], account: Dict[str, Any]) -> str:
    account_id = str(episode["billing_account_id"])
    return (
        f"Concurrent recording cap exceeded. Account {_account_name(account, account_id)} on "
        f"{account.get('tier') or 'unknown tier'} has {episode['peak']} recordings, cap {episode['cap']}. "
        f"Since {_fmt(episode['started_at'])} UTC."
    )


def format_closing_message(episode: Dict[str, Any], account: Dict[str, Any]) -> str:
    account_id = str(episode["billing_account_id"])
    return (
        f"Cap episode ended. Account {_account_name(account, account_id)} on {account.get('tier') or 'unknown tier'} "
        f"peaked at {episode['peak']} recordings, cap {episode['cap']}, {episode['excess']} over, "
        f"from {_fmt(episode['started_at'])} to {_fmt(episode['ended_at'])} UTC."
    )


def _notification_id(episode: Dict[str, Any], suffix: str) -> str:
    """One episode sends two messages and sam deduplicates on id, so the id is
    composite. The closing id also carries `ended_at`: a reopen replaces that
    timestamp, so a corrected closing is new to sam, while a retry of the same
    closure repeats the identical id."""
    if suffix != "closed":
        return f"{episode['id']}:{suffix}"
    ended_at = episode.get("ended_at")
    if not ended_at:
        return f"{episode['id']}:closed"
    try:
        stamp = _parse(str(ended_at)).astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S")
    except ValueError:
        return f"{episode['id']}:closed"
    return f"{episode['id']}:closed:{stamp}"


def _payload(
    episode: Dict[str, Any], account: Dict[str, Any], suffix: str, message: str
) -> Dict[str, Any]:
    """One sam payload."""
    payload: Dict[str, Any] = {
        "id": _notification_id(episode, suffix),
        "environment": sam_environment(),
        "message": message,
    }
    workspace_id = account.get("workspace_id")
    project_id = episode.get("opened_by_project_id")
    if workspace_id:
        payload["workspace_id"] = str(workspace_id)
    if project_id:
        payload["project_id"] = str(project_id)
    if workspace_id and project_id:
        admin_base_url = (get_settings().urls.admin_base_url or "").rstrip("/")
        if admin_base_url:
            payload["origin_link"] = (
                f"{admin_base_url}/en-US/w/{workspace_id}/projects/{project_id}"
            )
    return payload


def _stamp_closure(client: Any, episode_id: Any, announced_ended_at: Any, at: datetime) -> bool:
    """A reopen between the post and the stamp clears `ended_at`. Stamping then
    would hide the row from the closing query, so the write is filtered: stamp
    only while `ended_at` is still the announced value and the stamp is still
    null. Directus resolves the filter with a read before the update, so this
    narrows the race rather than removing it; `_close_one` clears the stamp on
    every close to correct what slips through. An empty result means
    superseded."""
    result = client.patch(
        f"/items/{EPISODE_COLLECTION}",
        json={
            "query": {
                "filter": {
                    "id": {"_eq": str(episode_id)},
                    "ended_at": {"_eq": announced_ended_at},
                    "closed_notified_at": {"_null": True},
                }
            },
            "data": {"closed_notified_at": at.isoformat()},
        },
    )
    if (result or {}).get("data"):
        return True
    logger.info(
        "overage closing superseded for episode %s, stamp skipped; the next "
        "closure announces the corrected figures",
        episode_id,
    )
    return False


def file_pending_notifications(now: Optional[datetime] = None) -> int:
    """Post the opening and closing Slack messages for episodes that have not
    announced them yet. Stamps the episode so each fires once."""
    at = now or _utcnow()
    filed = 0
    if sam_webhook_config() is None:
        return filed
    with directus_client_context() as client:
        opening = client.get_items(
            EPISODE_COLLECTION,
            {
                "query": {
                    "filter": {"opened_notified_at": {"_null": True}},
                    "fields": ["*"],
                    "limit": 50,
                }
            },
        )
        closing = client.get_items(
            EPISODE_COLLECTION,
            {
                "query": {
                    "filter": {
                        "ended_at": {"_nnull": True},
                        "closed_notified_at": {"_null": True},
                    },
                    "fields": ["*"],
                    "limit": 50,
                }
            },
        )
        for rows, label, fmt, stamp, suffix in (
            (
                opening,
                "opening notifications",
                format_opening_message,
                "opened_notified_at",
                "opened",
            ),
            (
                closing,
                "closing notifications",
                format_closing_message,
                "closed_notified_at",
                "closed",
            ),
        ):
            for row in _rows(rows, label):
                try:
                    account_id = row["billing_account_id"]
                    if isinstance(account_id, dict):
                        account_id = account_id["id"]
                    account = client.get_item("billing_account", str(account_id)) or {}
                    episode = {**row, "billing_account_id": account_id}
                    outcome = post_to_sam(
                        _payload(episode, account, suffix, fmt(episode, account)), logger
                    )
                    if outcome == "retry":
                        # Receiver is down: stop, the next tick resumes.
                        return filed
                    if outcome == "rejected":
                        continue
                    if stamp == "closed_notified_at":
                        if _stamp_closure(client, row["id"], episode.get("ended_at"), at):
                            filed += 1
                        continue
                    client.update_item(EPISODE_COLLECTION, row["id"], {stamp: at.isoformat()})
                    filed += 1
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "overage notification failed for episode %s: %s", row.get("id"), exc
                    )
    return filed
