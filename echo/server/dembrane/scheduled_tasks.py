"""Durable, PG-backed (via Directus) future-scheduled one-shot task queue.

Why this exists (ECHO-863): the in-memory APScheduler is right for *recurring*
reconciliation (every 2-5 min). It is the wrong tool for *definite-future*
one-shot actions ("revoke this access in 24h", "generate this report at 09:00
tomorrow") — those must survive restarts, be inspectable, and be cancellable.
Dramatiq's own `delay` is broker-backed (Redis here) and its docs warn brokers
aren't databases; APScheduler's persistent jobstore stores opaque pickled jobs.
Neither gives staff a clean row to inspect/cancel/retry. A first-class Directus
collection does, and it is Postgres-durable underneath.

Lifecycle: scheduled -> processing -> completed | failed (+ cancelled = skip).

Concurrency model (deliberate, not row-locking): the scheduler is a single
process that dispatches ONE runner message per minute (coalesced), so in
practice one runner claims at a time. We do NOT use SELECT ... FOR UPDATE
SKIP LOCKED — that would mean introducing raw SQL into a backend that otherwise
talks only to Directus. Instead, every handler is idempotent (revoke =
soft-delete, report = status-guarded dispatch), so a rare double-claim is
harmless. `claimed_at` exists only so a reconciler can rescue rows stranded in
`processing` by a crashed runner.

Enqueue from async API code with `schedule_task()`. The runner lives in
tasks.py (`task_process_scheduled_tasks`) and uses the sync helpers here.
"""

from __future__ import annotations

from typing import Any, Optional
from logging import getLogger
from datetime import datetime, timezone, timedelta

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus

logger = getLogger("dembrane.scheduled_tasks")

# ── task_type registry (string values stored in the row) ────────────────────
TASK_REVOKE_STAFF_SUPPORT = "revoke_staff_support"
TASK_GENERATE_REPORT = "generate_report"

# ── status values ───────────────────────────────────────────────────────────
STATUS_SCHEDULED = "scheduled"
STATUS_PROCESSING = "processing"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"

# A row left in `processing` longer than this is presumed crashed mid-flight and
# reset to `scheduled` for another runner. Generous, so a slow-but-alive handler
# is never yanked out from under itself. Note: `failed` is terminal and is NOT
# reset here — that distinguishes a handled failure from a crash.
STALE_CLAIM_SECONDS = 15 * 60

COLLECTION = "scheduled_task"

