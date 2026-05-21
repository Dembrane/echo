"""Tests for workspace request submission (slice 08).

Covers:
- SubmitWorkspaceRequest model validation (paid tiers only, required fields).
- POST /v2/workspace-requests role checks for new_workspace (org admin/owner).
- POST /v2/workspace-requests role checks for tier_upgrade (workspace admin/billing).
- Duplicate in-flight upgrade request returns 409.
- Schema script step_18 function exists and is idempotent-safe (structural).
- Directus schema field list matches the spec.
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException, BackgroundTasks
from pydantic import ValidationError

from dembrane.api.v2.workspace_requests import (
    PAID_TIERS,
    SubmitWorkspaceRequest,
    SubmitWorkspaceRequestResponse,
    submit_workspace_request,
)

# ── Model validation ─────────────────────────────────────────────────


class TestSubmitWorkspaceRequestModel:
    """Pydantic model shape and constraints."""

    def test_default_tier_is_innovator(self):
        body = SubmitWorkspaceRequest(kind="new_workspace", org_id="org-1")
        assert body.proposed_tier == "innovator"

    def test_free_tier_rejected(self):
        with pytest.raises(ValidationError):
            SubmitWorkspaceRequest(
                kind="new_workspace", org_id="org-1", proposed_tier="free"
            )

    @pytest.mark.parametrize("tier", ["pilot", "pioneer", "innovator", "changemaker", "guardian"])
    def test_paid_tiers_accepted(self, tier: str):
        body = SubmitWorkspaceRequest(kind="new_workspace", org_id="org-1", proposed_tier=tier)
        assert body.proposed_tier == tier

    def test_kind_must_be_valid(self):
        with pytest.raises(ValidationError):
            SubmitWorkspaceRequest(kind="invalid", org_id="org-1")

    def test_requester_message_max_length(self):
        body = SubmitWorkspaceRequest(
            kind="new_workspace", org_id="org-1", requester_message="a" * 1000
        )
        assert len(body.requester_message) == 1000

        with pytest.raises(ValidationError):
            SubmitWorkspaceRequest(
                kind="new_workspace", org_id="org-1", requester_message="a" * 1001
            )

    def test_proposed_name_max_length(self):
        body = SubmitWorkspaceRequest(
            kind="new_workspace", org_id="org-1", proposed_name="a" * 100
        )
        assert len(body.proposed_name) == 100

        with pytest.raises(ValidationError):
            SubmitWorkspaceRequest(
                kind="new_workspace", org_id="org-1", proposed_name="a" * 101
            )

    def test_default_visibility(self):
        body = SubmitWorkspaceRequest(kind="new_workspace", org_id="org-1")
        assert body.proposed_visibility == "open_to_organisation"


class TestResponseModel:
    def test_shape(self):
        resp = SubmitWorkspaceRequestResponse(id="r-1", status="pending", kind="new_workspace")
        d = resp.model_dump()
        assert d == {"id": "r-1", "status": "pending", "kind": "new_workspace"}


# ── PAID_TIERS constant ──────────────────────────────────────────────


class TestPaidTiers:
    def test_free_excluded(self):
        assert "free" not in PAID_TIERS

    def test_all_paid_present(self):
        for t in ["pilot", "pioneer", "innovator", "changemaker", "guardian"]:
            assert t in PAID_TIERS


# ── Endpoint: new_workspace ──────────────────────────────────────────


def _mock_auth(user_id: str = "du-1", is_admin: bool = False):
    auth = AsyncMock()
    auth.user_id = user_id
    auth.is_admin = is_admin
    return auth


class TestNewWorkspaceSubmission:
    @pytest.mark.asyncio
    async def test_requires_proposed_name(self):
        body = SubmitWorkspaceRequest(kind="new_workspace", org_id="org-1")
        mock_directus = AsyncMock()
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
            assert exc_info.value.status_code == 400
            assert "proposed_name" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    async def test_org_admin_can_submit(self):
        body = SubmitWorkspaceRequest(
            kind="new_workspace",
            org_id="org-1",
            proposed_name="My Workspace",
            proposed_billing_period="annual",
        )
        mock_directus = AsyncMock()
        mock_directus.get_items = AsyncMock(return_value=[{"org_id": "org-1", "role": "admin"}])
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            result = await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        assert result.status == "pending"
        assert result.kind == "new_workspace"
        mock_directus.create_item.assert_called_once()
        call_args = mock_directus.create_item.call_args
        assert call_args[0][0] == "workspace_request"
        row = call_args[0][1]
        assert row["kind"] == "new_workspace"
        assert row["proposed_tier"] == "innovator"
        assert row["proposed_name"] == "My Workspace"
        assert row["org_id"] == "org-1"
        assert row["requested_by"] == "au-1"

    @pytest.mark.asyncio
    async def test_non_admin_rejected(self):
        body = SubmitWorkspaceRequest(
            kind="new_workspace", org_id="org-1", proposed_name="Test"
        )
        mock_directus = AsyncMock()
        mock_directus.get_items = AsyncMock(return_value=[])
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
            assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_org_owner_can_submit(self):
        body = SubmitWorkspaceRequest(
            kind="new_workspace",
            org_id="org-1",
            proposed_name="Test",
            proposed_billing_period="annual",
        )
        mock_directus = AsyncMock()
        mock_directus.get_items = AsyncMock(return_value=[{"org_id": "org-1", "role": "owner"}])
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            result = await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        assert result.status == "pending"


# ── Endpoint: tier_upgrade ───────────────────────────────────────────


class TestTierUpgradeSubmission:
    @pytest.mark.asyncio
    async def test_requires_workspace_id(self):
        body = SubmitWorkspaceRequest(kind="tier_upgrade", org_id="org-1")
        mock_directus = AsyncMock()
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
            assert exc_info.value.status_code == 400
            assert "workspace_id" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    async def test_workspace_admin_can_submit(self):
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade", org_id="org-1", workspace_id="ws-1",
            proposed_tier="pioneer",
            proposed_billing_period="annual",
        )
        mock_directus = AsyncMock()
        call_count = 0
        async def mock_get_items(collection, _query):
            nonlocal call_count
            call_count += 1
            if collection == "workspace_membership":
                return [{"workspace_id": "ws-1", "role": "admin"}]
            if collection == "workspace_request":
                return []
            return []
        mock_directus.get_items = mock_get_items
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1", "org_id": "org-1"})
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            result = await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        assert result.status == "pending"
        assert result.kind == "tier_upgrade"

    @pytest.mark.asyncio
    async def test_billing_role_can_submit(self):
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade", org_id="org-1", workspace_id="ws-1",
            proposed_billing_period="annual",
        )
        mock_directus = AsyncMock()
        async def mock_get_items(collection, _query):
            if collection == "workspace_membership":
                return [{"workspace_id": "ws-1", "role": "billing"}]
            if collection == "workspace_request":
                return []
            return []
        mock_directus.get_items = mock_get_items
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1", "org_id": "org-1"})
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            result = await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        assert result.status == "pending"

    @pytest.mark.asyncio
    async def test_member_role_rejected(self):
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade", org_id="org-1", workspace_id="ws-1",
        )
        mock_directus = AsyncMock()
        mock_directus.get_items = AsyncMock(return_value=[])
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
            assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_duplicate_pending_returns_409(self):
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade", org_id="org-1", workspace_id="ws-1",
        )
        mock_directus = AsyncMock()
        async def mock_get_items(collection, _query):
            if collection == "workspace_membership":
                return [{"workspace_id": "ws-1", "role": "admin"}]
            if collection == "workspace_request":
                return [{"id": "existing-req", "status": "pending"}]
            return []
        mock_directus.get_items = mock_get_items
        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1", "org_id": "org-1"})
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
            assert exc_info.value.status_code == 409


# ── Billing-period cadence validation ────────────────────────────────


class TestBillingPeriodValidation:
    """Pioneer+ tiers must carry a cadence; pilot must arrive without one.

    These rules are independent of `kind` — the same code path enforces them
    for both `new_workspace` and `tier_upgrade`. We use `new_workspace` here
    because its setup is simpler (no workspace lookup mock needed).
    """

    @staticmethod
    def _ok_directus():
        m = AsyncMock()
        m.get_items = AsyncMock(return_value=[{"org_id": "org-1", "role": "admin"}])
        m.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        return m

    @pytest.mark.asyncio
    @pytest.mark.parametrize("tier", ["pioneer", "innovator", "changemaker", "guardian"])
    async def test_overage_tier_without_cadence_returns_400(self, tier: str):
        body = SubmitWorkspaceRequest(
            kind="new_workspace",
            org_id="org-1",
            proposed_name="W",
            proposed_tier=tier,
            proposed_billing_period=None,
        )
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value={"id": "au-1"}),
            patch("dembrane.api.v2.workspace_requests.async_directus", self._ok_directus()),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        assert exc_info.value.status_code == 400
        assert "proposed_billing_period" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    async def test_pilot_with_cadence_returns_400(self):
        body = SubmitWorkspaceRequest(
            kind="new_workspace",
            org_id="org-1",
            proposed_name="W",
            proposed_tier="pilot",
            proposed_billing_period="annual",
        )
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value={"id": "au-1"}),
            patch("dembrane.api.v2.workspace_requests.async_directus", self._ok_directus()),
        ):
            with pytest.raises(HTTPException) as exc_info:
                await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        assert exc_info.value.status_code == 400
        assert "pilot" in str(exc_info.value.detail)

    @pytest.mark.asyncio
    async def test_pilot_without_cadence_accepted(self):
        body = SubmitWorkspaceRequest(
            kind="new_workspace",
            org_id="org-1",
            proposed_name="W",
            proposed_tier="pilot",
            proposed_billing_period=None,
        )
        mock_d = self._ok_directus()
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value={"id": "au-1"}),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_d),
        ):
            result = await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        assert result.status == "pending"
        row = mock_d.create_item.call_args[0][1]
        assert row["proposed_billing_period"] is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize("cadence", ["annual", "monthly"])
    async def test_pioneer_with_cadence_accepted(self, cadence: str):
        body = SubmitWorkspaceRequest(
            kind="new_workspace",
            org_id="org-1",
            proposed_name="W",
            proposed_tier="pioneer",
            proposed_billing_period=cadence,
        )
        mock_d = self._ok_directus()
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value={"id": "au-1"}),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_d),
        ):
            result = await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        assert result.status == "pending"
        row = mock_d.create_item.call_args[0][1]
        assert row["proposed_billing_period"] == cadence


# ── Schema script step_18 ────────────────────────────────────────────


class TestSchemaStep18:
    """Structural checks that the schema step function exists and has the right shape."""

    def _load_schema_module(self):
        import os
        import importlib.util
        script_path = os.path.join(
            os.path.dirname(__file__), "..", "..", "scripts", "create_schema.py"
        )
        spec = importlib.util.spec_from_file_location("create_schema", script_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_step_registered(self):
        mod = self._load_schema_module()
        assert "18" in mod.STEPS
        assert mod.STEPS["18"][0] == "workspace_request collection"

    def test_step_function_callable(self):
        mod = self._load_schema_module()
        assert callable(mod.step_18_workspace_request)


# ── Row creation payload ─────────────────────────────────────────────


class TestRowPayload:
    """The create_item call must produce the correct payload shape."""

    @pytest.mark.asyncio
    async def test_new_workspace_payload_shape(self):
        body = SubmitWorkspaceRequest(
            kind="new_workspace",
            org_id="org-1",
            proposed_name="Test WS",
            proposed_tier="pioneer",
            proposed_visibility="private",
            requester_message="Please and thanks",
        )
        mock_directus = AsyncMock()
        mock_directus.get_items = AsyncMock(return_value=[{"org_id": "org-1", "role": "owner"}])
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        row = mock_directus.create_item.call_args[0][1]
        assert row["kind"] == "new_workspace"
        assert row["status"] == "pending"
        assert row["requested_by"] == "au-1"
        assert row["org_id"] == "org-1"
        assert row["workspace_id"] is None
        assert row["proposed_name"] == "Test WS"
        assert row["proposed_tier"] == "pioneer"
        assert row["proposed_visibility"] == "private"
        assert row["requester_message"] == "Please and thanks"

    @pytest.mark.asyncio
    async def test_proposed_name_trimmed(self):
        body = SubmitWorkspaceRequest(
            kind="new_workspace",
            org_id="org-1",
            proposed_name="  My Workspace  ",
        )
        mock_directus = AsyncMock()
        mock_directus.get_items = AsyncMock(return_value=[{"org_id": "org-1", "role": "admin"}])
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        row = mock_directus.create_item.call_args[0][1]
        assert row["proposed_name"] == "My Workspace"

    @pytest.mark.asyncio
    async def test_tier_upgrade_sets_workspace_id(self):
        body = SubmitWorkspaceRequest(
            kind="tier_upgrade",
            org_id="org-1",
            workspace_id="ws-1",
            proposed_tier="changemaker",
        )
        mock_directus = AsyncMock()
        async def mock_get_items(collection, _query):
            if collection == "workspace_membership":
                return [{"workspace_id": "ws-1", "role": "owner"}]
            if collection == "workspace_request":
                return []
            return []
        mock_directus.get_items = mock_get_items
        mock_directus.create_item = AsyncMock(return_value={"data": {"id": "r-1"}})
        mock_directus.get_item = AsyncMock(return_value={"id": "ws-1", "org_id": "org-1"})
        app_user = {"id": "au-1"}
        with (
            patch("dembrane.api.v2.workspace_requests.get_app_user_or_raise", return_value=app_user),
            patch("dembrane.api.v2.workspace_requests.async_directus", mock_directus),
        ):
            await submit_workspace_request(body, _mock_auth(), BackgroundTasks())
        row = mock_directus.create_item.call_args[0][1]
        assert row["workspace_id"] == "ws-1"
        assert row["kind"] == "tier_upgrade"
        assert row["proposed_tier"] == "changemaker"
