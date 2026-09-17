"""recording_overage: opens an episode row on the first count above the cap,
raises its peak, closes after CLOSE_QUIET_SECONDS under the cap, and posts
the two Slack messages to sam off the episode's own stamp columns."""

from __future__ import annotations

import json
import asyncio
from types import SimpleNamespace
from typing import Any
from datetime import datetime, timezone, timedelta

import pytest

import dembrane.recording_overage as ro
from dembrane.free_tier import BillingContext

CTX = BillingContext(account_id="b1", account_name="Acme", tier="free", cap=10, workspace_id="w1")
T0 = datetime(2026, 9, 17, 14, 2, tzinfo=timezone.utc)


def _run(coro: Any) -> Any:
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, bytes] = {}
        self.ttls: dict[str, Any] = {}
        # One-shot: the next SET NX loses, as if another worker got there first.
        self.lose_next_nx = False

    async def set(self, key, value, ex=None, nx=False, xx=False):
        if nx and self.lose_next_nx:
            self.lose_next_nx = False
            return None
        if nx and key in self.store:
            return None
        if xx and key not in self.store:
            return None
        self.store[key] = value.encode() if isinstance(value, str) else value
        self.ttls[key] = ex
        return True

    async def get(self, key):
        return self.store.get(key)

    async def delete(self, *keys):
        deleted = sum(1 for k in keys if self.store.pop(k, None) is not None)
        for k in keys:
            self.ttls.pop(k, None)
        return deleted


def _same_value(stored: Any, wanted: Any) -> bool:
    """Directus compares timestamps as instants, not strings."""
    if stored is None or wanted is None:
        return stored is wanted
    try:
        return ro._parse(str(stored)) == ro._parse(str(wanted))
    except ValueError:
        return str(stored) == str(wanted)


def _matches(row: dict, f: dict) -> bool:
    for field, cond in f.items():
        value = row.get(field)
        if "_null" in cond and (value is None) is not bool(cond["_null"]):
            return False
        if "_nnull" in cond and (value is not None) is not bool(cond["_nnull"]):
            return False
        if "_eq" in cond and not _same_value(value, cond["_eq"]):
            return False
    return True


class _FakeDirectus:
    """Minimal async + sync stand-in: rows in memory, ids assigned on create."""

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.accounts = {"b1": {"id": "b1", "label": "Acme", "tier": "free", "workspace_id": "w1"}}
        self.n = 0
        # One-shot hooks around the two halves of a filtered PATCH. Before the
        # filter resolves: the window the filter really does reject. After it
        # resolves: the real race, which the filter cannot reject.
        self.before_patch_filter: Any = None
        self.after_patch_filter: Any = None

    # async surface (observe)
    async def create_item(self, collection, data):
        return {"data": self._create(collection, data)}

    async def update_item(self, collection, item_id, data):
        self.rows[item_id].update(data)
        return {"data": self.rows[item_id]}

    async def get_item(self, collection, item_id):
        if collection == ro.EPISODE_COLLECTION:
            return self.rows.get(item_id)
        raise AssertionError(collection)

    # sync surface (tick)
    def get_items(self, collection, query):
        """Models only the two queries the module issues, the closing scan
        and the open-episode scan. Null semantics are hardcoded per field
        rather than read from the operator, so it is not a general filter."""
        if collection == ro.EPISODE_COLLECTION:
            f = query["query"]["filter"]
            out = list(self.rows.values())
            if "ended_at" in f and f["ended_at"].get("_null"):
                out = [r for r in out if r.get("ended_at") is None]
            if "ended_at" in f and f["ended_at"].get("_nnull"):
                out = [r for r in out if r.get("ended_at") is not None]
            if "opened_notified_at" in f:
                out = [r for r in out if r.get("opened_notified_at") is None]
            if "closed_notified_at" in f:
                out = [r for r in out if r.get("closed_notified_at") is None]
            return out
        raise AssertionError(collection)

    def get_item_sync(self, collection, item_id):
        if collection == "billing_account":
            return self.accounts[item_id]
        if collection == ro.EPISODE_COLLECTION:
            return self.rows.get(item_id)
        raise AssertionError(collection)

    def create_item_sync(self, collection, data):
        return {"data": self._create(collection, data)}

    def update_item_sync(self, collection, item_id, data):
        self.rows[item_id].update(data)
        return {"data": self.rows[item_id]}

    def patch_items(self, collection, body):
        """Directus "update multiple items": select-then-update. The filter is
        resolved to primary keys by a separate unlocked read, then the data is
        applied to those keys unconditionally. A write landing between the two
        is not rejected."""
        if collection != ro.EPISODE_COLLECTION:
            raise AssertionError(collection)
        f = body["query"]["filter"]
        data = body["data"]
        self._fire("before_patch_filter")
        keys = [row["id"] for row in self.rows.values() if _matches(row, f)]
        self._fire("after_patch_filter")
        updated = []
        for key in keys:
            row = self.rows.get(key)
            if row is None:
                continue
            row.update(data)
            updated.append(row)
        return {"data": updated}

    def _fire(self, name):
        """Fire a one-shot hook, clearing it first so it cannot re-enter."""
        hook = getattr(self, name)
        if hook is not None:
            setattr(self, name, None)
            hook()

    def _create(self, collection, data):
        self.n += 1
        row = {
            "id": f"ep-{self.n}",
            "ended_at": None,
            "opened_notified_at": None,
            "closed_notified_at": None,
            **data,
        }
        self.rows[row["id"]] = row
        return row


