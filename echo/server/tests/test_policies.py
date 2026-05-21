"""Tests for the workspace policy presets (matrix §4 + ADR-0003).

Covers:
    - External preset content (allowlist) — exactly the matrix-§4 set.
    - External denials — every policy outside the allowlist is denied.
    - Member preset content stays unchanged (regression guard).
    - Role hierarchy ordering with external at the bottom.
"""

from __future__ import annotations

from dembrane.policies import (
    ROLE_HIERARCHY,
    WORKSPACE_ROLE_PRESETS,
    has_policy,
)

# Matrix §4 external allowlist.
_EXTERNAL_ALLOWED = {
    "project:read",
    "project:update",
    "conversation:read",
    "chat:use",
    "report:view",
    "report:generate",
}

# Policies that externals must NOT have.
_EXTERNAL_DENIED = {
    "project:create",
    "project:delete",
    "project:share",
    "conversation:delete",
    "report:publish",
    "workspace:view_usage",
    "workspace:view_invoices",
    "member:invite",
    "member:manage",
    "settings:manage",
}


def test_external_preset_exists():
    assert "external" in WORKSPACE_ROLE_PRESETS


def test_external_preset_content_exact():
    assert set(WORKSPACE_ROLE_PRESETS["external"]) == _EXTERNAL_ALLOWED


def test_external_role_grants_allowed():
    for policy in _EXTERNAL_ALLOWED:
        assert has_policy("external", custom_policies=None, required=policy), (
            f"external should allow {policy}"
        )


def test_external_role_denies_everything_else():
    for policy in _EXTERNAL_DENIED:
        assert not has_policy("external", custom_policies=None, required=policy), (
            f"external should deny {policy}"
        )


def test_external_specifically_denies_project_create_and_allows_project_read():
    assert has_policy("external", None, "project:read") is True
    assert has_policy("external", None, "project:create") is False


def test_member_preset_unchanged():
    """Member preset content is unchanged by the external rename."""
    expected = {
        "project:read",
        "project:create",
        "project:update",
        "conversation:read",
        "conversation:delete",
        "chat:use",
        "report:view",
        "report:generate",
        "report:publish",
        "workspace:view_usage",
    }
    assert set(WORKSPACE_ROLE_PRESETS["member"]) == expected


def test_role_hierarchy_ordering():
    assert ROLE_HIERARCHY["external"] < ROLE_HIERARCHY["member"]
    assert ROLE_HIERARCHY["member"] < ROLE_HIERARCHY["billing"]
    assert ROLE_HIERARCHY["billing"] < ROLE_HIERARCHY["admin"]
    assert ROLE_HIERARCHY["admin"] < ROLE_HIERARCHY["owner"]


def test_guest_preset_key_removed():
    """The 'guest' preset is renamed to 'external' — old key should be gone."""
    assert "guest" not in WORKSPACE_ROLE_PRESETS
