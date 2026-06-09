"""Tests for PATCH /v2/admin/workspace-requests/{id} (Slice 10 + 11).

Covers:
- Staff-only authorization (403 for non-staff)
- Approve action: new_workspace creates workspace + owner membership
- Approve action: tier_upgrade changes workspace tier
- Approve with overrides (granted_tier, expires_at, discount)
- Deny action: denial_reason required, no workspace changes
- Idempotency: second decide on a decided row returns 409
- Decision stamps: decided_at, decided_by are set
- Self-serve POST /v2/workspaces returns 403 for non-staff
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import BackgroundTasks
from pydantic import ValidationError

from dembrane.api.v2.admin import (
    DecideWorkspaceRequestBody,
    DecideWorkspaceRequestResponse,
    _create_workspace_for_request,
    _upgrade_workspace_for_request,
)

# ── Fixtures ──


def _make_pending_request(
    *,
    id: str = "req-1",
    kind: str = "new_workspace",
    requested_by: str = "user-1",
    org_id: str = "org-1",
    workspace_id: str | None = None,
    proposed_name: str = "My workspace",
    proposed_tier: str = "innovator",
    proposed_visibility: str = "open_to_organisation",
    requester_message: str | None = "Please approve",
    **overrides,
) -> dict:
    row = {
        "id": id,
        "kind": kind,
        "status": "pending",
        "requested_by": requested_by,
        "org_id": org_id,
        "workspace_id": workspace_id,
        "proposed_name": proposed_name,
        "proposed_tier": proposed_tier,
        "proposed_visibility": proposed_visibility,
        "requester_message": requester_message,
    }
    row.update(overrides)
    return row


def _refresh_after_claim(req: dict, *, staff_id: str = "staff-1", decided_status: str) -> dict:
    """Second ``get_item`` result: optimistic claim succeeded for this staff member."""
    return {
        **req,
        "decided_by": staff_id,
        "decided_at": "2026-01-01T00:00:00+00:00",
        "status": decided_status,
    }


# ── Model validation tests ──


class TestDecideWorkspaceRequestBody:
    def test_approve_minimal(self):
        body = DecideWorkspaceRequestBody(action="approve")
        assert body.action == "approve"
        assert body.granted_tier is None
        assert body.denial_reason is None

    def test_deny_with_reason(self):
        body = DecideWorkspaceRequestBody(
            action="deny", denial_reason="Insufficient info"
        )
        assert body.action == "deny"
        assert body.denial_reason == "Insufficient info"

    def test_approve_with_overrides(self):
        body = DecideWorkspaceRequestBody(
            action="approve",
            granted_tier="pioneer",
            granted_tier_expires_at="2026-06-11T00:00:00Z",
            granted_type_discount="scholarship",
            granted_percent_discount=25,
            staff_notes="Check with finance",
        )
        assert body.granted_tier == "pioneer"
        assert body.granted_percent_discount == 25
        assert body.granted_type_discount == "scholarship"
        assert body.staff_notes == "Check with finance"

    def test_invalid_action(self):
        with pytest.raises(ValidationError):
            DecideWorkspaceRequestBody(action="cancel")

    def test_discount_out_of_range(self):
        with pytest.raises(ValidationError):
            DecideWorkspaceRequestBody(
                action="approve", granted_percent_discount=101
            )

    def test_discount_negative(self):
        with pytest.raises(ValidationError):
            DecideWorkspaceRequestBody(
                action="approve", granted_percent_discount=-1
            )

    def test_discount_at_boundary(self):
        body_0 = DecideWorkspaceRequestBody(
            action="approve", granted_percent_discount=0
        )
        body_100 = DecideWorkspaceRequestBody(
            action="approve", granted_percent_discount=100
        )
        assert body_0.granted_percent_discount == 0
        assert body_100.granted_percent_discount == 100

    def test_invalid_discount_type(self):
        with pytest.raises(ValidationError):
            DecideWorkspaceRequestBody(
                action="approve", granted_type_discount="employee"
            )


class TestDecideResponseModel:
    def test_approve_response(self):
        resp = DecideWorkspaceRequestResponse(
            id="req-1", status="approved", resulting_workspace_id="ws-new"
        )
        assert resp.resulting_workspace_id == "ws-new"

    def test_deny_response(self):
        resp = DecideWorkspaceRequestResponse(id="req-1", status="denied")
        assert resp.resulting_workspace_id is None


# ── Create workspace for request ──


class TestCreateWorkspaceForRequest:
    @pytest.mark.asyncio
    async def test_creates_workspace_with_correct_fields(self):
        req = _make_pending_request(
            proposed_name="  My WS  ",
            proposed_visibility="private",
        )
        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock) as mock_owc,
        ):
            mock_directus.create_item = AsyncMock(return_value={"data": {}})

            ws_id = await _create_workspace_for_request(
                req, granted_tier="pioneer", staff_user_id="staff-1"
            )

        assert ws_id is not None
        create_call = mock_directus.create_item.call_args_list[0]
        ws_data = create_call[0][1]
        assert ws_data["org_id"] == "org-1"
        assert ws_data["name"] == "My WS"
        assert ws_data["tier"] == "pioneer"
        assert ws_data["visibility"] == "private"
        assert ws_data["created_by"] == "user-1"
        mock_owc.assert_awaited_once_with(
            workspace_id=ws_id,
            creator_app_user_id="user-1",
        )

    @pytest.mark.asyncio
    async def test_applies_discount_and_expiry(self):
        req = _make_pending_request()
        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
        ):
            mock_directus.create_item = AsyncMock(return_value={"data": {}})

            await _create_workspace_for_request(
                req,
                granted_tier="pilot",
                staff_user_id="staff-1",
                granted_tier_expires_at="2026-06-11T00:00:00Z",
                granted_type_discount="scholarship",
                granted_percent_discount=50,
            )

        ws_data = mock_directus.create_item.call_args_list[0][0][1]
        assert ws_data["tier_expires_at"] == "2026-06-11T00:00:00Z"
        assert ws_data["type_discount"] == "scholarship"
        assert ws_data["percent_discount"] == 50

    @pytest.mark.asyncio
    async def test_untitled_fallback(self):
        req = _make_pending_request(proposed_name=None)
        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
        ):
            mock_directus.create_item = AsyncMock(return_value={"data": {}})

            await _create_workspace_for_request(
                req, granted_tier="innovator", staff_user_id="staff-1"
            )

        ws_data = mock_directus.create_item.call_args_list[0][0][1]
        assert ws_data["name"] == "Untitled"


# ── Upgrade workspace for request ──


class TestUpgradeWorkspaceForRequest:
    @pytest.mark.asyncio
    async def test_upgrade_tier(self):
        req = _make_pending_request(
            kind="tier_upgrade", workspace_id="ws-1"
        )
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_item = AsyncMock(return_value={
                "id": "ws-1", "tier": "pilot", "org_id": "org-1",
            })
            mock_directus.update_item = AsyncMock()
            with (
                patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock),
                patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock),
            ):
                result = await _upgrade_workspace_for_request(
                    req, granted_tier="pioneer", staff_user_id="staff-1"
                )

        # Helper now returns (workspace_id, workspace_name).
        assert result[0] == "ws-1"
        update_call = mock_directus.update_item.call_args
        assert update_call[0][0] == "workspace"
        assert update_call[0][1] == "ws-1"
        ws_update = update_call[0][2]
        assert ws_update["tier"] == "pioneer"
        assert ws_update.get("downgraded_at") is None
        assert ws_update.get("downgraded_from_tier") is None

    @pytest.mark.asyncio
    async def test_upgrade_with_discount_and_expiry(self):
        req = _make_pending_request(
            kind="tier_upgrade", workspace_id="ws-1"
        )
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_item = AsyncMock(return_value={
                "id": "ws-1", "tier": "pilot", "org_id": "org-1",
            })
            mock_directus.update_item = AsyncMock()
            with (
                patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock),
                patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock),
            ):
                await _upgrade_workspace_for_request(
                    req,
                    granted_tier="innovator",
                    staff_user_id="staff-1",
                    granted_tier_expires_at="2026-07-01T00:00:00Z",
                    granted_type_discount="staff_discount",
                    granted_percent_discount=10,
                )

        ws_update = mock_directus.update_item.call_args[0][2]
        assert ws_update["tier_expires_at"] == "2026-07-01T00:00:00Z"
        assert ws_update["type_discount"] == "staff_discount"
        assert ws_update["percent_discount"] == 10

    @pytest.mark.asyncio
    async def test_downgrade_applies_effects(self):
        req = _make_pending_request(
            kind="tier_upgrade", workspace_id="ws-1"
        )
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_item = AsyncMock(return_value={
                "id": "ws-1", "tier": "innovator", "org_id": "org-1",
            })
            mock_directus.update_item = AsyncMock()
            with (
                patch(
                    "dembrane.tier_downgrade.apply_downgrade_effects",
                    new_callable=AsyncMock,
                    return_value=[{"policy": "workspace:whitelabel", "human": "Whitelabel removed"}],
                ) as mock_downgrade,
                patch("dembrane.cache_utils.invalidate_workspace_usage", new_callable=AsyncMock),
                patch("dembrane.cache_utils.invalidate_org_usage", new_callable=AsyncMock),
            ):
                await _upgrade_workspace_for_request(
                    req, granted_tier="pilot", staff_user_id="staff-1"
                )

        mock_downgrade.assert_awaited_once_with("ws-1", "innovator", "pilot")
        ws_update = mock_directus.update_item.call_args[0][2]
        assert ws_update["downgraded_from_tier"] == "innovator"
        assert ws_update["downgraded_at"] is not None

    @pytest.mark.asyncio
    async def test_same_tier_is_no_change(self):
        req = _make_pending_request(
            kind="tier_upgrade", workspace_id="ws-1"
        )
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_item = AsyncMock(return_value={
                "id": "ws-1", "tier": "pioneer", "org_id": "org-1",
            })
            mock_directus.update_item = AsyncMock()

            await _upgrade_workspace_for_request(
                req, granted_tier="pioneer", staff_user_id="staff-1"
            )

        ws_update = mock_directus.update_item.call_args[0][2]
        assert ws_update["tier"] == "pioneer"
        assert "downgraded_at" not in ws_update
        assert "downgraded_from_tier" not in ws_update

    @pytest.mark.asyncio
    async def test_workspace_not_found_raises_404(self):
        req = _make_pending_request(
            kind="tier_upgrade", workspace_id="ws-missing"
        )
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_item = AsyncMock(return_value=None)
            from fastapi import HTTPException

            with pytest.raises(HTTPException) as exc:
                await _upgrade_workspace_for_request(
                    req, granted_tier="innovator", staff_user_id="staff-1"
                )
            assert exc.value.status_code == 404

    @pytest.mark.asyncio
    async def test_deleted_workspace_raises_404(self):
        req = _make_pending_request(
            kind="tier_upgrade", workspace_id="ws-del"
        )
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_item = AsyncMock(return_value={
                "id": "ws-del", "tier": "pilot", "deleted_at": "2026-05-01T00:00:00Z",
            })
            from fastapi import HTTPException

            with pytest.raises(HTTPException) as exc:
                await _upgrade_workspace_for_request(
                    req, granted_tier="innovator", staff_user_id="staff-1"
                )
            assert exc.value.status_code == 404


# ── Endpoint integration tests (mocked Directus) ──


class TestDecideEndpointApprove:
    """Integration-style tests: call decide_workspace_request with mocked deps."""

    @pytest.mark.asyncio
    async def test_approve_new_workspace_sets_fields(self):
        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(
            action="approve",
            granted_tier="pioneer",
            staff_notes="Looks good",
        )
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        pending_req = _make_pending_request(kind="new_workspace")

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
            patch("dembrane.api.v2.admin._create_workspace_for_request", new_callable=AsyncMock, return_value="ws-new") as _mock_create,
        ):
            mock_directus.get_item = AsyncMock(
                side_effect=[
                    pending_req,
                    _refresh_after_claim(pending_req, decided_status="approved"),
                ]
            )
            mock_directus.update_item = AsyncMock()

            result = await decide_workspace_request("req-1", body, auth, BackgroundTasks())

        assert result.status == "approved"
        assert result.resulting_workspace_id == "ws-new"
        calls = mock_directus.update_item.call_args_list
        assert len(calls) == 2
        claim = calls[0][0][2]
        assert claim["status"] == "approved"
        assert claim["decided_by"] == "staff-1"
        assert claim["decided_at"] is not None
        assert claim["staff_notes"] == "Looks good"
        finalize = calls[1][0][2]
        assert finalize["granted_tier"] == "pioneer"
        assert finalize["resulting_workspace_id"] == "ws-new"

    @pytest.mark.asyncio
    async def test_approve_tier_upgrade(self):
        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(action="approve", granted_tier="innovator")
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        pending_req = _make_pending_request(
            kind="tier_upgrade", workspace_id="ws-1",
        )

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
            patch("dembrane.api.v2.admin._upgrade_workspace_for_request", new_callable=AsyncMock, return_value=("ws-1", "Existing WS")) as mock_upgrade,
        ):
            mock_directus.get_item = AsyncMock(
                side_effect=[
                    pending_req,
                    _refresh_after_claim(pending_req, decided_status="approved"),
                ]
            )
            mock_directus.update_item = AsyncMock()

            result = await decide_workspace_request("req-1", body, auth, BackgroundTasks())

        assert result.status == "approved"
        assert result.resulting_workspace_id == "ws-1"
        mock_upgrade.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_approve_defaults_to_proposed_tier(self):
        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(action="approve")
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        pending_req = _make_pending_request(
            kind="new_workspace", proposed_tier="changemaker",
        )

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
            patch("dembrane.api.v2.admin._create_workspace_for_request", new_callable=AsyncMock, return_value="ws-new") as _mock_create,
        ):
            mock_directus.get_item = AsyncMock(
                side_effect=[
                    pending_req,
                    _refresh_after_claim(pending_req, decided_status="approved"),
                ]
            )
            mock_directus.update_item = AsyncMock()

            _result = await decide_workspace_request("req-1", body, auth, BackgroundTasks())

        call_kwargs = _mock_create.call_args
        assert call_kwargs[1]["granted_tier"] == "changemaker"

    @pytest.mark.asyncio
    async def test_already_decided_returns_409(self):
        from fastapi import HTTPException

        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(action="approve")
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        decided_req = {**_make_pending_request(), "status": "approved"}

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
        ):
            mock_directus.get_item = AsyncMock(return_value=decided_req)

            with pytest.raises(HTTPException) as exc:
                await decide_workspace_request("req-1", body, auth, BackgroundTasks())
            assert exc.value.status_code == 409

    @pytest.mark.asyncio
    async def test_not_found_returns_404(self):
        from fastapi import HTTPException

        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(action="approve")
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
        ):
            mock_directus.get_item = AsyncMock(return_value=None)

            with pytest.raises(HTTPException) as exc:
                await decide_workspace_request("req-missing", body, auth, BackgroundTasks())
            assert exc.value.status_code == 404

    @pytest.mark.asyncio
    async def test_non_staff_returns_403(self):
        from fastapi import HTTPException

        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(action="approve")
        auth = MagicMock()
        auth.is_admin = False

        with pytest.raises(HTTPException) as exc:
            await decide_workspace_request("req-1", body, auth, BackgroundTasks())
        assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_unknown_tier_returns_400(self):
        from fastapi import HTTPException

        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(action="approve", granted_tier="platinum")
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        pending_req = _make_pending_request()

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
        ):
            mock_directus.get_item = AsyncMock(
                side_effect=[
                    pending_req,
                    _refresh_after_claim(pending_req, decided_status="approved"),
                ]
            )
            mock_directus.update_item = AsyncMock()

            with pytest.raises(HTTPException) as exc:
                await decide_workspace_request("req-1", body, auth, BackgroundTasks())
            assert exc.value.status_code == 400

    @pytest.mark.asyncio
    async def test_tier_upgrade_missing_workspace_id_returns_400(self):
        from fastapi import HTTPException

        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(action="approve")
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        pending_req = _make_pending_request(kind="tier_upgrade", workspace_id=None)

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
        ):
            mock_directus.get_item = AsyncMock(
                side_effect=[
                    pending_req,
                    _refresh_after_claim(pending_req, decided_status="approved"),
                ]
            )
            mock_directus.update_item = AsyncMock()

            with pytest.raises(HTTPException) as exc:
                await decide_workspace_request("req-1", body, auth, BackgroundTasks())
            assert exc.value.status_code == 400


class TestDecideEndpointDeny:
    @pytest.mark.asyncio
    async def test_deny_sets_fields(self):
        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(
            action="deny", denial_reason="Not enough context"
        )
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        pending_req = _make_pending_request()

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
        ):
            mock_directus.get_item = AsyncMock(
                side_effect=[
                    pending_req,
                    _refresh_after_claim(pending_req, decided_status="denied"),
                ]
            )
            mock_directus.update_item = AsyncMock()

            result = await decide_workspace_request("req-1", body, auth, BackgroundTasks())

        assert result.status == "denied"
        assert result.resulting_workspace_id is None
        calls = mock_directus.update_item.call_args_list
        assert len(calls) == 2
        claim = calls[0][0][2]
        assert claim["status"] == "denied"
        assert claim["denial_reason"] == "Not enough context"
        assert claim["decided_by"] == "staff-1"
        assert claim["decided_at"] is not None
        assert calls[1][0][2] == {}

    @pytest.mark.asyncio
    async def test_deny_empty_reason_returns_400(self):
        from fastapi import HTTPException

        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(action="deny", denial_reason="   ")
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        pending_req = _make_pending_request()

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
        ):
            mock_directus.get_item = AsyncMock(return_value=pending_req)

            with pytest.raises(HTTPException) as exc:
                await decide_workspace_request("req-1", body, auth, BackgroundTasks())
            assert exc.value.status_code == 400

    @pytest.mark.asyncio
    async def test_deny_no_reason_returns_400(self):
        from fastapi import HTTPException

        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(action="deny")
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        pending_req = _make_pending_request()

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
        ):
            mock_directus.get_item = AsyncMock(return_value=pending_req)

            with pytest.raises(HTTPException) as exc:
                await decide_workspace_request("req-1", body, auth, BackgroundTasks())
            assert exc.value.status_code == 400

    @pytest.mark.asyncio
    async def test_deny_with_staff_notes(self):
        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(
            action="deny",
            denial_reason="Denied",
            staff_notes="Internal: check credit history",
        )
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        pending_req = _make_pending_request()

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
        ):
            mock_directus.get_item = AsyncMock(
                side_effect=[
                    pending_req,
                    _refresh_after_claim(pending_req, decided_status="denied"),
                ]
            )
            mock_directus.update_item = AsyncMock()

            _result = await decide_workspace_request("req-1", body, auth, BackgroundTasks())

        claim = mock_directus.update_item.call_args_list[0][0][2]
        assert claim["staff_notes"] == "Internal: check credit history"

    @pytest.mark.asyncio
    async def test_deny_already_decided_returns_409(self):
        from fastapi import HTTPException

        from dembrane.api.v2.admin import decide_workspace_request

        body = DecideWorkspaceRequestBody(
            action="deny", denial_reason="Too late"
        )
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        decided_req = {**_make_pending_request(), "status": "denied"}

        with (
            patch("dembrane.api.v2.admin.async_directus") as mock_directus,
            patch("dembrane.app_user.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
        ):
            mock_directus.get_item = AsyncMock(return_value=decided_req)

            with pytest.raises(HTTPException) as exc:
                await decide_workspace_request("req-1", body, auth, BackgroundTasks())
            assert exc.value.status_code == 409


# ── Staff-only POST /v2/workspaces ──


class TestWorkspaceCreateStaffOnly:
    """POST /v2/workspaces now returns 403 for non-staff."""

    @pytest.mark.asyncio
    async def test_non_staff_gets_403(self):
        from fastapi import HTTPException

        from dembrane.api.v2.schemas import CreateWorkspaceRequest
        from dembrane.api.v2.workspaces import create_workspace

        body = CreateWorkspaceRequest(name="Test")
        auth = MagicMock()
        auth.is_admin = False

        with pytest.raises(HTTPException) as exc:
            await create_workspace(body, auth)
        assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_staff_can_create(self):
        from dembrane.api.v2.schemas import CreateWorkspaceRequest
        from dembrane.api.v2.workspaces import create_workspace

        body = CreateWorkspaceRequest(name="Test WS", org_id="org-1")
        auth = MagicMock()
        auth.is_admin = True
        auth.user_id = "directus-staff-1"

        with (
            patch("dembrane.api.v2.workspaces.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "staff-1"}),
            patch("dembrane.api.v2.workspaces.async_directus") as mock_directus,
            patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
            patch("dembrane.notifications.emit_to_audience", new_callable=AsyncMock),
            patch("dembrane.notifications.audience_organisation_admins", new_callable=AsyncMock, return_value=[]),
        ):
            mock_directus.create_item = AsyncMock(return_value={"data": {}})
            mock_directus.get_item = AsyncMock(return_value={"display_name": "Staff"})

            result = await create_workspace(body, auth)

        assert result.name == "Test WS"
        assert result.org_id == "org-1"
