"""Billing account: the single source of truth for a workspace's commercial terms.

A workspace resolves its tier and commercial terms through the billing account
its `billing_account_id` points at (NOT NULL). That account is either
workspace-scoped (billed separately) or org-scoped (shared across the org's
workspaces). There is no authoritative `workspace.tier`: reads resolve through
the account, writes target the account.

Two read patterns:
- when you already fetch the workspace, add `nested_billing_fields()` to the
  Directus `fields` list and read the joined values with `billing_from_workspace`
  / `tier_from_workspace` (one query, no extra round-trip)
- when you only hold a workspace id, use `resolve_workspace_tier` /
  `resolve_workspace_billing`

See docs/plans/billing-account-split.md and docs/adr/0005-per-seat-tier-overhaul.md.
"""

from __future__ import annotations

from typing import Any, Optional

from dembrane import directus_async
from dembrane.utils import generate_uuid

# Commercial fields that live on the billing account (moved off workspace).
BILLING_FIELDS = (
    "tier",
    "tier_expires_at",
    "downgraded_at",
    "downgraded_from_tier",
    "pre_warning_sent",
    "percent_discount",
    "type_discount",
    "billing_period",
)


def nested_billing_fields(prefix: str = "billing_account_id") -> list[str]:
    """Directus dot-notation field list that joins the account's commercial
    fields into a workspace fetch, so a single query returns both."""
    return [f"{prefix}.{f}" for f in BILLING_FIELDS]


def billing_from_workspace(ws: dict[str, Any], prefix: str = "billing_account_id") -> dict[str, Any]:
    """Pull the commercial fields off a workspace dict that joined the account
    via `nested_billing_fields()`. Returns {} when the account wasn't joined
    (e.g. `billing_account_id` came back as a bare id string)."""
    account = ws.get(prefix)
    if isinstance(account, dict):
        return {f: account.get(f) for f in BILLING_FIELDS}
    return {}


def tier_from_workspace(ws: dict[str, Any], prefix: str = "billing_account_id") -> Optional[str]:
    """Read the tier off a workspace dict that joined the account. None when
    the account wasn't joined."""
    return billing_from_workspace(ws, prefix).get("tier")


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


async def get_billing_account_id(workspace_id: str) -> Optional[str]:
    """The id of the billing account a workspace resolves to."""
    ws = await directus_async.async_directus.get_item("workspace", workspace_id)
    return (ws or {}).get("billing_account_id")


async def update_workspace_billing(workspace_id: str, patch: dict[str, Any]) -> Optional[str]:
    """Write commercial fields to the workspace's billing account. Returns the
    account id, or None if the workspace has no account (should not happen given
    the NOT NULL invariant; treated as a no-op rather than raising)."""
    account_id = await get_billing_account_id(workspace_id)
    if not account_id:
        return None
    await directus_async.async_directus.update_item("billing_account", account_id, patch)
    return account_id


async def resolve_workspace_billing(workspace_id: str) -> dict[str, Any]:
    """Resolve a workspace's commercial fields through its billing account.
    Returns {} when the workspace or account is missing."""
    ws = await directus_async.async_directus.get_item("workspace", workspace_id)
    if not ws:
        return {}
    account_id = ws.get("billing_account_id")
    if not account_id:
        return {}
    account = await directus_async.async_directus.get_item("billing_account", account_id)
    if not account:
        return {}
    return {f: account.get(f) for f in BILLING_FIELDS}


async def resolve_workspace_tier(workspace_id: str) -> Optional[str]:
    """Resolve a workspace's tier through its billing account."""
    return (await resolve_workspace_billing(workspace_id)).get("tier")