_RUNNER_FIELDS = ["id", "task_type", "payload", "attempts", "scheduled_at", "status"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def schedule_task(
    *,
    task_type: str,
    scheduled_at: datetime,
    payload: Optional[dict[str, Any]] = None,
) -> str:
    """Enqueue a future-scheduled one-shot task. Returns the new row id.

    Call from async API code. `scheduled_at` should be timezone-aware UTC.
    """
    task_id = generate_uuid()
    now_iso = _now_iso()
    await async_directus.create_item(
        COLLECTION,
        {
            "id": task_id,
            "task_type": task_type,
            "payload": payload or {},
            "scheduled_at": scheduled_at.isoformat(),
            "status": STATUS_SCHEDULED,
            "attempts": 0,
            "created_at": now_iso,
            "updated_at": now_iso,
        },
    )
    logger.info(
        "enqueued scheduled_task %s type=%s at=%s",
        task_id,
        task_type,
        scheduled_at.isoformat(),
    )
    return task_id


async def cancel_pending_tasks(
    *,
    task_type: str,
    payload_match: dict[str, Any],
) -> int:
    """Cancel still-`scheduled` tasks of a type whose payload matches every
    key/value in `payload_match`. Returns the count cancelled.

    Used when the underlying reason disappears early (e.g. staff support access
    is revoked by hand before the 24h timer fires) so the runner doesn't act on
    a stale row later. Best-effort: filters by task_type/status in Directus,
    matches the payload in Python (JSON column, no deep filter).
    """
    rows = await async_directus.get_items(
        COLLECTION,
        {
            "query": {
                "filter": {
                    "task_type": {"_eq": task_type},
                    "status": {"_eq": STATUS_SCHEDULED},
                },
                "fields": ["id", "payload"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return 0
    cancelled = 0
    for row in rows:
        payload = row.get("payload") or {}
        if all(payload.get(k) == v for k, v in payload_match.items()):
            await async_directus.update_item(
                COLLECTION,
                str(row["id"]),
                {"status": STATUS_CANCELLED, "updated_at": _now_iso()},
            )
            cancelled += 1
    if cancelled:
        logger.info(
            "cancelled %d scheduled_task(s) type=%s match=%s",
            cancelled,
            task_type,
            payload_match,
        )
    return cancelled


def enqueue_task_sync(
    client: Any,
    *,
    task_type: str,
    scheduled_at_iso: str,
    payload: Optional[dict[str, Any]] = None,
) -> str:
    """Sync sibling of schedule_task() for use inside Dramatiq actors (the
    report reconciler). Returns the new row id. `scheduled_at_iso` is an ISO
    string (legacy report rows already store one)."""
    task_id = generate_uuid()
    now_iso = _now_iso()
    client.create_item(
        COLLECTION,
        {
            "id": task_id,
            "task_type": task_type,
            "payload": payload or {},
            "scheduled_at": scheduled_at_iso,
            "status": STATUS_SCHEDULED,
            "attempts": 0,
            "created_at": now_iso,
            "updated_at": now_iso,
        },
    )
    return task_id


# ── sync helpers for the runner (called inside a Dramatiq actor) ─────────────
# `client` is a sync DirectusClient from directus_client_context(), passed in so
# the actor owns the connection lifecycle.


def reconcile_stale_claims(client: Any, stale_seconds: int = STALE_CLAIM_SECONDS) -> int:
    """Reset rows stuck in `processing` past the stale window back to
    `scheduled`. Returns the count reset. Rescues tasks stranded by a crashed
    runner; `failed` rows are terminal and untouched."""
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=stale_seconds)).isoformat()
    rows = client.get_items(
        COLLECTION,
        {
            "query": {
                "filter": {
                    "status": {"_eq": STATUS_PROCESSING},
                    "claimed_at": {"_lt": cutoff},
                },
                "fields": ["id"],
                "limit": 100,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        return 0
    now_iso = _now_iso()
    reset = 0
    for row in rows:
        try:
            client.update_item(
                COLLECTION,
                str(row["id"]),
                {"status": STATUS_SCHEDULED, "claimed_at": None, "updated_at": now_iso},
            )
            reset += 1
        except Exception:
            logger.exception("failed to reset stale scheduled_task %s", row.get("id"))
    return reset


def claim_due_tasks(client: Any, limit: int = 50) -> list[dict]:
    """Find due rows (status=scheduled, scheduled_at<=now) and claim each by
    flipping it to `processing`. Returns the claimed rows (oldest-due first)."""
    now_iso = _now_iso()
    rows = client.get_items(
        COLLECTION,
        {
            "query": {
                "filter": {
                    "status": {"_eq": STATUS_SCHEDULED},
                    "scheduled_at": {"_lte": now_iso},
                },
                "fields": _RUNNER_FIELDS,
                "sort": ["scheduled_at"],
                "limit": limit,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        return []
    claimed: list[dict] = []
    for row in rows:
        try:
            client.update_item(
                COLLECTION,
                str(row["id"]),
                {
                    "status": STATUS_PROCESSING,
                    "claimed_at": now_iso,
                    "attempts": (row.get("attempts") or 0) + 1,
                    "updated_at": now_iso,
                },
            )
            claimed.append(row)
        except Exception:
            logger.exception("failed to claim scheduled_task %s", row.get("id"))
    return claimed


def mark_task_completed(client: Any, task_id: str) -> None:
    client.update_item(
        COLLECTION,
        str(task_id),
        {"status": STATUS_COMPLETED, "error": None, "updated_at": _now_iso()},
    )


def mark_task_failed(client: Any, task_id: str, error: str) -> None:
    client.update_item(
        COLLECTION,
        str(task_id),
        {"status": STATUS_FAILED, "error": error[:5000], "updated_at": _now_iso()},
    )
