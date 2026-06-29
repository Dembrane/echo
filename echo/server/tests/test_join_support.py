"""Tests for POST /v2/admin/workspaces/:id/join-support (ECHO-863).

The staff support-access join is gated twice: the is_admin staff claim AND the
customer's allow_support_access toggle. On success it writes a staff_support
admin membership with a 24h expiry and enqueues a durable revoke task. These
tests lock down the gates and the create / extend / already-member branches.
"""

from __future__ import annotations

from types import SimpleNamespace
from datetime import datetime, timezone, timedelta
from contextlib import ExitStack, contextmanager
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.admin import router as admin_router
from dembrane.scheduled_tasks import TASK_REVOKE_STAFF_SUPPORT
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_WS_ID = "ws-1"
_ORG_ID = "org-1"


def _build_app(is_admin: bool) -> FastAPI:
    app = FastAPI()

    async def _auth() -> DirectusSession:
        return DirectusSession(user_id="du-staff", is_admin=is_admin)

    app.dependency_overrides[require_directus_session] = _auth
    app.include_router(admin_router, prefix="/v2/admin")
    return app


def _directus_mock(ws: dict | None, memberships: list[dict]) -> AsyncMock:
    m = AsyncMock()

    async def get_item(collection: str, item_id: str) -> dict | None:
        return ws if collection == "workspace" else None

    async def get_items(collection: str, params: dict | None = None) -> list[dict]:
        return list(memberships) if collection == "workspace_membership" else []

    m.get_item = AsyncMock(side_effect=get_item)
    m.get_items = AsyncMock(side_effect=get_items)
    m.update_item = AsyncMock(return_value={"data": {}})
    return m


@contextmanager
def _patched(ws: dict | None, memberships: list[dict]):
    mocks = SimpleNamespace(
        directus=_directus_mock(ws, memberships),
        create=AsyncMock(return_value=True),
        reactivate=AsyncMock(return_value=True),
        schedule=AsyncMock(return_value="task-1"),
        cancel=AsyncMock(return_value=0),
        invalidate=AsyncMock(),
    )
    with ExitStack() as stack:
        stack.enter_context(patch("dembrane.api.v2.admin.async_directus", mocks.directus))
        stack.enter_context(
            patch(
                "dembrane.app_user.get_app_user_or_raise",
                AsyncMock(return_value={"id": "au-staff"}),
            )
        )
        stack.enter_context(patch("dembrane.scheduled_tasks.schedule_task", mocks.schedule))
        stack.enter_context(
            patch("dembrane.scheduled_tasks.cancel_pending_tasks", mocks.cancel)
        )
        stack.enter_context(
            patch("dembrane.cache_utils.invalidate_workspace_and_org_usage", mocks.invalidate)
        )
        stack.enter_context(
            patch("dembrane.api.v2._invite_helpers.create_membership_row", mocks.create)
        )
        stack.enter_context(
            patch(
                "dembrane.api.v2._invite_helpers.reactivate_membership_row",
                mocks.reactivate,
            )
        )
        yield mocks


async def _post(app: FastAPI):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.post(f"/v2/admin/workspaces/{_WS_ID}/join-support")


async def _get(app: FastAPI):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.get(f"/v2/admin/workspaces/{_WS_ID}/join-support")


async def _delete(app: FastAPI):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.delete(f"/v2/admin/workspaces/{_WS_ID}/join-support")


# ── gates ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_non_admin_forbidden():
    res = await _post(_build_app(is_admin=False))
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_workspace_not_found():
    with _patched(ws=None, memberships=[]):
        res = await _post(_build_app(is_admin=True))
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_support_access_disabled_forbidden():
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": False}
    with _patched(ws, memberships=[]):
        res = await _post(_build_app(is_admin=True))
    assert res.status_code == 403
    assert "support access" in res.json()["detail"].lower()


