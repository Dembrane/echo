"""Unit tests for the durable scheduled_task queue (ECHO-863).

Covers the sync runner primitives (claim / reconcile / mark), the async
enqueue + cancel helpers, and the runner's task_type dispatch routing. A small
in-memory FakeClient mimics the Directus filter operators the helpers rely on.
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch

import pytest

from dembrane import scheduled_tasks as st


def _match(row: dict, flt: dict) -> bool:
    for field, cond in flt.items():
        val = row.get(field)
        for op, expected in cond.items():
            if op == "_eq" and val != expected:
                return False
            if op == "_lte" and not (val is not None and val <= expected):
                return False
            if op == "_lt" and not (val is not None and val < expected):
                return False
            if op == "_gt" and not (val is not None and val > expected):
                return False
            if op == "_in" and val not in expected:
                return False
            if op == "_null":
                if expected and val is not None:
                    return False
                if not expected and val is None:
                    return False
            if op == "_nnull" and expected and val is None:
                return False
    return True


class FakeClient:
    """Minimal in-memory stand-in for the sync DirectusClient."""

    def __init__(self, rows: list[dict] | None = None):
        self.rows: dict[str, dict] = {str(r["id"]): dict(r) for r in (rows or [])}

    def get_items(self, collection: str, params: dict | None = None) -> list[dict]:
        q = (params or {}).get("query", {})
        out = [dict(r) for r in self.rows.values() if _match(r, q.get("filter", {}))]
        sort = q.get("sort")
        if sort:
            field = sort[0].lstrip("-")
            out.sort(key=lambda x: (x.get(field) or ""), reverse=sort[0].startswith("-"))
        limit = q.get("limit")
        if isinstance(limit, int) and limit >= 0:
            out = out[:limit]
        return out

    def update_item(self, collection: str, item_id: str, patch: dict) -> dict:
        self.rows[str(item_id)].update(patch)
        return {"data": self.rows[str(item_id)]}

    def create_item(self, collection: str, payload: dict) -> dict:
        self.rows[str(payload["id"])] = dict(payload)
        return {"data": payload}


def _iso(dt: datetime) -> str:
    return dt.isoformat()


_NOW = datetime.now(timezone.utc)
_PAST = _iso(_NOW - timedelta(minutes=5))
_FUTURE = _iso(_NOW + timedelta(hours=1))


# ── claim_due_tasks ──────────────────────────────────────────────────────────


def test_claim_due_tasks_claims_only_due_scheduled():
    client = FakeClient(
        [
            {"id": "a", "status": "scheduled", "scheduled_at": _PAST, "attempts": 0},
            {"id": "b", "status": "scheduled", "scheduled_at": _FUTURE, "attempts": 0},
            {"id": "c", "status": "processing", "scheduled_at": _PAST, "attempts": 1},
            {"id": "d", "status": "completed", "scheduled_at": _PAST, "attempts": 1},
        ]
    )
    claimed = st.claim_due_tasks(client)
    assert [r["id"] for r in claimed] == ["a"]
    # a flipped to processing + attempts bumped + claimed_at stamped
    assert client.rows["a"]["status"] == "processing"
    assert client.rows["a"]["attempts"] == 1
    assert client.rows["a"]["claimed_at"] is not None
    # others untouched
    assert client.rows["b"]["status"] == "scheduled"
    assert client.rows["c"]["status"] == "processing"
    assert client.rows["d"]["status"] == "completed"


def test_claim_due_tasks_oldest_first_and_limit():
    older = _iso(_NOW - timedelta(hours=2))
    newer = _iso(_NOW - timedelta(minutes=1))
    client = FakeClient(
        [
            {"id": "new", "status": "scheduled", "scheduled_at": newer, "attempts": 0},
            {"id": "old", "status": "scheduled", "scheduled_at": older, "attempts": 0},
        ]
    )
    claimed = st.claim_due_tasks(client, limit=1)
    assert [r["id"] for r in claimed] == ["old"]  # oldest-due first, limit honored


# ── reconcile_stale_claims ───────────────────────────────────────────────────


def test_reconcile_resets_only_stale_processing():
    stale = _iso(_NOW - timedelta(seconds=st.STALE_CLAIM_SECONDS + 60))
    fresh = _iso(_NOW - timedelta(seconds=10))
    client = FakeClient(
        [
            {"id": "p", "status": "processing", "claimed_at": stale},
            {"id": "q", "status": "processing", "claimed_at": fresh},
            {"id": "f", "status": "failed", "claimed_at": stale},
        ]
    )
    n = st.reconcile_stale_claims(client)
    assert n == 1
    assert client.rows["p"]["status"] == "scheduled"
    assert client.rows["p"]["claimed_at"] is None
    assert client.rows["q"]["status"] == "processing"  # not stale yet
    assert client.rows["f"]["status"] == "failed"  # terminal, never reset


# ── mark_* ───────────────────────────────────────────────────────────────────


def test_mark_completed_and_failed():
    client = FakeClient([{"id": "x", "status": "processing", "error": None}])
    st.mark_task_completed(client, "x")
    assert client.rows["x"]["status"] == "completed"

    client2 = FakeClient([{"id": "y", "status": "processing"}])
    st.mark_task_failed(client2, "y", "boom")
    assert client2.rows["y"]["status"] == "failed"
    assert client2.rows["y"]["error"] == "boom"


def test_mark_failed_truncates_long_error():
    client = FakeClient([{"id": "z", "status": "processing"}])
    st.mark_task_failed(client, "z", "e" * 9000)
    assert len(client.rows["z"]["error"]) == 5000


# ── async helpers (schedule_task / cancel_pending_tasks) ─────────────────────


def _async_directus_over(fake: FakeClient) -> AsyncMock:
    m = AsyncMock()
    m.get_items = AsyncMock(side_effect=lambda c, p=None: fake.get_items(c, p))
    m.create_item = AsyncMock(side_effect=lambda c, p: fake.create_item(c, p))
    m.update_item = AsyncMock(side_effect=lambda c, i, p: fake.update_item(c, i, p))
    return m


@pytest.mark.asyncio
async def test_schedule_task_writes_scheduled_row():
    fake = FakeClient()
    when = _NOW + timedelta(hours=24)
    with patch("dembrane.scheduled_tasks.async_directus", _async_directus_over(fake)):
        task_id = await st.schedule_task(
            task_type=st.TASK_REVOKE_STAFF_SUPPORT,
            scheduled_at=when,
            payload={"membership_id": "m1"},
        )
    row = fake.rows[task_id]
    assert row["status"] == "scheduled"
    assert row["task_type"] == st.TASK_REVOKE_STAFF_SUPPORT
    assert row["scheduled_at"] == when.isoformat()
    assert row["payload"] == {"membership_id": "m1"}
    assert row["attempts"] == 0


@pytest.mark.asyncio
async def test_cancel_pending_tasks_matches_payload_and_status():
    fake = FakeClient(
        [
            {"id": "t1", "task_type": st.TASK_GENERATE_REPORT, "status": "scheduled", "payload": {"report_id": 5}},
            {"id": "t2", "task_type": st.TASK_GENERATE_REPORT, "status": "scheduled", "payload": {"report_id": 5}},
            {"id": "t3", "task_type": st.TASK_GENERATE_REPORT, "status": "scheduled", "payload": {"report_id": 6}},
            {"id": "t4", "task_type": st.TASK_GENERATE_REPORT, "status": "completed", "payload": {"report_id": 5}},
        ]
    )
    with patch("dembrane.scheduled_tasks.async_directus", _async_directus_over(fake)):
        n = await st.cancel_pending_tasks(
            task_type=st.TASK_GENERATE_REPORT, payload_match={"report_id": 5}
        )
    assert n == 2
    assert fake.rows["t1"]["status"] == "cancelled"
    assert fake.rows["t2"]["status"] == "cancelled"
    assert fake.rows["t3"]["status"] == "scheduled"  # different report
    assert fake.rows["t4"]["status"] == "completed"  # already terminal


# ── dispatch routing ─────────────────────────────────────────────────────────


def test_dispatch_routes_by_task_type():
    import dembrane.tasks as T

    with (
        patch.object(T, "_run_revoke_staff_support") as revoke,
        patch.object(T, "_run_generate_report") as report,
        patch.object(T, "_run_canvas_tick") as canvas,
    ):
        T._dispatch_scheduled_task(
            {"task_type": st.TASK_REVOKE_STAFF_SUPPORT, "payload": {"a": 1}}
        )
        revoke.assert_called_once_with({"a": 1})
        report.assert_not_called()

        T._dispatch_scheduled_task(
            {"task_type": st.TASK_GENERATE_REPORT, "payload": {"b": 2}}
        )
        report.assert_called_once_with({"b": 2})

        T._dispatch_scheduled_task(
            {"task_type": st.TASK_CANVAS_TICK, "payload": {"loop_id": "l1"}}
        )
        canvas.assert_called_once_with({"loop_id": "l1"})


def test_dispatch_unknown_type_raises():
    import dembrane.tasks as T

    with pytest.raises(ValueError, match="unknown scheduled_task type"):
        T._dispatch_scheduled_task({"task_type": "nope", "payload": {}})
