"""Unit tests for inheritance.is_org_external_only (external-lockdown spec)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from dembrane.inheritance import is_org_external_only

_ORG = "org-1"
_USER = "user-1"


def _mock(*, org_role: str | None, ws_roles: list[str], org_ws_ids: list[str] | None = None) -> AsyncMock:
    """Branch-aware async_directus mock for the inheritance module.

    Calls in order: org_membership (role) -> workspace (ids) -> workspace_membership (roles).
    """
    ids = org_ws_ids if org_ws_ids is not None else (["ws-1"] if ws_roles else [])

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
        (None, ["external"], True),
        ("member", ["external"], True),
        ("member", ["member", "external"], False),
        ("member", [], False),
        ("billing", ["external"], False),
        ("admin", ["external"], False),
        ("owner", ["external"], False),
        (None, [], False),
    ],
)
async def test_is_org_external_only_truth_table(org_role, ws_roles, expected):
    with patch("dembrane.inheritance.async_directus", _mock(org_role=org_role, ws_roles=ws_roles)):
        assert await is_org_external_only(_ORG, _USER) is expected
