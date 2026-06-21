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
from datetime import datetime, timezone, timedelta

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
    "status",
)


def nested_billing_fields(prefix: str = "billing_account_id") -> list[str]:
    """Directus dot-notation field list that joins the account's commercial
    fields into a workspace fetch, so a single query returns both."""
    return [f"{prefix}.{f}" for f in BILLING_FIELDS]


def workspace_is_external_client(ws: dict[str, Any]) -> bool:
    """Whether a workspace is "for an external client" (a partner workspace),
    as opposed to internal-use.

    This is the gate for the free, read-only observer role (Wave G): observers
    exist only in external-client workspaces. Internal workspaces have no free
    observer.

    Canonical signal is `workspace.usage_context == "external"` (written at
    creation for partner "for another client" workspaces). Falls back, for rows
    created before usage_context was written, to the post-handoff client marker
    (`billed_to_team_id` set and different from `org_id`). The `ws` dict must be
    a full workspace row (e.g. from `get_item`), not a billing-joined subset.
    """
    uc = (ws.get("usage_context") or "").strip().lower()
    if uc:
        return uc == "external"
    billed_to = ws.get("billed_to_team_id")
    return bool(billed_to) and billed_to != ws.get("org_id")


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


async def create_org_scoped_account(
    *,
    org_id: str,
    tier: str = "free",
    created_by: Optional[str] = None,
    label: Optional[str] = None,
) -> str:
    """Create an org-scoped billing account (the org is the payer). Returns its
    id. `workspace_id` stays null; workspaces attach via `billing_account_id`."""
    account_id = generate_uuid()
    payload: dict[str, Any] = {
        "id": account_id,
        "org_id": org_id,
        "tier": tier,
        "payment_mode": "none",
    }
    if created_by:
        payload["created_by"] = created_by
    if label:
        payload["label"] = label
    await directus_async.async_directus.create_item("billing_account", payload)
    return account_id


async def get_org_account_id(org_id: str) -> Optional[str]:
    """The org's billing account id (oldest live org-scoped account), or None."""
    rows = await directus_async.async_directus.get_items(
        "billing_account",
        {
            "query": {
                "filter": {"org_id": {"_eq": org_id}, "deleted_at": {"_null": True}},
                "fields": ["id"],
                "sort": ["created_at"],
                "limit": 1,
            }
        },
    )
    if isinstance(rows, list) and rows:
        return rows[0].get("id")
    return None


async def org_account_for_new_workspace(
    *, org_id: str, default_tier: str = "free", created_by: Optional[str] = None
) -> str:
    """The account a new workspace attaches to by default (org manages billing).
    Returns the org's existing account, or creates an org-scoped one if none
    exists yet."""
    existing = await get_org_account_id(org_id)
    if existing:
        return existing
    return await create_org_scoped_account(
        org_id=org_id, tier=default_tier, created_by=created_by, label="Org billing"
    )


async def grant_reverse_trial(
    account_id: str,
    *,
    tier: str = "changemaker",
    months: int = 1,
) -> str:
    """Grant a comped, time-boxed reverse trial on a billing account.

    Sets the tier, an expiry `months` out, marks it as a trial, and keeps it
    comped (no Mollie). The existing tier-expiry cron auto-reverts the account
    to Free when it lapses; the pre-warning cron nudges before that. Returns the
    expiry timestamp (ISO).
    """
    expires_at = (datetime.now(timezone.utc) + timedelta(days=30 * months)).isoformat()
    patch: dict[str, Any] = {
        "tier": tier,
        "tier_expires_at": expires_at,
        "pre_warning_sent": False,
        "type_discount": "trial",
        "payment_mode": "none",
        "downgraded_at": None,
        "downgraded_from_tier": None,
    }
    await directus_async.async_directus.update_item("billing_account", account_id, patch)

    # Tier just changed; the usage rollups cache a flattened per-workspace tier
    # for USAGE_TTL_SECONDS, so bust them or the "Needs attention / Upgrade"
    # panel lingers on the pre-grant tier.
    from dembrane.cache_utils import invalidate_org_usage, invalidate_workspace_usage

    account = await directus_async.async_directus.get_item("billing_account", account_id)
    covered = await directus_async.async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {
                    "billing_account_id": {"_eq": account_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    if isinstance(covered, list):
        for w in covered:
            if w.get("id"):
                await invalidate_workspace_usage(w["id"])
    if account and account.get("org_id"):
        await invalidate_org_usage(account["org_id"])

    return expires_at


def billing_account_blocks_new_workspace(account: Optional[dict]) -> Optional[str]:
    """Reason a billing account can't take a new workspace, or None if it can.

    Pure check used to gate workspace creation. Forward-compatible with the
    Mollie `status` field (Phase 3): a canceled account is dead and blocks; a
    missing account blocks; past_due still allows (we never hard-block over a
    transient failed charge — they stay a customer).
    """
    if not account or account.get("deleted_at"):
        return "organisation has no valid billing account"
    if account.get("status") == "canceled":
        return "organisation billing is canceled; reactivate it to add workspaces"
    return None


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
    result: dict[str, Any] = {f: account.get(f) for f in BILLING_FIELDS}
    # Scope of the owning account: org-scoped (shared, org manages billing) vs
    # workspace-scoped (billed separately). Drives the "managed by org" notice.
    result["org_scoped"] = bool(account.get("org_id"))
    return result


async def resolve_workspace_tier(workspace_id: str) -> Optional[str]:
    """Resolve a workspace's tier through its billing account."""
    return (await resolve_workspace_billing(workspace_id)).get("tier")
