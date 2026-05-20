"""Workspace → billing-period resolver.

`workspace.billing_period` as a column is deferred to the automated-billing
workstream (PRD §28). Until then, the cadence is sourced from the most
recently approved `workspace_request` row pointing at the workspace via
`resulting_workspace_id` (the field set on approve for both new_workspace
and tier_upgrade kinds — `workspace_id` is null for new_workspace requests
even after approval, so we can't rely on it).

Legacy workspaces created before the toggle existed have no approved
request and resolve to `None` — callers default to "annual" for display.
"""

from __future__ import annotations

from typing import Optional

from dembrane.directus_async import async_directus


async def resolve_workspace_billing_period(workspace_id: str) -> Optional[str]:
    """Resolve a single workspace's current billing period.

    Returns `'annual' | 'monthly' | None`. `None` means we don't know —
    typically a workspace that pre-dates the toggle or one upgraded via
    a path that didn't capture cadence (e.g. staff `PATCH /tier`).
    """
    rows = await async_directus.get_items(
        "workspace_request",
        {
            "query": {
                "filter": {
                    "resulting_workspace_id": {"_eq": workspace_id},
                    "status": {"_eq": "approved"},
                    "approved_billing_period": {"_nnull": True},
                },
                "fields": ["approved_billing_period", "decided_at"],
                "sort": ["-decided_at"],
                "limit": 1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        return None
    cadence = rows[0].get("approved_billing_period")
    if cadence not in ("annual", "monthly"):
        return None
    return cadence


async def resolve_workspace_billing_periods(
    workspace_ids: list[str],
) -> dict[str, Optional[str]]:
    """Batch-resolve billing periods for many workspaces.

    Single Directus query for all IDs. The most-recent approved row per
    workspace wins. Workspaces with no matching row map to `None`.
    """
    if not workspace_ids:
        return {}

    rows = await async_directus.get_items(
        "workspace_request",
        {
            "query": {
                "filter": {
                    "resulting_workspace_id": {"_in": workspace_ids},
                    "status": {"_eq": "approved"},
                    "approved_billing_period": {"_nnull": True},
                },
                "fields": [
                    "resulting_workspace_id",
                    "approved_billing_period",
                    "decided_at",
                ],
                # Desc on decided_at so the first row we see for each
                # workspace is the latest one.
                "sort": ["-decided_at"],
                "limit": -1,
            }
        },
    )

    out: dict[str, Optional[str]] = {wid: None for wid in workspace_ids}
    if not isinstance(rows, list):
        return out
    for r in rows:
        wid = r.get("resulting_workspace_id")
        if not wid or out.get(wid) is not None:
            continue
        cadence = r.get("approved_billing_period")
        if cadence in ("annual", "monthly"):
            out[wid] = cadence
    return out
