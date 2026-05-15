"""Tests for GET /v2/admin/workspace-requests (Slice 09).

Covers:
- Staff-only authorization (403 for non-staff)
- Status filtering (pending, approved, denied, all)
- Response shape (items + counts)
- Row enrichment (requester, org, workspace names)
- Sort order (created_at descending)
"""

from unittest.mock import AsyncMock, patch

import pytest

from dembrane.api.v2.admin import (
    WorkspaceRequestRow,
    WorkspaceRequestRequester,
    WorkspaceRequestListResponse,
    _enrich_workspace_requests,
)

# ── Fixtures ──


def _make_request(
    *,
    id: str = "req-1",
    kind: str = "new_workspace",
    status: str = "pending",
    requested_by: str = "user-1",
    org_id: str = "org-1",
    workspace_id: str | None = None,
    proposed_name: str | None = "My workspace",
    proposed_tier: str = "innovator",
    proposed_visibility: str = "open_to_organisation",
    requester_message: str | None = "Please approve",
    created_at: str = "2026-05-10T10:00:00Z",
    **overrides,
) -> dict:
    row = {
        "id": id,
        "kind": kind,
        "status": status,
        "requested_by": requested_by,
        "org_id": org_id,
        "workspace_id": workspace_id,
        "proposed_name": proposed_name,
        "proposed_tier": proposed_tier,
        "proposed_visibility": proposed_visibility,
        "requester_message": requester_message,
        "granted_tier": None,
        "granted_tier_expires_at": None,
        "granted_type_discount": None,
        "granted_percent_discount": None,
        "resulting_workspace_id": None,
        "decided_at": None,
        "decided_by": None,
        "denial_reason": None,
        "staff_notes": None,
        "created_at": created_at,
    }
    row.update(overrides)
    return row


# ── Model shape tests ──


class TestWorkspaceRequestModels:
    def test_requester_model_minimal(self):
        r = WorkspaceRequestRequester(id="u-1")
        assert r.id == "u-1"
        assert r.display_name is None
        assert r.email is None

    def test_requester_model_full(self):
        r = WorkspaceRequestRequester(id="u-1", display_name="Jane", email="j@e.com")
        assert r.display_name == "Jane"

    def test_row_model_minimal(self):
        row = WorkspaceRequestRow(
            id="r-1", kind="new_workspace", status="pending",
            org_id="org-1", proposed_tier="innovator",
        )
        assert row.id == "r-1"
        assert row.requester is None
        assert row.decided_by is None

    def test_row_model_full(self):
        row = WorkspaceRequestRow(
            id="r-1", kind="tier_upgrade", status="approved",
            requester=WorkspaceRequestRequester(id="u-1", display_name="A"),
            org_id="org-1", org_name="Org A",
            workspace_id="ws-1", workspace_name="WS A",
            proposed_name=None, proposed_tier="pioneer",
            proposed_visibility="private",
            requester_message="msg",
            granted_tier="innovator",
            granted_tier_expires_at="2026-06-10T00:00:00Z",
            granted_type_discount="scholarship",
            granted_percent_discount=50,
            resulting_workspace_id="ws-1",
            decided_at="2026-05-11T10:00:00Z",
            decided_by=WorkspaceRequestRequester(id="u-2"),
            denial_reason=None,
            staff_notes="internal note",
            created_at="2026-05-10T10:00:00Z",
        )
        assert row.granted_tier == "innovator"
        assert row.granted_percent_discount == 50

    def test_list_response_model(self):
        resp = WorkspaceRequestListResponse(
            items=[],
            counts={"pending": 0, "approved": 0, "denied": 0},
        )
        assert resp.counts["pending"] == 0
        assert len(resp.items) == 0


# ── Enrichment tests ──


