"""Tier-downgrade effect list.

Per-policy behavior when a workspace drops below a tier that previously
granted the policy. Two effects, following D19 in the design log:

    "revert"  (↺) — feature state is cleared on downgrade. Confirmation
                    dialog must list this explicitly before the staff
                    action proceeds.
    "freeze"  (❄) — existing use stays; new use blocked by has_policy()
                    on the new tier. No data loss.

Adding a new tier-gated policy: declare it here AND in
policies.TIER_REQUIRED_FOR_POLICY. The startup check below raises if the
two sets disagree — prevents "someone forgot to declare the downgrade
behavior" drift.

See docs/workspaces/release-checklist.md §"Tier + role gating matrix" for
the canonical mapping.
"""

from __future__ import annotations

from typing import Literal
from logging import getLogger

from dembrane.policies import TIER_REQUIRED_FOR_POLICY, meets_tier
from dembrane.directus_async import async_directus

logger = getLogger("dembrane.tier_downgrade")

Effect = Literal["revert", "freeze"]

DOWNGRADE_EFFECTS: dict[str, Effect] = {
    "workspace:whitelabel": "revert",  # ↺ clear custom logo
    "workspace:api_access": "freeze",  # ❄ existing tokens stay, no new/rotate
    "workspace:webhooks": "freeze",  # ❄ existing webhooks fire, no new configs
    "workspace:export": "freeze",  # ❄ existing exports intact
    "project:share": "freeze",  # ❄ existing shares stay
    "workspace:set_private": "freeze",  # ❄ stays private
    "project:set_private": "freeze",  # ❄ stays private
}


def _startup_check() -> None:
    """Every tier-gated policy must declare its downgrade behavior here."""
    missing = set(TIER_REQUIRED_FOR_POLICY) - set(DOWNGRADE_EFFECTS)
    if missing:
        raise RuntimeError(
            "TIER_REQUIRED_FOR_POLICY declares policies with no downgrade "
            f"effect in DOWNGRADE_EFFECTS: {sorted(missing)}. "
            "Add them to dembrane/tier_downgrade.py."
        )


_startup_check()


# Human-readable copy for the confirmation dialog. Keep terse; the dialog
# should list these as bullet points under the "This will" heading.
_HUMAN: dict[str, str] = {
    "workspace:whitelabel": "Remove your custom logo (revert to dembrane logo)",
    "workspace:api_access": "Freeze API access (existing tokens keep working; no new tokens)",
    "workspace:webhooks": "Freeze webhooks (existing webhooks keep firing; no new configs)",
    "workspace:export": "Freeze data export (existing files stay; new exports blocked)",
    "project:share": "Freeze private project sharing (existing shares stay; no new shares)",
    "workspace:set_private": "Freeze ability to make new private workspaces",
    "project:set_private": "Freeze ability to make new private projects",
}


async def preview_downgrade(
    workspace_id: str,  # noqa: ARG001 — kept for signature parity with apply_downgrade_effects
    from_tier: str,
    to_tier: str,
) -> list[dict]:
    """What will happen if we downgrade this workspace? Pure read.

    Returns a list of {policy, effect, human} entries for every policy
    whose tier gate newly kicks in at to_tier. Empty list if to_tier
    ≥ from_tier (no effects to preview).

    UI renders as "This will:" bulleted list in the confirmation dialog.
    """
    if meets_tier(to_tier, from_tier):
        return []

    affected: list[dict] = []
    for policy, required_tier in TIER_REQUIRED_FOR_POLICY.items():
        # Policy was available at from_tier but not at to_tier
        if meets_tier(from_tier, required_tier) and not meets_tier(to_tier, required_tier):
            affected.append(
                {
                    "policy": policy,
                    "effect": DOWNGRADE_EFFECTS[policy],
                    "human": _HUMAN.get(policy, policy),
                }
            )
    return affected