# ── happy paths ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_join_creates_staff_support_membership_and_schedules_revoke():
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    with _patched(ws, memberships=[]) as m:
        res = await _post(_build_app(is_admin=True))

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "joined"
    assert body["role"] == "admin"
    assert body["expires_at"]

    # membership row written as staff_support admin with an expiry
    m.create.assert_awaited_once()
    payload = m.create.await_args.args[2]
    assert payload["source"] == "staff_support"
    assert payload["role"] == "admin"
    assert payload["expires_at"]
    membership_id = payload["id"]

    # durable revoke task enqueued for that membership
    m.schedule.assert_awaited_once()
    skw = m.schedule.await_args.kwargs
    assert skw["task_type"] == TASK_REVOKE_STAFF_SUPPORT
    assert skw["payload"] == {
        "workspace_id": _WS_ID,
        "membership_id": membership_id,
        "org_id": _ORG_ID,
    }
    m.invalidate.assert_awaited_once()


@pytest.mark.asyncio
async def test_existing_staff_support_extends_window():
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    existing = [
        {"id": "mem-1", "role": "admin", "source": "staff_support", "deleted_at": None}
    ]
    with _patched(ws, memberships=existing) as m:
        res = await _post(_build_app(is_admin=True))

    assert res.status_code == 200
    assert res.json()["status"] == "extended"
    # extended the existing row's expiry, did not create a new one
    m.directus.update_item.assert_awaited()
    m.create.assert_not_awaited()
    m.schedule.assert_awaited_once()


@pytest.mark.asyncio
async def test_existing_real_member_is_already_member_no_expiry():
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    existing = [
        {"id": "mem-2", "role": "member", "source": "direct", "deleted_at": None}
    ]
    with _patched(ws, memberships=existing) as m:
        res = await _post(_build_app(is_admin=True))

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "already_member"
    assert body["expires_at"] is None
    # a genuine membership must not be clobbered with an expiry or a revoke timer
    m.create.assert_not_awaited()
    m.schedule.assert_not_awaited()


# ── concurrent-join race (create/reactivate loses to a parallel request) ──────


def _race_directus(ws: dict, race_winner: dict) -> AsyncMock:
    """Directus mock where the initial (ws, user) scan sees no row but the
    post-write re-resolution finds `race_winner` — i.e. a parallel join inserted
    the active row between our read and our (now-rejected) write."""
    m = AsyncMock()
    calls = {"membership": 0}

    async def get_item(collection: str, item_id: str) -> dict | None:
        return ws if collection == "workspace" else None

    async def get_items(collection: str, params: dict | None = None) -> list[dict]:
        if collection != "workspace_membership":
            return []
        calls["membership"] += 1
        # 1st query = initial active/deleted scan (empty → we try to create);
        # 2nd query = re-resolution after the create lost the unique-violation race.
        return [] if calls["membership"] == 1 else [race_winner]

    m.get_item = AsyncMock(side_effect=get_item)
    m.get_items = AsyncMock(side_effect=get_items)
    m.update_item = AsyncMock(return_value={"data": {}})
    return m


@contextmanager
def _patched_race(directus: AsyncMock):
    mocks = SimpleNamespace(
        directus=directus,
        create=AsyncMock(return_value=False),  # lost the race
        reactivate=AsyncMock(return_value=False),
        schedule=AsyncMock(return_value="task-1"),
        cancel=AsyncMock(return_value=0),
        invalidate=AsyncMock(),
    )
    with ExitStack() as stack:
        stack.enter_context(patch("dembrane.api.v2.admin.async_directus", mocks.directus))
        stack.enter_context(
            patch(
                "dembrane.app_user.get_app_user_or_raise",
                AsyncMock(return_value={"id": "au-staff"}),
            )
        )
        stack.enter_context(patch("dembrane.scheduled_tasks.schedule_task", mocks.schedule))
        stack.enter_context(
            patch("dembrane.scheduled_tasks.cancel_pending_tasks", mocks.cancel)
        )
        stack.enter_context(
            patch("dembrane.cache_utils.invalidate_workspace_and_org_usage", mocks.invalidate)
        )
        stack.enter_context(
            patch("dembrane.api.v2._invite_helpers.create_membership_row", mocks.create)
        )
        stack.enter_context(
            patch(
                "dembrane.api.v2._invite_helpers.reactivate_membership_row",
                mocks.reactivate,
            )
        )
        yield mocks