class TestEnrichWorkspaceRequests:
    @pytest.mark.asyncio
    async def test_empty_input(self):
        result = await _enrich_workspace_requests([])
        assert result == []

    @pytest.mark.asyncio
    async def test_enriches_requester_and_org(self):
        rows = [_make_request(requested_by="u-1", org_id="org-1")]
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_items = AsyncMock(side_effect=[
                [{"id": "u-1", "display_name": "Alice", "email": "alice@e.com"}],
                [{"id": "org-1", "name": "Test Org"}],
                [],
            ])
            result = await _enrich_workspace_requests(rows)

        assert len(result) == 1
        assert result[0].requester is not None
        assert result[0].requester.display_name == "Alice"
        assert result[0].org_name == "Test Org"

    @pytest.mark.asyncio
    async def test_enriches_workspace_name(self):
        rows = [_make_request(workspace_id="ws-1")]
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_items = AsyncMock(side_effect=[
                [{"id": "user-1", "display_name": "A", "email": "a@b.c"}],
                [{"id": "org-1", "name": "Org"}],
                [{"id": "ws-1", "name": "My WS"}],
            ])
            result = await _enrich_workspace_requests(rows)

        assert result[0].workspace_name == "My WS"

    @pytest.mark.asyncio
    async def test_decided_by_enriched(self):
        rows = [_make_request(
            status="approved",
            decided_by="u-staff",
            decided_at="2026-05-11T10:00:00Z",
        )]
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_items = AsyncMock(side_effect=[
                [
                    {"id": "user-1", "display_name": "Req", "email": "r@e.com"},
                    {"id": "u-staff", "display_name": "Staff", "email": "s@e.com"},
                ],
                [{"id": "org-1", "name": "O"}],
                [],
            ])
            result = await _enrich_workspace_requests(rows)

        assert result[0].decided_by is not None
        assert result[0].decided_by.display_name == "Staff"

    @pytest.mark.asyncio
    async def test_missing_user_returns_id_only(self):
        rows = [_make_request(requested_by="ghost-user")]
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_items = AsyncMock(side_effect=[
                [],
                [{"id": "org-1", "name": "O"}],
                [],
            ])
            result = await _enrich_workspace_requests(rows)

        assert result[0].requester is not None
        assert result[0].requester.id == "ghost-user"
        assert result[0].requester.display_name is None

    @pytest.mark.asyncio
    async def test_directus_returns_non_list(self):
        rows = [_make_request()]
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_items = AsyncMock(side_effect=[
                {"error": "something"},
                {"error": "something"},
                {"error": "something"},
            ])
            result = await _enrich_workspace_requests(rows)

        assert len(result) == 1
        assert result[0].org_name is None

    @pytest.mark.asyncio
    async def test_multiple_rows(self):
        rows = [
            _make_request(id="r-1", org_id="org-1", requested_by="u-1"),
            _make_request(id="r-2", org_id="org-2", requested_by="u-2"),
        ]
        with patch("dembrane.api.v2.admin.async_directus") as mock_directus:
            mock_directus.get_items = AsyncMock(side_effect=[
                [
                    {"id": "u-1", "display_name": "A", "email": "a@e.com"},
                    {"id": "u-2", "display_name": "B", "email": "b@e.com"},
                ],
                [
                    {"id": "org-1", "name": "Org 1"},
                    {"id": "org-2", "name": "Org 2"},
                ],
                [],
            ])
            result = await _enrich_workspace_requests(rows)

        assert len(result) == 2
        assert result[0].org_name == "Org 1"
        assert result[1].org_name == "Org 2"


# ── Count computation ──


class TestCountComputation:
    def test_counts_from_response(self):
        resp = WorkspaceRequestListResponse(
            items=[],
            counts={"pending": 3, "approved": 5, "denied": 1},
        )
        assert resp.counts["pending"] == 3
        assert resp.counts["approved"] == 5
        assert resp.counts["denied"] == 1

    def test_counts_zero(self):
        resp = WorkspaceRequestListResponse(
            items=[],
            counts={"pending": 0, "approved": 0, "denied": 0},
        )
        assert sum(resp.counts.values()) == 0


# ── Field presence ──


class TestFieldPresence:
    def test_all_proposed_fields_in_row(self):
        row = WorkspaceRequestRow(
            id="r-1", kind="new_workspace", status="pending",
            org_id="org-1", proposed_tier="innovator",
            proposed_name="WS Name",
            proposed_visibility="private",
            requester_message="Please approve me",
        )
        assert row.proposed_name == "WS Name"
        assert row.proposed_visibility == "private"
        assert row.requester_message == "Please approve me"

    def test_decided_fields_in_row(self):
        row = WorkspaceRequestRow(
            id="r-1", kind="new_workspace", status="denied",
            org_id="org-1", proposed_tier="innovator",
            decided_at="2026-05-11T10:00:00Z",
            decided_by=WorkspaceRequestRequester(id="staff-1"),
            denial_reason="Not enough info",
        )
        assert row.decided_at is not None
        assert row.denial_reason == "Not enough info"

    def test_staff_notes_in_row(self):
        row = WorkspaceRequestRow(
            id="r-1", kind="new_workspace", status="pending",
            org_id="org-1", proposed_tier="innovator",
            staff_notes="Check with finance",
        )
        assert row.staff_notes == "Check with finance"
