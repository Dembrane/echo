"""Unit tests for inheritance.derive_workspace_role (the derived-access ladder).

This pure helper is the single source of truth for derived workspace access:
both user_can_access (per-pair) and _rollup_workspace_access (batched org-members
count) delegate to it. Direct membership is the callers' responsibility and is
NOT exercised here — this only covers the derived ladder.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from dembrane.inheritance import derive_workspace_role

_USER = "user-1"


def _ws(
    *,
    private: bool = False,
    inherit_members: bool = False,
    sticky: bool = False,
) -> dict[str, Any]:
    """Build a workspace row with the fields the ladder reads."""
    settings: dict[str, Any] = {"inherit_organisation_members": inherit_members}
    if sticky:
        settings["sticky_removed"] = [{"user_id": _USER, "removed_at": "x", "removed_by": "y"}]
    return {
        "id": "ws-1",
        "visibility": "private" if private else "open_to_organisation",
        "settings": settings,
    }


@pytest.mark.parametrize(
    "workspace,org_role,expected",
    [
        # Owner carve-out: owners derive admin even on a private workspace.
        (_ws(private=True), "owner", "admin"),
        (_ws(), "owner", "admin"),
        # Sticky-removal beats the owner carve-out (explicit tombstone stays out).
        (_ws(sticky=True), "owner", None),
        (_ws(sticky=True), "admin", None),
        # Private blocks admin + member derivation (but not owner, above).
        (_ws(private=True), "admin", None),
        (_ws(private=True), "member", None),
        (_ws(private=True, inherit_members=True), "member", None),
        # Open workspace: admin derives admin.
        (_ws(), "admin", "admin"),
        # Open workspace: member derives only when the workspace opts in.
        (_ws(inherit_members=True), "member", "member"),
        (_ws(inherit_members=False), "member", None),
        # No org role → no derived access.
        (_ws(), None, None),
        (_ws(inherit_members=True), None, None),
        # Unknown/other roles (e.g. billing) never derive operational access.
        (_ws(), "billing", None),
    ],
)
def test_derive_workspace_role_ladder(
    workspace: dict[str, Any], org_role: Optional[str], expected: Optional[str]
) -> None:
    assert derive_workspace_role(workspace, org_role, _USER) == expected