# ── status (GET) ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_status_requires_staff():
    res = await _get(_build_app(is_admin=False))
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_status_reports_no_active_session():
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    with _patched(ws, memberships=[]):
        res = await _get(_build_app(is_admin=True))
    assert res.status_code == 200
    assert res.json() == {"active": False, "membership_id": None, "expires_at": None}


@pytest.mark.asyncio
async def test_status_reports_active_session_with_expiry():
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    future = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat()
    rows = [{"id": "mem-1", "expires_at": future}]
    with _patched(ws, memberships=rows):
        res = await _get(_build_app(is_admin=True))
    assert res.status_code == 200
    body = res.json()
    assert body["active"] is True
    assert body["membership_id"] == "mem-1"
    assert body["expires_at"] == future


@pytest.mark.asyncio
async def test_status_treats_expired_session_as_inactive():
    """A session whose expiry has elapsed reports inactive even if the row is
    still present (the revoke sweep hasn't run), so the UI offers a fresh join."""
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    expired = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    rows = [{"id": "mem-1", "expires_at": expired}]
    with _patched(ws, memberships=rows):
        res = await _get(_build_app(is_admin=True))
    assert res.status_code == 200
    assert res.json()["active"] is False


# ── leave (DELETE) ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_leave_requires_staff():
    res = await _delete(_build_app(is_admin=False))
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_leave_soft_deletes_and_cancels_revoke():
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    rows = [{"id": "mem-1", "expires_at": "2026-06-27T12:00:00+00:00"}]
    with _patched(ws, memberships=rows) as m:
        res = await _delete(_build_app(is_admin=True))
    assert res.status_code == 200
    assert res.json()["active"] is False
    # row soft-deleted (deleted_at set) and the pending revoke timer cancelled
    m.directus.update_item.assert_awaited()
    patch_arg = m.directus.update_item.await_args.args[2]
    assert patch_arg.get("deleted_at")
    m.cancel.assert_awaited_once()
    m.invalidate.assert_awaited_once()


@pytest.mark.asyncio
async def test_leave_is_noop_when_no_session():
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    with _patched(ws, memberships=[]) as m:
        res = await _delete(_build_app(is_admin=True))
    assert res.status_code == 200
    assert res.json()["active"] is False
    m.directus.update_item.assert_not_awaited()
    m.cancel.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_lost_race_to_real_member_returns_already_member():
    """If our create loses to a concurrent join that produced a genuine member,
    we must report already_member and NOT schedule a revoke against a row we
    never wrote."""
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    winner = {"id": "mem-real", "role": "admin", "source": "direct"}
    with _patched_race(_race_directus(ws, winner)) as m:
        res = await _post(_build_app(is_admin=True))

    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "already_member"
    assert body["membership_id"] == "mem-real"
    assert body["expires_at"] is None
    m.schedule.assert_not_awaited()


@pytest.mark.asyncio
async def test_create_lost_race_to_staff_support_extends_winning_row():
    """If our create loses to a concurrent staff join, schedule the revoke
    against the row that actually persisted, not our discarded id."""
    ws = {"id": _WS_ID, "org_id": _ORG_ID, "allow_support_access": True}
    winner = {"id": "mem-staff", "role": "admin", "source": "staff_support"}
    with _patched_race(_race_directus(ws, winner)) as m:
        res = await _post(_build_app(is_admin=True))

    assert res.status_code == 200
    body = res.json()
    assert body["membership_id"] == "mem-staff"
    assert body["expires_at"]
    # revoke timer points at the persisted row, not the discarded generated id
    m.schedule.assert_awaited_once()
    assert m.schedule.await_args.kwargs["payload"]["membership_id"] == "mem-staff"
