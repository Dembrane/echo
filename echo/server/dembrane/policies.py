"""
Policy-based access control for workspaces and orgs.

Uses the AWS IAM-inspired pattern: role is a display label, policies are
the enforcement source of truth. Presets are hardcoded here — the DB stores
only custom_policies (extras beyond the preset).

Effective policies = preset[role] + custom_policies
Enforcement code always calls has_policy(), never checks role directly.
"""

from __future__ import annotations

from logging import getLogger

logger = getLogger("dembrane.policies")


# ── Tier ordering (lowest to highest) ──

TIER_ORDER: list[str] = ["free", "innovator", "changemaker", "guardian"]

# Policies that require a minimum workspace tier. Enforced automatically by
# has_policy() when the caller passes workspace_tier. Matrix v1.1 §2 lists
# the canonical gates.
TIER_REQUIRED_FOR_POLICY: dict[str, str] = {
    "workspace:export": "innovator",
    "project:share": "innovator",
    "workspace:whitelabel": "changemaker",
    "workspace:api_access": "changemaker",
    "workspace:webhooks": "changemaker",
    "workspace:set_private": "innovator",
    "project:set_private": "innovator",
}


# ── Staff policies (narrower than auth.is_admin) ──
#
# Matrix v1.1 §11 introduces a finer grain than "any Directus administrator."
# Wiring in progress — endpoints that read auth.is_admin today will migrate
# to require(staff_policy=...) once we have a storage mechanism (claim list
# on app_user or JWT). Until then, literals live here for reference and
# future-you can grep.
STAFF_POLICIES: set[str] = {
    "staff:can_set_tier",  # PATCH /v2/workspaces/:id/tier
    "staff:can_set_visibility",  # Force workspace visibility, bypass tier check
    "staff:can_transfer",  # Workspace transfer (partner handoff flips)
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
    # Billing role at the organisation level — matrix v1.1 §5. Sees every workspace
    # for usage + invoicing but cannot invite, create workspaces, or change
    # organisation settings.
    "billing": [
        "org:view",
        "org:view_all_workspaces",
        "org:view_usage",
        "org:view_invoices",
        "org:update_payment",
    ],
    "owner": ["*"],
}


# ── Workspace role presets ──
#
# Matrix v1.1 §4 collapses to five roles: Owner / Admin / Billing / Member /
# External.
# - Owner / Admin — full workspace control + billing.
# - Billing — financial surface only; no project capabilities.
# - Member — content author.
# - External — outside collaborator (no org_membership in this org).
#   Strictly scoped per matrix §4: edit projects, capture conversations,
#   run chat, generate reports — nothing else. No invite, no settings,
#   no usage, no publish, no org-level visibility. See ADR-0003.
#
# Retired: 'viewer' (matrix has no viewer role; D11). If any stray rows
# surface with role='viewer', _normalize_legacy_role treats them as 'member'.

WORKSPACE_ROLE_PRESETS: dict[str, list[str]] = {
    "member": [
        "project:read",
        "project:create",
        "project:update",
        "conversation:read",
        "conversation:delete",
        "chat:use",
        "report:view",
        "report:generate",
        "report:publish",
        "workspace:view_usage",  # matrix §4: members see usage (raw, no €).
    ],
    # Matrix §4 external scope — explicit allowlist. Anything not here is
    # implicitly denied (workspace:view_usage, member:invite, settings:manage,
    # report:publish, project:create, conversation:delete, etc.).
    "external": [
        "project:read",
        "project:update",
        "conversation:read",
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
        "report:publish",
        "report:delete",
        "member:invite",
        "member:manage",
        "settings:manage",
        "workspace:view_usage",
        "workspace:view_invoices",
        "workspace:update_payment",
        "workspace:export",
        "workspace:set_private",
        "workspace:whitelabel",
        "workspace:api_access",
        "workspace:webhooks",
        "upgrade:request",
    ],
    "billing": [
        # Matrix v1.1 §4: financial visibility only. No project or content
        # access. Cannot invite, cannot create projects. CAN request upgrade.
        "workspace:view_usage",
        "workspace:view_invoices",
        "workspace:update_payment",
        "upgrade:request",
    ],
    "owner": ["*"],
}


# ── Project role presets (for private project sharing, innovator+ tier) ──

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


# ── Role mapping (defensive) ──

_LEGACY_ROLE_MAP = {
    "viewer": "member",  # D11: viewer retired, no migration; map at read.
}


def _normalize_legacy_role(role: str | None) -> str | None:
    """Map legacy role names to current equivalents. Logs when a legacy
    row is seen so ops can spot lingering data.
    """
    if role is None:
        return None
    mapped = _LEGACY_ROLE_MAP.get(role)
    if mapped is not None:
        logger.warning(
            "legacy_role_observed role=%r mapped_to=%r — no migration planned, "
            "please convert this row at next touch",
            role,
            mapped,
        )
        return mapped
    return role


def get_effective_policies(
    role: str,
    custom_policies: list[str] | None = None,
    presets: dict[str, list[str]] = WORKSPACE_ROLE_PRESETS,
) -> list[str]:
    """Compute effective policies: preset for role + any custom additions."""
    role = _normalize_legacy_role(role) or role
    base = presets.get(role, [])
    extras = custom_policies or []
    return base + extras


# ── Role hierarchy (workspace) ──
#
# Used by the invite endpoint (and any future role-change endpoints) to
# block role escalation: a caller can only grant a role at or below their
# own level. External sits at the bottom because outside collaborators
# cannot invite anyone (no member:invite policy). Owner is highest and
# can only be granted by another owner — currently not exposed in any
# invite UI, but the ordering is here for completeness. See ADR-0003.

ROLE_HIERARCHY: dict[str, int] = {
    "external": 0,
    "member": 1,
    "billing": 2,
    "admin": 3,
    "owner": 4,
}


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
    role = _normalize_legacy_role(role) or role
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
