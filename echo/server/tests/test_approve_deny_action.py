"""Tests for self-serve workspace creation (POST /v2/workspaces).

The staff workspace_request approval flow has been retired; creation is now
self-serve. Covers:
- org admins/owners (and staff in any org) can create
- non-members get 403
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestWorkspaceCreate:
    """Self-serve creation: org admins/owners can create; staff in any org;
    non-members get 403."""

    @pytest.mark.asyncio
    async def test_non_member_gets_403(self):
        from fastapi import HTTPException

        from dembrane.api.v2.schemas import CreateWorkspaceRequest
        from dembrane.api.v2.workspaces import create_workspace

        body = CreateWorkspaceRequest(name="Test", org_id="org-x")
        auth = MagicMock()
        auth.is_admin = False
        auth.user_id = "du-1"

        with (
            patch("dembrane.api.v2.workspaces.get_app_user_or_raise", new_callable=AsyncMock, return_value={"id": "u-1"}),
            patch("dembrane.api.v2.workspaces.async_directus") as mock_directus,
        ):
            # Not an admin/owner of org-x.
            mock_directus.get_items = AsyncMock(return_value=[])
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
            patch("dembrane.directus_async.async_directus") as mock_ba,
            patch("dembrane.inheritance.on_workspace_created", new_callable=AsyncMock),
            patch("dembrane.notifications.emit_to_audience", new_callable=AsyncMock),
            patch("dembrane.notifications.audience_organisation_admins", new_callable=AsyncMock, return_value=[]),
        ):
            mock_directus.create_item = AsyncMock(return_value={"data": {}})
            mock_directus.get_item = AsyncMock(return_value={"display_name": "Staff"})
            # Account creation goes through the billing_account module; the org
            # has no account yet, so get_items returns [] -> org-scoped created.
            mock_ba.get_items = AsyncMock(return_value=[])
            mock_ba.create_item = AsyncMock(return_value={"data": {}})
            mock_ba.update_item = AsyncMock()

            result = await create_workspace(body, auth)

        assert result.name == "Test WS"
        assert result.org_id == "org-1"
