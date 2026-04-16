"""
Policy-based access control for workspaces and orgs.

Uses the AWS IAM-inspired pattern: role is a display label, policies are
the enforcement source of truth. Presets are hardcoded here — the DB stores
only custom_policies (extras beyond the preset).

Effective policies = preset[role] + custom_policies
Enforcement code always calls has_policy(), never checks role directly.
"""

from __future__ import annotations


# ── Workspace role presets ──

WORKSPACE_ROLE_PRESETS: dict[str, list[str]] = {
    "viewer": [],
    "member": [
        "project:create",
        "project:update",
    ],
    "admin": [
        "project:create",
        "project:update",
        "project:delete",
        "project:share",
        "member:invite",
        "member:manage",
        "settings:manage",
    ],
    "owner": ["*"],
}

# ── Org role presets ──

ORG_ROLE_PRESETS: dict[str, list[str]] = {
    "member": [],
    "admin": [
        "org:manage_users",
        "org:manage_billing",
        "org:view_all_workspaces",
    ],
    "owner": ["*"],
}

# ── Project role presets ──

PROJECT_ROLE_PRESETS: dict[str, list[str]] = {
    "viewer": [],
    "editor": [
        "project:update",
        "conversation:read",
        "chat:use",
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
) -> bool:
    """Check if a role + custom_policies grants a required policy."""
    effective = get_effective_policies(role, custom_policies, presets)
    return "*" in effective or required in effective