class _SyncClient:
    """What directus_client_context yields, routed to the fake."""

    def __init__(self, dx: _FakeDirectus) -> None:
        self.dx = dx

    def get_items(self, c, q):
        return self.dx.get_items(c, q)

    def get_item(self, c, i):
        return self.dx.get_item_sync(c, i)

    def create_item(self, c, d):
        return self.dx.create_item_sync(c, d)

    def update_item(self, c, i, d):
        return self.dx.update_item_sync(c, i, d)

    def patch(self, path, json):
        assert path.startswith("/items/")
        return self.dx.patch_items(path[len("/items/") :], json)


@pytest.fixture
def world(monkeypatch):
    redis = _FakeRedis()
    dx = _FakeDirectus()
    live = {"count": 0}

    async def get_client():
        return redis

    monkeypatch.setattr(ro, "get_redis_client", get_client)
    monkeypatch.setattr(ro, "async_directus", dx)

    from contextlib import contextmanager

    @contextmanager
    def ctx_mgr():
        yield _SyncClient(dx)

    monkeypatch.setattr(ro, "directus_client_context", ctx_mgr)

    async def count_active(_account: str) -> int:
        return live["count"]

    monkeypatch.setattr(ro, "count_active", count_active)
    monkeypatch.setattr(ro, "run_async_in_new_loop", lambda fn: _run(fn()))
    monkeypatch.setattr(ro, "_utcnow", lambda: T0)

    posted: list[dict] = []
    outcomes: list[str] = []
    delivered_ids: list[str] = []
    duplicates: list[dict] = []

    def post_to_sam(payload, _log):
        # Models sam's receiver-side dedup: a repeated id is accepted over the
        # wire and silently dropped, so only a new id reaches Slack.
        posted.append(payload)
        outcome = outcomes.pop(0) if outcomes else "delivered"
        if outcome == "delivered":
            if payload["id"] in delivered_ids:
                duplicates.append(payload)
            else:
                delivered_ids.append(payload["id"])
        return outcome

    monkeypatch.setattr(ro, "post_to_sam", post_to_sam)
    monkeypatch.setattr(ro, "sam_webhook_config", lambda: ("https://sam.example/hook", "tok"))
    monkeypatch.setattr(ro, "sam_environment", lambda: "echo-next")
    monkeypatch.setattr(
        ro,
        "get_settings",
        lambda: SimpleNamespace(
            urls=SimpleNamespace(admin_base_url="https://dashboard.echo-next.dembrane.com")
        ),
    )
    return {
        "redis": redis,
        "dx": dx,
        "live": live,
        "posted": posted,
        "outcomes": outcomes,
        "delivered_ids": delivered_ids,
        "duplicates": duplicates,
        "unset_webhook": lambda: monkeypatch.setattr(ro, "sam_webhook_config", lambda: None),
        "set_now": lambda t: monkeypatch.setattr(ro, "_utcnow", lambda: t),
    }


# observe


def test_under_or_at_cap_writes_nothing(world) -> None:
    _run(ro.observe(CTX, 10, "c1", "p1"))
    assert world["dx"].rows == {} and world["redis"].store == {}


