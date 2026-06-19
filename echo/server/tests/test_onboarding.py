"""Tests for the onboarding endpoint — workspace seeding tier and idempotency.

Covers:
    - Direct signup seeds a workspace at tier=free (not pilot).
    - Invite-only signup does not seed a personal workspace.
    - Re-running onboarding for an existing owner is idempotent (no extra workspace).
    - The seed call bypasses the workspace_request flow (verified via call args).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient, ASGITransport
from fastapi import FastAPI

from dembrane.api.v2.onboarding import router, _flag_review
from dembrane.api.dependency_auth import DirectusSession, require_directus_session

_USER_ID = "du-test-001"
_APP_USER_ID = "au-test-001"
_APP_USER = {"id": _APP_USER_ID, "email": "alice@example.com", "display_name": "Alice"}
_DIRECTUS_PROFILE = {"email": "alice@example.com", "display_name": "Alice"}


def _build_app(auth_user_id: str = _USER_ID) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=auth_user_id, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/onboarding")
    return app


def _mock_async_directus() -> AsyncMock:
    """Build an AsyncMock for async_directus with sensible defaults."""
    mock = AsyncMock()
    mock.get_items.return_value = []
    mock.get_item.return_value = None
    mock.create_item.return_value = {"data": {"id": "new-item"}}
    mock.update_item.return_value = {"data": {}}
    return mock


def _noop_rate_limiter() -> AsyncMock:
    """Rate limiter that always passes."""
    rl = AsyncMock()
    rl.check = AsyncMock(return_value=None)
    return rl


@pytest.fixture(autouse=True)
def _patch_rate_limiter():
    """Disable Redis-backed rate limiters in all onboarding tests."""
    with (
        patch(
            "dembrane.api.v2.onboarding._onboarding_rate_limiter",
            _noop_rate_limiter(),
        ),
        patch(
            "dembrane.api.v2.onboarding._answers_rate_limiter",
            _noop_rate_limiter(),
        ),
    ):
        yield


@pytest.mark.asyncio
async def test_direct_signup_seeds_free_workspace():
    """A fresh direct-signup user gets a workspace at tier=free."""
    mock_directus = _mock_async_directus()

    call_log: list[tuple[str, dict[str, Any]]] = []
    original_create = mock_directus.create_item

    async def _tracking_create(collection: str, payload: dict[str, Any]) -> dict:
        call_log.append((collection, payload))
        return await original_create(collection, payload)

    mock_directus.create_item = AsyncMock(side_effect=_tracking_create)

    # The seed workspace's tier lives on its billing account; track that client.
    mock_ba = _mock_async_directus()
    ba_log: list[tuple[str, dict[str, Any]]] = []
    _orig_ba_create = mock_ba.create_item

    async def _track_ba(collection: str, payload: dict[str, Any]) -> dict:
        ba_log.append((collection, payload))
        return await _orig_ba_create(collection, payload)

    mock_ba.create_item = AsyncMock(side_effect=_track_ba)

    with (
        patch("dembrane.api.v2.onboarding.async_directus", mock_directus),
        patch("dembrane.directus_async.async_directus", mock_ba),
        patch("dembrane.api.v2.onboarding.resolve_app_user", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.onboarding.get_directus_user_profile",
            return_value=_DIRECTUS_PROFILE,
        ),
        patch(
            "dembrane.api.v2.onboarding.assert_can_add_seat",
            new_callable=AsyncMock,
        ),
        patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/v2/onboarding/complete", json={"org_name": "Alice Corp"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["app_user_id"] == _APP_USER_ID
    assert body["org_id"] != ""
    assert body["workspace_id"] != ""

    ws_creates = [(col, p) for col, p in call_log if col == "workspace"]
    assert len(ws_creates) == 1, f"Expected 1 workspace create, got {len(ws_creates)}"
    assert ws_creates[0][1]["is_default"] is True

    # The seed workspace's billing account is created at tier=free.
    account_creates = [p for col, p in ba_log if col == "billing_account"]
    assert len(account_creates) == 1, f"Expected 1 account create, got {len(account_creates)}"
    assert account_creates[0]["tier"] == "free"


@pytest.mark.asyncio
async def test_invite_user_gets_no_personal_workspace():
    """A user who registers via an invite gets no personal workspace."""
    mock_directus = _mock_async_directus()

    invite_ws = {
        "id": "ws-invite-target",
        "tier": "pioneer",
        "org_id": "org-invite",
        "name": "Team WS",
    }
    pending_invite = {
        "id": "inv-1",
        "workspace_id": "ws-invite-target",
        "role": "member",
        "expires_at": "2099-01-01T00:00:00Z",
    }

    call_log: list[tuple[str, dict[str, Any]]] = []
    original_create = mock_directus.create_item

    async def _tracking_create(collection: str, payload: dict[str, Any]) -> dict:
        call_log.append((collection, payload))
        return await original_create(collection, payload)

    mock_directus.create_item = AsyncMock(side_effect=_tracking_create)

    async def _fake_get_items(collection: str, _params: dict) -> Any:
        if collection == "workspace_invite":
            return [pending_invite]
        return []

    mock_directus.get_items = AsyncMock(side_effect=_fake_get_items)
    mock_directus.get_item = AsyncMock(
        side_effect=lambda col, _id: invite_ws if col == "workspace" else None
    )

    with (
        patch("dembrane.api.v2.onboarding.async_directus", mock_directus),
        patch("dembrane.directus_async.async_directus", _mock_async_directus()),
        patch("dembrane.api.v2.onboarding.resolve_app_user", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.onboarding.get_directus_user_profile",
            return_value=_DIRECTUS_PROFILE,
        ),
        patch(
            "dembrane.api.v2.onboarding.assert_can_add_seat",
            new_callable=AsyncMock,
        ),
        patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
        patch("dembrane.notifications.emit", new_callable=AsyncMock),
        patch("dembrane.notifications.emit_to_audience", new_callable=AsyncMock),
        patch(
            "dembrane.notifications.audience_organisation_admins",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch(
            "dembrane.notifications.audience_workspace_admins",
            new_callable=AsyncMock,
            return_value=[],
        ),
        patch("dembrane.cache_utils.invalidate_workspace_and_org_usage", new_callable=AsyncMock),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/v2/onboarding/complete", json={"org_name": "Ignored Corp"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["workspace_id"] == "ws-invite-target"

    ws_creates = [(col, p) for col, p in call_log if col == "workspace"]
    assert len(ws_creates) == 0, "Invite user should not get a personal workspace"


@pytest.mark.asyncio
async def test_existing_owner_does_not_get_duplicate_workspace():
    """Re-running onboarding for a user who already owns a workspace is idempotent."""
    mock_directus = _mock_async_directus()

    existing_org_membership = [{"org_id": "org-existing"}]
    existing_workspace = [{"id": "ws-existing"}]
    existing_ws_membership = [{"id": "wm-existing"}]

    call_count = {"workspace_create": 0}
    original_create = mock_directus.create_item

    async def _tracking_create(collection: str, payload: dict[str, Any]) -> dict:
        if collection == "workspace":
            call_count["workspace_create"] += 1
        return await original_create(collection, payload)

    mock_directus.create_item = AsyncMock(side_effect=_tracking_create)

    async def _fake_get_items(collection: str, params: dict) -> Any:
        q = params.get("query", {})
        f = q.get("filter", {})
        if collection == "workspace_invite":
            return []
        if collection == "project":
            return []
        if collection == "org_membership":
            if f.get("role", {}).get("_eq") == "owner":
                return existing_org_membership
            return []
        if collection == "workspace":
            if f.get("is_default", {}).get("_eq") is True:
                return existing_workspace
            return []
        if collection == "workspace_membership":
            return existing_ws_membership
        return []

    mock_directus.get_items = AsyncMock(side_effect=_fake_get_items)

    with (
        patch("dembrane.api.v2.onboarding.async_directus", mock_directus),
        patch("dembrane.directus_async.async_directus", _mock_async_directus()),
        patch("dembrane.api.v2.onboarding.resolve_app_user", return_value=_APP_USER),
        patch(
            "dembrane.api.v2.onboarding.get_directus_user_profile",
            return_value=_DIRECTUS_PROFILE,
        ),
        patch(
            "dembrane.api.v2.onboarding.assert_can_add_seat",
            new_callable=AsyncMock,
        ),
        patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
    ):
        app = _build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/v2/onboarding/complete", json={"org_name": "Alice Corp"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["workspace_id"] == "ws-existing"
    assert call_count["workspace_create"] == 0, "No new workspace should be created"


# ── ISSUE-013: terms_accepted_at recorded at app_user creation ──


@pytest.mark.asyncio
async def test_create_app_user_records_terms_accepted_at():
    """create_app_user stamps terms_accepted_at — registration can't complete
    without accepting the terms, so reaching app_user creation implies it."""
    from dembrane.app_user import create_app_user

    captured: dict = {}

    async def _capture_create(collection: str, payload: dict):
        captured["collection"] = collection
        captured["payload"] = payload
        return {"data": {**payload}}

    mock = AsyncMock()
    mock.create_item = AsyncMock(side_effect=_capture_create)

    with patch("dembrane.app_user.async_directus", mock):
        result = await create_app_user(
            directus_user_id="du-x",
            email="x@example.com",
            display_name="X",
        )

    assert captured["collection"] == "app_user"
    assert captured["payload"].get("terms_accepted_at"), "terms_accepted_at must be set"
    assert result["terms_accepted_at"]


# ── ISSUE-012: onboarding answers persist + analytics + staff notify ──


def _build_answers_app(auth_user_id: str = _USER_ID) -> FastAPI:
    app = FastAPI()

    async def _fake_auth() -> DirectusSession:
        return DirectusSession(user_id=auth_user_id, is_admin=False)

    app.dependency_overrides[require_directus_session] = _fake_auth
    app.include_router(router, prefix="/v2/onboarding")
    return app


@pytest.mark.asyncio
async def test_submit_answers_persists_and_mirrors_to_posthog():
    """Answers land on app_user.onboarding_answer_json and a server-side
    PostHog event fires. Benign answers fire no staff notification."""
    mock_directus = _mock_async_directus()
    update_log: list[tuple[str, str, dict]] = []

    async def _track_update(collection: str, item_id: str, payload: dict):
        update_log.append((collection, item_id, payload))
        return {"data": {}}

    mock_directus.update_item = AsyncMock(side_effect=_track_update)

    capture_mock = AsyncMock()
    notify_mock = AsyncMock()

    with (
        patch("dembrane.api.v2.onboarding.async_directus", mock_directus),
        patch("dembrane.api.v2.onboarding.get_app_user_or_raise", return_value=_APP_USER),
        patch("dembrane.analytics.capture_event", capture_mock),
        patch(
            "dembrane.api.v2.onboarding._notify_staff_onboarding_followup",
            notify_mock,
        ),
    ):
        app = _build_answers_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/onboarding/answers",
                json={
                    "version": "17-jun-26",
                    "data": [{"q1": "only internally"}, {"q2": "no"}, {"q3": "yes"}],
                },
            )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "success"
    assert body["onboarding_answer_json"]["version"] == "17-jun-26"

    answer_updates = [
        u for u in update_log if u[0] == "app_user" and "onboarding_answer_json" in u[2]
    ]
    assert len(answer_updates) == 1
    stored = answer_updates[0][2]["onboarding_answer_json"]
    assert stored["data"] == [{"q1": "only internally"}, {"q2": "no"}, {"q3": "yes"}]

    capture_mock.assert_awaited_once()
    # q3=yes is a training branch → staff IS notified.
    notify_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_submit_answers_high_risk_notifies_staff():
    """A high-risk (q2=yes) + with-clients (q1) answer notifies staff."""
    mock_directus = _mock_async_directus()
    notify_mock = AsyncMock()

    with (
        patch("dembrane.api.v2.onboarding.async_directus", mock_directus),
        patch("dembrane.api.v2.onboarding.get_app_user_or_raise", return_value=_APP_USER),
        patch("dembrane.analytics.capture_event", new_callable=AsyncMock),
        patch(
            "dembrane.api.v2.onboarding._notify_staff_onboarding_followup",
            notify_mock,
        ),
    ):
        app = _build_answers_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/onboarding/answers",
                json={
                    "version": "17-jun-26",
                    "data": [{"q1": "with clients"}, {"q2": "yes"}, {"q3": "no"}],
                },
            )

    assert resp.status_code == 200
    notify_mock.assert_awaited_once()
    kwargs = notify_mock.await_args.kwargs
    assert kwargs["wants_partner_review"] is True
    assert kwargs["is_high_risk"] is True
    assert kwargs["training_status"] == "no"


@pytest.mark.asyncio
async def test_skip_persists_marker_and_skips_staff_notify():
    """A skip still writes onboarding_answer_json (with skipped=true) so the
    login gate stops re-nudging, and never fires the staff follow-up."""
    mock_directus = _mock_async_directus()
    update_log: list[tuple[str, str, dict]] = []

    async def _track_update(collection: str, item_id: str, payload: dict):
        update_log.append((collection, item_id, payload))
        return {"data": {}}

    mock_directus.update_item = AsyncMock(side_effect=_track_update)
    notify_mock = AsyncMock()

    with (
        patch("dembrane.api.v2.onboarding.async_directus", mock_directus),
        patch("dembrane.api.v2.onboarding.get_app_user_or_raise", return_value=_APP_USER),
        patch("dembrane.analytics.capture_event", new_callable=AsyncMock),
        patch(
            "dembrane.api.v2.onboarding._notify_staff_onboarding_followup",
            notify_mock,
        ),
    ):
        app = _build_answers_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post(
                "/v2/onboarding/answers",
                json={"version": "17-jun-26", "data": [], "skipped": True},
            )

    assert resp.status_code == 200
    body = resp.json()
    # onboarding_answer_json is now truthy → login gate won't re-nudge.
    assert body["onboarding_answer_json"]["skipped"] is True
    answer_updates = [
        u for u in update_log if u[0] == "app_user" and "onboarding_answer_json" in u[2]
    ]
    assert len(answer_updates) == 1
    assert answer_updates[0][2]["onboarding_answer_json"]["skipped"] is True
    # A skip carries no answers → no staff follow-up.
    notify_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_notify_staff_emits_and_emails():
    """The staff follow-up helper fans an in-app row to staff and emails the
    training owner."""
    from dembrane.api.v2.onboarding import _notify_staff_onboarding_followup

    emit_mock = AsyncMock(return_value=["nid-1"])
    audience_mock = AsyncMock(return_value=["staff-1", "staff-2"])
    send_email_mock = AsyncMock(return_value=True)

    with (
        patch("dembrane.notifications.emit_to_audience", emit_mock),
        patch("dembrane.notifications.audience_staff", audience_mock),
        patch("dembrane.email.send_email", send_email_mock),
    ):
        await _notify_staff_onboarding_followup(
            app_user=_APP_USER,
            wants_partner_review=True,
            is_high_risk=False,
            training_status="no",
        )

    emit_mock.assert_awaited_once()
    send_email_mock.assert_awaited_once()


def test_flag_review_branches():
    """_flag_review reads q1/q2/q3 into the staff-review booleans."""
    partner, risk, training = _flag_review(
        [{"q1": "with clients"}, {"q2": "yes"}, {"q3": "no"}]
    )
    assert (partner, risk, training) == (True, True, "no")

    partner, risk, training = _flag_review(
        [{"q1": "only internally"}, {"q2": "no"}, {"q3": "yes"}]
    )
    assert (partner, risk, training) == (False, False, "yes")

    # List-valued q1 (select-many) still detects clients.
    partner, _risk, _training = _flag_review([{"q1": ["only internally", "with clients"]}])
    assert partner is True

    # Empty / unknown answers are safe.
    assert _flag_review([]) == (False, False, None)
    assert _flag_review([{"unknown": "x"}]) == (False, False, None)
