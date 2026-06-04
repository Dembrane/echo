"""Unit tests for inheritance.is_org_billing_only (finance-only insider).

A biller must never be granted operational access from an access-request
approval. Two ways to be a biller in an org:
  - org_membership.role = 'billing' (org-level biller), or
  - workspace-scoped biller: only 'billing' workspace roles in the org and
    no operational role (member/admin/owner) anywhere in it.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from dembrane.inheritance import is_org_billing_only

_ORG = "org-1"
_USER = "user-1"


def _mock(*, org_role: str | None, ws_roles: list[str]) -> AsyncMock:
    """Branch-aware async_directus mock for the inheritance module.

    Calls in order: org_membership (role) -> workspace (ids) -> workspace_membership (roles).
    """
    ids = ["ws-1"] if ws_roles else []

    async def get_items(collection: str, _params: dict[str, Any]) -> list[dict[str, Any]]:
        if collection == "org_membership":
            return [{"role": org_role}] if org_role else []
        if collection == "workspace":
            return [{"id": wid} for wid in ids]
        if collection == "workspace_membership":
            return [{"role": r} for r in ws_roles]
        return []

    mock = AsyncMock()
    mock.get_items = AsyncMock(side_effect=get_items)
    return mock


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "org_role,ws_roles,expected",
    [
        # Org-level biller: always a biller, regardless of workspace rows.
        ("billing", [], True),
        ("billing", ["billing"], True),
        ("billing", ["member"], True),
        # Workspace-scoped biller (org member, only billing ws roles).
        ("member", ["billing"], True),
        ("member", ["billing", "billing"], True),
        # Mixed roles: operational somewhere -> not a pure biller.
        ("member", ["billing", "member"], False),
        ("member", ["member"], False),
        # Org-only member (ADR 0004): no ws roles, not a biller.
        ("member", [], False),
        # Admin/owner are never billers.
        ("admin", ["billing"], False),
        ("owner", ["billing"], False),
        # No org row: stale/edge states. Billing-only ws roles still a biller.
        (None, ["billing"], True),
        (None, [], False),
    ],
)
async def test_is_org_billing_only_truth_table(org_role, ws_roles, expected):
    with patch("dembrane.inheritance.async_directus", _mock(org_role=org_role, ws_roles=ws_roles)):
        assert await is_org_billing_only(_ORG, _USER) is expected