def test_no_cap_writes_nothing(world) -> None:
    _run(ro.observe(BillingContext(**{**CTX.__dict__, "cap": None}), 500, "c1", "p1"))
    assert world["dx"].rows == {}


def test_first_excess_opens_episode(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    (row,) = world["dx"].rows.values()
    assert row["billing_account_id"] == "b1"
    assert row["cap"] == 10 and row["peak"] == 11 and row["excess"] == 1
    assert row["opened_by_project_id"] == "p1"
    assert row["started_at"] == T0.isoformat()
    state = json.loads(world["redis"].store[ro.open_key("b1")])
    assert state["episode_id"] == row["id"] and state["peak"] == 11


def test_higher_count_raises_peak_lower_count_does_not(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    _run(ro.observe(CTX, 15, "c2", "p1"))
    _run(ro.observe(CTX, 12, "c3", "p1"))
    (row,) = world["dx"].rows.values()
    assert row["peak"] == 15 and row["excess"] == 5
    assert json.loads(world["redis"].store[ro.open_key("b1")])["peak"] == 15


def test_lost_race_writes_no_second_row(world) -> None:
    # Placeholder already held by another worker.
    _run(
        world["redis"].set(ro.open_key("b1"), json.dumps({"episode_id": None, "peak": 0}), nx=True)
    )
    _run(ro.observe(CTX, 11, "c1", "p1"))
    assert world["dx"].rows == {}


def test_observe_swallows_failures(world, monkeypatch) -> None:
    async def boom(*a, **k):
        raise RuntimeError("down")

    monkeypatch.setattr(world["dx"], "create_item", boom)
    _run(ro.observe(CTX, 11, "c1", "p1"))  # no raise


def test_failed_open_leaves_only_a_short_lived_claim(world, monkeypatch) -> None:
    async def boom(*a, **k):
        raise RuntimeError("down")

    original = world["dx"].create_item
    monkeypatch.setattr(world["dx"], "create_item", boom)
    _run(ro.observe(CTX, 11, "c1", "p1"))

    key = ro.open_key("b1")
    assert json.loads(world["redis"].store[key])["episode_id"] is None
    assert world["redis"].ttls[key] == ro.PLACEHOLDER_TTL_SECONDS
    assert ro.PLACEHOLDER_TTL_SECONDS < ro.OPEN_KEY_TTL_SECONDS

    # Once the short claim expires, the next ping opens the episode.
    monkeypatch.setattr(world["dx"], "create_item", original)
    del world["redis"].store[key]
    _run(ro.observe(CTX, 11, "c2", "p1"))
    (row,) = world["dx"].rows.values()
    assert row["peak"] == 11
    assert world["redis"].ttls[key] == ro.OPEN_KEY_TTL_SECONDS


def test_observe_does_not_recreate_a_key_the_tick_deleted(world, monkeypatch) -> None:
    # The tick closes and deletes the key while an observe holds the old state.
    _run(ro.observe(CTX, 11, "c1", "p1"))
    world["live"]["count"] = 3
    ro.close_finished_episodes()  # sets below_since, so the next observe writes
    redis = world["redis"]
    key = ro.open_key("b1")
    original_get = redis.get

    async def get_then_delete(k):
        value = await original_get(k)
        redis.store.pop(k, None)
        return value

    monkeypatch.setattr(redis, "get", get_then_delete)
    _run(ro.observe(CTX, 11, "c2", "p1"))
    assert key not in redis.store
    (row,) = world["dx"].rows.values()
    assert row["peak"] == 11 and row["ended_at"] is None


def test_close_rebuilds_a_lost_key_instead_of_opening_a_second_row(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    (opened,) = world["dx"].rows.values()
    del world["redis"].store[ro.open_key("b1")]  # redis restart or TTL expiry
    world["live"]["count"] = 12
    assert ro.close_finished_episodes() == 0
    state = json.loads(world["redis"].store[ro.open_key("b1")])
    assert state["episode_id"] == opened["id"] and state["peak"] == 11

    _run(ro.observe(CTX, 15, "c2", "p1"))
    (row,) = world["dx"].rows.values()  # still one row
    assert row["id"] == opened["id"] and row["peak"] == 15 and row["excess"] == 5


def test_observe_reopens_a_just_closed_episode(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    (opened,) = world["dx"].rows.values()
    world["live"]["count"] = 3
    ro.close_finished_episodes()  # starts the quiet clock
    world["set_now"](T0 + timedelta(seconds=300))
    assert ro.close_finished_episodes() == 1
    opened["closed_notified_at"] = "2026-09-17T14:07:00+00:00"
    assert ro.closed_key("b1") in world["redis"].store

    # A ping lands inside the quiet window: same row, not a second episode.
    _run(ro.observe(CTX, 14, "c2", "p1"))
    (row,) = world["dx"].rows.values()
    assert row["id"] == opened["id"]
    assert row["ended_at"] is None and row["closed_notified_at"] is None
    assert row["peak"] == 14 and row["excess"] == 4
    assert ro.closed_key("b1") not in world["redis"].store
    state = json.loads(world["redis"].store[ro.open_key("b1")])
    assert state == {"episode_id": opened["id"], "peak": 14, "cap": 10, "below_since": None}


def test_reopen_keeps_the_higher_peak(world) -> None:
    _run(ro.observe(CTX, 15, "c1", "p1"))
    world["live"]["count"] = 3
    ro.close_finished_episodes()
    world["set_now"](T0 + timedelta(seconds=300))
    ro.close_finished_episodes()
    _run(ro.observe(CTX, 11, "c2", "p1"))
    (row,) = world["dx"].rows.values()
    assert row["peak"] == 15 and row["excess"] == 5
    assert json.loads(world["redis"].store[ro.open_key("b1")])["peak"] == 15


def test_expired_marker_opens_a_new_episode(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    (first,) = world["dx"].rows.values()
    world["live"]["count"] = 3
    ro.close_finished_episodes()
    world["set_now"](T0 + timedelta(seconds=300))
    ro.close_finished_episodes()
    assert world["redis"].ttls[ro.closed_key("b1")] == ro.CLOSED_MARKER_TTL_SECONDS
    del world["redis"].store[ro.closed_key("b1")]  # marker TTL elapsed

    _run(ro.observe(CTX, 12, "c2", "p1"))
    rows = list(world["dx"].rows.values())
    assert len(rows) == 2
    assert first["ended_at"] is not None
    new_row = [r for r in rows if r["id"] != first["id"]][0]
    assert new_row["peak"] == 12 and new_row["ended_at"] is None


def _closing_id(row_id: str, ended_at: datetime) -> str:
    """The closing id carries the closure's own `ended_at`."""
    return f"{row_id}:closed:{ended_at.strftime('%Y%m%dT%H%M%S')}"


def _close_through_quiet_window(world, count: int = 3, start=T0) -> None:
    """Drive an open episode to closed: under the cap, then past the window."""
    world["live"]["count"] = count
    world["set_now"](start)
    ro.close_finished_episodes()  # starts the quiet clock
    world["set_now"](start + timedelta(seconds=ro.CLOSE_QUIET_SECONDS))
    ro.close_finished_episodes()


def test_reopen_loser_writes_nothing(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    _close_through_quiet_window(world)
    before_store = dict(world["redis"].store)
    before_row = dict(next(iter(world["dx"].rows.values())))

    # Another worker wins the reopen claim: this one must touch nothing.
    world["redis"].lose_next_nx = True
    _run(ro.observe(CTX, 14, "c2", "p1"))
    (row,) = world["dx"].rows.values()
    assert row == before_row  # no Directus update
    assert world["redis"].store == before_store  # no key written
    assert ro.open_key("b1") not in world["redis"].store
    assert ro.closed_key("b1") in world["redis"].store


def test_closed_marker_keeps_the_peak_a_ping_raised_during_the_tick(world, monkeypatch) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    (row,) = world["dx"].rows.values()
    stale = dict(row)  # the snapshot the tick read before the ping landed
    _run(ro.observe(CTX, 15, "c2", "p1"))
    assert row["peak"] == 15 and stale["peak"] == 11

    monkeypatch.setattr(ro, "_open_episodes", lambda _client: [stale])
    _close_through_quiet_window(world)
    assert json.loads(world["redis"].store[ro.closed_key("b1")])["peak"] == 15

    # Reopen at a lower count, then ping again: the true peak is never lowered.
    _run(ro.observe(CTX, 12, "c3", "p1"))
    _run(ro.observe(CTX, 13, "c4", "p1"))
    (row,) = world["dx"].rows.values()
    assert row["peak"] == 15 and row["excess"] == 5
    assert json.loads(world["redis"].store[ro.open_key("b1")])["peak"] == 15


def _stale_marker(world, peak: int) -> None:
    """Age the closed marker: the tick read the row before a ping raised it."""
    marker = json.loads(world["redis"].store[ro.closed_key("b1")])
    marker["peak"] = peak
    _run(world["redis"].set(ro.closed_key("b1"), json.dumps(marker)))


def test_reopen_never_lowers_the_rows_recorded_peak(world) -> None:
    _run(ro.observe(CTX, 15, "c1", "p1"))
    _close_through_quiet_window(world)
    _stale_marker(world, 11)

    _run(ro.observe(CTX, 12, "c2", "p1"))
    (row,) = world["dx"].rows.values()
    assert row["peak"] == 15 and row["excess"] == 5
    assert json.loads(world["redis"].store[ro.open_key("b1")])["peak"] == 15


def test_reopen_above_the_rows_peak_raises_it(world) -> None:
    _run(ro.observe(CTX, 15, "c1", "p1"))
    _close_through_quiet_window(world)
    _stale_marker(world, 11)

    _run(ro.observe(CTX, 20, "c2", "p1"))
    (row,) = world["dx"].rows.values()
    assert row["peak"] == 20 and row["excess"] == 10
    assert json.loads(world["redis"].store[ro.open_key("b1")])["peak"] == 20


def _closed_with_notification(world) -> dict:
    """An episode closed and its closing message already filed."""
    _close_through_quiet_window(world)
    (row,) = world["dx"].rows.values()
    row["closed_notified_at"] = (T0 + timedelta(seconds=300)).isoformat()
    return row


def _assert_reopen_deferred(world, row: dict, before: dict) -> None:
    assert row == before  # row untouched: peak, ended_at, closed_notified_at
    assert ro.closed_key("b1") in world["redis"].store
    # Only the claim placeholder, left to expire so a later ping retries.
    assert json.loads(world["redis"].store[ro.open_key("b1")]) == {
        "episode_id": None,
        "peak": 0,
    }
    assert world["redis"].ttls[ro.open_key("b1")] == ro.PLACEHOLDER_TTL_SECONDS


def test_reopen_defers_when_the_row_read_raises(world, monkeypatch) -> None:
    _run(ro.observe(CTX, 15, "c1", "p1"))
    row = _closed_with_notification(world)
    before = dict(row)

    async def boom(*a, **k):
        raise RuntimeError("directus down")

    monkeypatch.setattr(world["dx"], "get_item", boom)
    _run(ro.observe(CTX, 18, "c2", "p1"))
    _assert_reopen_deferred(world, row, before)


def test_reopen_defers_when_the_row_read_returns_none(world, monkeypatch) -> None:
    _run(ro.observe(CTX, 15, "c1", "p1"))
    row = _closed_with_notification(world)
    before = dict(row)

    async def missing(*a, **k):
        return None  # a 403 or 404 reaches us as None

    monkeypatch.setattr(world["dx"], "get_item", missing)
    _run(ro.observe(CTX, 18, "c2", "p1"))
    _assert_reopen_deferred(world, row, before)


def test_a_later_ping_retries_the_deferred_reopen(world, monkeypatch) -> None:
    _run(ro.observe(CTX, 15, "c1", "p1"))
    row = _closed_with_notification(world)

    real = world["dx"].get_item
    down = {"on": True}

    async def flaky(*a, **k):
        if down["on"]:
            raise RuntimeError("directus down")
        return await real(*a, **k)

    monkeypatch.setattr(world["dx"], "get_item", flaky)
    _run(ro.observe(CTX, 18, "c2", "p1"))

    del world["redis"].store[ro.open_key("b1")]  # placeholder TTL elapsed
    down["on"] = False
    _run(ro.observe(CTX, 18, "c3", "p1"))
    assert len(world["dx"].rows) == 1
    assert row["ended_at"] is None and row["closed_notified_at"] is None
    assert row["peak"] == 18 and row["excess"] == 8
    assert ro.closed_key("b1") not in world["redis"].store
    assert json.loads(world["redis"].store[ro.open_key("b1")])["peak"] == 18


def test_a_reopened_episode_notifies_once_at_each_end(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    (row_id,) = world["dx"].rows
    assert ro.file_pending_notifications() == 1  # opening
    _close_through_quiet_window(world)

    # Reopened before the closing message went out: nothing more to file.
    _run(ro.observe(CTX, 12, "c2", "p1"))
    assert ro.file_pending_notifications() == 0

    _close_through_quiet_window(world, start=T0 + timedelta(seconds=600))
    assert ro.file_pending_notifications() == 1  # closing, once
    assert ro.file_pending_notifications() == 0
    assert [p["id"] for p in world["posted"]] == [
        f"{row_id}:opened",
        _closing_id(row_id, T0 + timedelta(seconds=900)),
    ]
    (row,) = world["dx"].rows.values()
    assert row["peak"] == 12


def test_a_reclosed_episode_is_not_dropped_as_a_duplicate(world) -> None:
    _run(ro.observe(CTX, 12, "c1", "p1"))
    (row_id,) = world["dx"].rows
    assert ro.file_pending_notifications() == 1  # opening
    _close_through_quiet_window(world)
    assert ro.file_pending_notifications() == 1  # first closing, peak 12
    first_closing = world["posted"][-1]

    # A ping inside the marker window reopens it higher; it closes again and
    # the corrected closing must reach Slack, not die in sam's dedup.
    _run(ro.observe(CTX, 20, "c2", "p1"))
    _close_through_quiet_window(world, start=T0 + timedelta(seconds=600))
    assert ro.file_pending_notifications() == 1

    second_closing = world["posted"][-1]
    assert world["duplicates"] == []
    assert second_closing["id"] != first_closing["id"]
    assert second_closing["id"] in world["delivered_ids"]
    assert "peaked at 20 recordings" in second_closing["message"]


def test_a_retried_closing_repeats_the_same_id(world) -> None:
    _run(ro.observe(CTX, 12, "c1", "p1"))
    assert ro.file_pending_notifications() == 1  # opening
    _close_through_quiet_window(world)

    world["outcomes"].append("retry")
    assert ro.file_pending_notifications() == 0
    assert ro.file_pending_notifications() == 1
    attempt, redelivery = world["posted"][-2:]
    # One closure, one identity: a retry cannot post twice under two ids.
    assert attempt["id"] == redelivery["id"]
    assert world["delivered_ids"][-1] == attempt["id"]


def test_a_reopen_between_the_post_and_the_stamp_leaves_the_stamp_null(world) -> None:
    _run(ro.observe(CTX, 12, "c1", "p1"))
    assert ro.file_pending_notifications() == 1  # opening
    _close_through_quiet_window(world)
    (row,) = world["dx"].rows.values()

    def reopen() -> None:
        row.update({"ended_at": None, "closed_notified_at": None, "peak": 20, "excess": 10})

    # The reopen lands before Directus reads the keys, so the filter sees the
    # cleared `ended_at` and selects nothing. This window the filter does close.
    world["dx"].before_patch_filter = reopen
    assert ro.file_pending_notifications() == 0  # posted, but not stamped
    assert row["closed_notified_at"] is None
    assert row["ended_at"] is None

    # Still announceable once it really closes, with the corrected peak.
    _close_through_quiet_window(world, start=T0 + timedelta(seconds=600))
    assert ro.file_pending_notifications() == 1
    assert row["closed_notified_at"]
    assert "peaked at 20 recordings" in world["posted"][-1]["message"]


def test_a_reopen_racing_the_stamp_write_poisons_the_row_until_the_next_close(world) -> None:
    _run(ro.observe(CTX, 12, "c1", "p1"))
    assert ro.file_pending_notifications() == 1  # opening
    _close_through_quiet_window(world)
    (row,) = world["dx"].rows.values()

    def reopen() -> None:
        row.update({"ended_at": None, "closed_notified_at": None, "peak": 20, "excess": 10})

    # Directus resolves the filter to the row id, then the reopen lands, then
    # the stamp applies by id. The filter cannot reject it, so the stale stamp
    # poisons a row that is open again.
    world["dx"].after_patch_filter = reopen
    assert ro.file_pending_notifications() == 1  # posted and stamped
    assert row["ended_at"] is None
    assert row["closed_notified_at"]
    stale = world["posted"][-1]
    assert "peaked at 12 recordings" in stale["message"]

    # The next close clears the stale stamp, so the corrected closing is
    # announced and the row recovers.
    _close_through_quiet_window(world, start=T0 + timedelta(seconds=600))
    assert row["closed_notified_at"] is None
    assert ro.file_pending_notifications() == 1
    corrected = world["posted"][-1]
    assert corrected["id"] != stale["id"]
    assert "peaked at 20 recordings" in corrected["message"]

    assert ro.file_pending_notifications() == 0  # and not resent


def test_closing_an_episode_clears_a_stale_closing_stamp(world) -> None:
    _run(ro.observe(CTX, 12, "c1", "p1"))
    assert ro.file_pending_notifications() == 1  # opening
    (row,) = world["dx"].rows.values()

    # The poisoned state the Directus race can leave: a reopen cleared
    # `ended_at` after the stamp write had picked the row, so the row is open
    # and already stamped, invisible to the closing query forever.
    row.update(
        {
            "ended_at": None,
            "closed_notified_at": (T0 + timedelta(seconds=60)).isoformat(),
            "peak": 20,
            "excess": 10,
        }
    )
    assert ro.file_pending_notifications() == 0

    # Closing is what earns a closing notification, so it resets the stamp.
    _close_through_quiet_window(world, start=T0 + timedelta(seconds=600))
    assert row["closed_notified_at"] is None
    assert row["ended_at"] == (T0 + timedelta(seconds=900)).isoformat()

    assert ro.file_pending_notifications() == 1
    assert "peaked at 20 recordings" in world["posted"][-1]["message"]
    assert row["closed_notified_at"]
    assert ro.file_pending_notifications() == 0


def test_a_closing_id_normalises_a_non_utc_ended_at() -> None:
    episode = {"id": "ep-9", "ended_at": "2026-09-17T16:07:00+02:00"}
    assert ro._notification_id(episode, "closed") == "ep-9:closed:20260917T140700"


def test_a_closing_id_falls_back_when_ended_at_is_unusable() -> None:
    assert ro._notification_id({"id": "ep-9", "ended_at": None}, "closed") == "ep-9:closed"
    assert ro._notification_id({"id": "ep-9", "ended_at": "not a date"}, "closed") == "ep-9:closed"


def test_excess_uses_the_cap_frozen_at_open(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    raised = BillingContext(**{**CTX.__dict__, "cap": 20})
    _run(ro.observe(raised, 25, "c2", "p1"))
    (row,) = world["dx"].rows.values()
    assert row["cap"] == 10 and row["peak"] == 25 and row["excess"] == 15


# close


def test_close_waits_for_quiet_window(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    world["live"]["count"] = 10
    assert ro.close_finished_episodes() == 0  # first tick under cap: start the clock
    world["set_now"](T0 + timedelta(seconds=120))
    assert ro.close_finished_episodes() == 0  # 2 min: still open
    world["set_now"](T0 + timedelta(seconds=300))
    assert ro.close_finished_episodes() == 1
    (row,) = world["dx"].rows.values()
    assert row["ended_at"] == (T0 + timedelta(seconds=300)).isoformat()
    assert ro.open_key("b1") not in world["redis"].store


def test_close_rechecks_the_live_count_before_stamping(world, monkeypatch) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    world["live"]["count"] = 10
    ro.close_finished_episodes()  # clock starts at T0
    world["set_now"](T0 + timedelta(seconds=300))

    # Quiet window elapsed, but the account is over the cap again by the time
    # the tick is about to stamp: the second read wins.
    counts = [10, 12]

    async def count_active(_account: str) -> int:
        return counts.pop(0)

    monkeypatch.setattr(ro, "count_active", count_active)
    assert ro.close_finished_episodes() == 0
    (row,) = world["dx"].rows.values()
    assert row["ended_at"] is None
    assert json.loads(world["redis"].store[ro.open_key("b1")])["below_since"] is None


def test_spike_resets_quiet_clock(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    world["live"]["count"] = 10
    ro.close_finished_episodes()  # clock starts at T0
    world["set_now"](T0 + timedelta(seconds=200))
    world["live"]["count"] = 12
    ro.close_finished_episodes()  # above cap: clock cleared
    world["live"]["count"] = 10
    world["set_now"](T0 + timedelta(seconds=320))
    assert ro.close_finished_episodes() == 0  # only 120 s quiet since the reset


def test_observe_above_cap_clears_quiet_clock(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    world["live"]["count"] = 10
    ro.close_finished_episodes()
    _run(ro.observe(CTX, 11, "c9", "p1"))
    state = json.loads(world["redis"].store[ro.open_key("b1")])
    assert "below_since" not in state or state["below_since"] is None


# notifications


def _two_open_episodes(world) -> None:
    world["dx"].accounts["b2"] = {"id": "b2", "label": "Beta", "tier": "free", "workspace_id": "w2"}
    _run(ro.observe(CTX, 11, "c1", "p1"))
    _run(ro.observe(BillingContext(**{**CTX.__dict__, "account_id": "b2"}), 12, "c2", "p2"))


def test_opening_and_closing_post_once_each(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    _run(ro.observe(CTX, 15, "c2", "p1"))
    assert ro.file_pending_notifications() == 1
    assert ro.file_pending_notifications() == 0
    (row_id,) = world["dx"].rows
    (opened,) = world["posted"]
    assert opened["id"] == f"{row_id}:opened"
    assert opened["environment"] == "echo-next"
    assert opened["workspace_id"] == "w1" and opened["project_id"] == "p1"
    assert (
        opened["origin_link"] == "https://dashboard.echo-next.dembrane.com/en-US/w/w1/projects/p1"
    )
    assert (
        opened["message"]
        == "Concurrent recording cap exceeded. Account Acme on free has 15 recordings, cap 10. Since 2026-09-17 14:02 UTC."
    )

    world["live"]["count"] = 3
    ro.close_finished_episodes()
    world["set_now"](T0 + timedelta(seconds=300))
    ro.close_finished_episodes()
    assert ro.file_pending_notifications() == 1
    closed = world["posted"][-1]
    # Composite id: sam dedupes on id, so the closing message needs its own.
    assert closed["id"] == _closing_id(row_id, T0 + timedelta(seconds=300))
    assert (
        closed["message"]
        == "Cap episode ended. Account Acme on free peaked at 15 recordings, cap 10, 5 over, from 2026-09-17 14:02 to 2026-09-17 14:07 UTC."
    )
    (row,) = world["dx"].rows.values()
    assert row["opened_notified_at"] and row["closed_notified_at"]


def test_account_without_label_uses_id(world) -> None:
    world["dx"].accounts["b1"]["label"] = ""
    _run(ro.observe(CTX, 11, "c1", "p1"))
    ro.file_pending_notifications()
    assert "Account b1 on free" in world["posted"][0]["message"]


def test_rejected_leaves_the_stamp_null_and_the_next_row_is_attempted(world) -> None:
    _two_open_episodes(world)
    world["outcomes"].extend(["rejected", "delivered"])
    assert ro.file_pending_notifications() == 1
    assert len(world["posted"]) == 2
    first, second = world["dx"].rows.values()
    assert first["opened_notified_at"] is None
    assert second["opened_notified_at"]


def test_retry_stops_the_batch_and_stamps_nothing(world) -> None:
    _two_open_episodes(world)
    world["outcomes"].append("retry")
    assert ro.file_pending_notifications() == 0
    assert len(world["posted"]) == 1  # receiver down: no second attempt
    assert all(r["opened_notified_at"] is None for r in world["dx"].rows.values())


def test_unconfigured_webhook_posts_nothing_and_stamps_nothing(world) -> None:
    _run(ro.observe(CTX, 11, "c1", "p1"))
    world["unset_webhook"]()
    assert ro.file_pending_notifications() == 0
    assert world["posted"] == []
    (row,) = world["dx"].rows.values()
    assert row["opened_notified_at"] is None


@pytest.mark.parametrize("started", ["2026-09-17T14:02:00", "2026-09-17T14:02:00Z"])
def test_naive_and_z_timestamps_render_as_utc(started: str) -> None:
    episode = {"billing_account_id": "b1", "peak": 15, "cap": 10, "started_at": started}
    message = ro.format_opening_message(episode, {"label": "Acme", "tier": "free"})
    assert message.endswith("Since 2026-09-17 14:02 UTC.")


def test_account_without_tier_renders_unknown_tier() -> None:
    episode = {
        "billing_account_id": "b1",
        "peak": 15,
        "cap": 10,
        "started_at": "2026-09-17T14:02:00Z",
    }
    assert "on unknown tier" in ro.format_opening_message(episode, {"label": "Acme"})
    closing = {**episode, "excess": 5, "ended_at": "2026-09-17T14:07:00Z"}
    assert "on unknown tier" in ro.format_closing_message(closing, {"label": "Acme"})