async def apply_downgrade_effects(workspace_id: str, from_tier: str, to_tier: str) -> list[dict]:
    """Execute the revert effects; return the preview list for logging.

    Called inside the PATCH tier transaction in workspaces.py.

    - revert effects mutate workspace state (e.g. clear logo_url).
    - freeze effects require no action — has_policy() will start denying
      the policy automatically once workspace.tier is updated.
    """
    effects = await preview_downgrade(workspace_id, from_tier, to_tier)
    if not effects:
        return []

    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace:
        return effects

    patches: dict = {}

    for e in effects:
        if e["effect"] != "revert":
            continue
        if e["policy"] == "workspace:whitelabel":
            # Clear the custom workspace logo. Org-level fallback still applies.
            patches["logo_url"] = None
        # Any future "revert" policy adds its clear-on-downgrade here.

    if patches:
        await async_directus.update_item("workspace", workspace_id, patches)
        logger.info(
            f"Applied revert effects on workspace {workspace_id} "
            f"({from_tier} → {to_tier}): {list(patches)}"
        )

    # Clear is_over_cap on all conversations in this workspace so that
    # previously-unlocked content stays readable after downgrade. New
    # conversations created on the new tier will be freshly stamped.
    await _clear_over_cap_stamps(workspace_id)

    return effects


async def _clear_over_cap_stamps(workspace_id: str) -> None:
    """Reset is_over_cap=False on all conversations in the workspace.

    This ensures content created during a higher tier remains readable
    after downgrade. The stamp is re-evaluated for new conversations
    only, at their finish time.
    """
    try:
        project_rows = await async_directus.get_items(
            "project",
            {
                "query": {
                    "filter": {"workspace_id": {"_eq": workspace_id}},
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        if not isinstance(project_rows, list) or not project_rows:
            return

        project_ids = [p["id"] for p in project_rows if p.get("id")]
        if not project_ids:
            return

        stamped = await async_directus.get_items(
            "conversation",
            {
                "query": {
                    "filter": {
                        "project_id": {"_in": project_ids},
                        "is_over_cap": {"_eq": True},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        if not isinstance(stamped, list) or not stamped:
            return

        for conv in stamped:
            await async_directus.update_item("conversation", conv["id"], {"is_over_cap": False})

        logger.info(
            f"Cleared is_over_cap on {len(stamped)} conversations "
            f"in workspace {workspace_id} during downgrade"
        )
    except Exception:
        logger.exception(f"Failed to clear is_over_cap stamps for workspace {workspace_id}")


async def recalculate_over_cap_on_upgrade(workspace_id: str, new_tier: str) -> None:
    """Recalculate is_over_cap stamps after a tier upgrade.

    For overage tiers (pioneer+), no action needed -- live lock formula
    already returns False. For non-overage tiers (free, pilot), clear
    stamps for conversations now within the new tier's included hours.
    """
    from dembrane.tier_capacity import get_capacity, compute_is_over_cap, tier_allows_overage

    if tier_allows_overage(new_tier):
        return

    cap = get_capacity(new_tier)
    if cap is None or cap.included_hours is None:
        return

    try:
        project_rows = await async_directus.get_items(
            "project",
            {
                "query": {
                    "filter": {"workspace_id": {"_eq": workspace_id}},
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        if not isinstance(project_rows, list) or not project_rows:
            return

        project_ids = [p["id"] for p in project_rows if p.get("id")]
        if not project_ids:
            return

        all_convs = await async_directus.get_items(
            "conversation",
            {
                "query": {
                    "filter": {"project_id": {"_in": project_ids}},
                    "fields": ["id", "duration", "is_over_cap"],
                    "limit": -1,
                }
            },
        )
        if not isinstance(all_convs, list) or not all_convs:
            return

        total_hours = sum((int(c.get("duration") or 0) / 3600.0) for c in all_convs)

        cleared = 0
        for conv in all_convs:
            if not conv.get("is_over_cap"):
                continue
            conv_hours = int(conv.get("duration") or 0) / 3600.0
            if not compute_is_over_cap(new_tier, total_hours, conv_hours):
                await async_directus.update_item("conversation", conv["id"], {"is_over_cap": False})
                cleared += 1

        if cleared:
            logger.info(
                "Cleared is_over_cap on %d conversations in workspace %s after upgrade to %s",
                cleared,
                workspace_id,
                new_tier,
            )
    except Exception:
        logger.exception("Failed to recalculate is_over_cap for workspace %s", workspace_id)
