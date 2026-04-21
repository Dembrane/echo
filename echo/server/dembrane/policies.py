"""
Policy-based access control for workspaces and orgs.

Uses the AWS IAM-inspired pattern: role is a display label, policies are
the enforcement source of truth. Presets are hardcoded here — the DB stores
only custom_policies (extras beyond the preset).

Effective policies = preset[role] + custom_policies
Enforcement code always calls has_policy(), never checks role directly.
"""

from __future__ import annotations


# ── Tier ordering (lowest to highest) ──

TIER_ORDER: list[str] = ["pilot", "pioneer", "innovator", "changemaker", "guardian"]

# Policies that require a minimum workspace tier. Enforced automatically by
# has_policy() when the caller passes workspace_tier. See release-checklist.md
# §"Tier + role gating matrix" for the canonical list.
TIER_REQUIRED_FOR_POLICY: dict[str, str] = {
    "workspace:export": "innovator",
    "project:share": "innovator",
    "workspace:whitelabel": "changemaker",
    "workspace:api_access": "changemaker",
    "workspace:set_private": "innovator",
    "project:set_private": "innovator",
}


# ── Org role presets ──

ORG_ROLE_PRESETS: dict[str, list[str]] = {
    "member": [
        "org:view",
    ],
    "admin": [
        "org:view",
        "org:manage_users",
        "org:manage_settings",
        "org:manage_billing",
        "org:create_workspace",
        "org:view_all_workspaces",
        "org:view_usage",
    ],
    "owner": ["*"],
}


# ── Workspace role presets ──

WORKSPACE_ROLE_PRESETS: dict[str, list[str]] = {
    "viewer": [
        "project:read",
        "conversation:read",
        "report:view",
    ],
    "member": [
        "project:read",
        "project:create",
        "project:update",
        "conversation:read",
        "conversation:delete",
        "chat:use",
        "report:view",
        "report:generate",
    ],
    "admin": [
        "project:read",
        "project:create",
        "project:update",
        "project:delete",
        "project:share",
        "project:set_private",
        "project:move",
        "conversation:read",
        "conversation:delete",
        "chat:use",
        "report:view",
        "report:generate",
        "report:delete",
        "member:invite",
        "member:manage",
        "settings:manage",
        "workspace:view_usage",
        "workspace:export",
        "workspace:set_private",
        "workspace:whitelabel",
        "workspace:api_access",
    ],
    "owner": ["*"],
}


# ── Project role presets (for project_user sharing, innovator+ tier) ──

PROJECT_ROLE_PRESETS: dict[str, list[str]] = {
    "viewer": [
        "project:read",
        "conversation:read",
        "report:view",
    ],
    "editor": [
        "project:read",
        "project:update",
        "conversation:read",
        "conversation:delete",
        "chat:use",
        "report:view",
        "report:generate",
        "export:data",
    ],
}


def get_effective_policies(
    role: str,
    custom_policies: list[str] | None = None,
    presets: dict[str, list[str]] = WORKSPACE_ROLE_PRESETS,
) -> list[str]:
    """Compute effective policies: preset for role + any custom additions."""
    base = presets.get(role, [])
    extras = custom_policies or []
    return base + extras


def has_policy(
    role: str,
    custom_policies: list[str] | None,
    required: str,
    presets: dict[str, list[str]] = WORKSPACE_ROLE_PRESETS,
    workspace_tier: str | None = None,
) -> bool:
    """Check if a role + custom_policies grants a required policy.

    When `workspace_tier` is provided, the tier gate from
    TIER_REQUIRED_FOR_POLICY is enforced automatically — so endpoints only
    need to call require_policy() and the tier check rides along.
    Callers in test contexts can omit workspace_tier to bypass the tier gate.
    """
    effective = get_effective_policies(role, custom_policies, presets)
    role_allows = "*" in effective or required in effective
    if not role_allows:
        return False

    required_tier = TIER_REQUIRED_FOR_POLICY.get(required)
    if required_tier is None or workspace_tier is None:
        return True
    return meets_tier(workspace_tier, required_tier)


def meets_tier(current_tier: str, minimum_tier: str) -> bool:
    """Check if a workspace tier meets the minimum requirement."""
    try:
        return TIER_ORDER.index(current_tier) >= TIER_ORDER.index(minimum_tier)
    except ValueError:
        return False
