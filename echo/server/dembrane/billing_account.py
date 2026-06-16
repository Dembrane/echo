"""Workspace billing-account helpers (Phase 1: billing account split).

Phase 1 is behavior-preserving. Every workspace now has exactly one
`billing_account` (NOT NULL `workspace.billing_account_id`). The account's
commercial fields mirror the workspace's via dual-write, so enforcement can
keep reading `workspace.tier` today and move onto `resolve_workspace_tier`
in a follow-up with no behavior change.

See docs/plans/billing-account-split.md and docs/adr/0005-per-seat-tier-overhaul.md.
"""

from __future__ import annotations

from typing import Any, Optional

from dembrane import directus_async
from dembrane.utils import generate_uuid

# Commercial fields the account mirrors from the workspace during Phase 1.
MIRRORED_FIELDS = (
    "tier",
    "tier_expires_at",
    "downgraded_at",
    "downgraded_from_tier",
    "pre_warning_sent",
    "percent_discount",
    "type_discount",
)


async def create_workspace_scoped_account(
    *,
    tier: str,
    tier_expires_at: Optional[str] = None,
    type_discount: Optional[str] = None,
    percent_discount: Optional[int] = None,
    created_by: Optional[str] = None,
    label: Optional[str] = None,
) -> str:
    """Create a workspace-scoped billing account and return its id.

    `workspace_id` is set afterwards via `link_account_to_workspace`, once the
    workspace row exists (the account's `workspace_id` FK points at
    `workspace.id`, so it can't be set before the workspace is inserted). The
    account starts with `payment_mode='none'`.
    """
    account_id = generate_uuid()
    payload: dict[str, Any] = {
        "id": account_id,
        "tier": tier,
        "payment_mode": "none",
    }
    if tier_expires_at:
        payload["tier_expires_at"] = tier_expires_at
    if type_discount:
        payload["type_discount"] = type_discount
    if percent_discount is not None:
        payload["percent_discount"] = percent_discount
    if created_by:
        payload["created_by"] = created_by
    if label:
        payload["label"] = label
    await directus_async.async_directus.create_item("billing_account", payload)
    return account_id


async def link_account_to_workspace(account_id: str, workspace_id: str) -> None:
    """Point a billing account at its owning workspace (sets `workspace_id`)."""
    await directus_async.async_directus.update_item(
        "billing_account", account_id, {"workspace_id": workspace_id}
    )


def account_patch_from_workspace_patch(patch: dict[str, Any]) -> dict[str, Any]:
    """Return the billing-account subset of a workspace patch (pure, no I/O).

    Phase 1 dual-write: callers apply the returned patch to the workspace's
    billing account with their own Directus client, right after updating the
    workspace, so the account stays the accurate source of truth. Empty when
    the patch touches none of `MIRRORED_FIELDS`.
    """
    return {k: patch[k] for k in MIRRORED_FIELDS if k in patch}


async def resolve_workspace_tier(workspace_id: str) -> Optional[str]:
    """Resolve a workspace's tier through its billing account.

    This is the seam the enforcement reads will move onto. Falls back to the
    workspace's own `tier` when the account is missing or unreadable, so
    callers stay safe during the Phase 1 transition.
    """
    ws = await directus_async.async_directus.get_item("workspace", workspace_id)
    if not ws:
        return None
    account_id = ws.get("billing_account_id")
    if account_id:
        account = await directus_async.async_directus.get_item("billing_account", account_id)
        if account and account.get("tier"):
            return account["tier"]
    return ws.get("tier")
