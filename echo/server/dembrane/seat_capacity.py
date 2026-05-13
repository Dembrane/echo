"""Workspace seat capacity enforcement (unified model).

Single source of truth for "is there room on this workspace for one more
user?" Builds on inheritance.get_effective_members so the count includes
derived org admins/owners — they count toward seats just like direct members.

Guests (is_external=true) share the same seat pool as members. There is no
separate guest cap — only `included_seats` matters. The `is_external` flag
continues to drive role/permissions (guest = read-mostly), but no longer has
a parallel capacity limit.

Policy (free-tier unification, 2026-05):

    | Tier             | Behaviour at seat cap                      |
    | free / pilot     | HARD BLOCK (no overage mechanism)           |
    | pioneer+         | allow (seat overage bills)                  |
    | guardian         | unlimited                                   |

Two surfaces use this:
    1. Invite-creation paths (invites.py, access_requests approve) call
       assert_can_add_seat; on 402 the admin sees an upgrade prompt.
    2. Acceptance paths (me.py, onboarding.py) use the same helper as
       race protection — the cap may have shrunk between invite-send
       and accept (e.g. tier downgrade mid-flight). On 402 at acceptance
       the invitee sees a friendly "workspace is full" message.

Use audience='admin' (default) for the first set, audience='invitee'
for the second so the error detail string is appropriate.
"""

from __future__ import annotations

from typing import Literal
from datetime import datetime, timezone

from fastapi import HTTPException

from dembrane.inheritance import get_effective_members
from dembrane.tier_capacity import next_tier, get_capacity
from dembrane.directus_async import async_directus

Audience = Literal["admin", "invitee"]


_SEAT_ROLES = {"owner", "admin", "member", "billing"}

# Tiers that hard-block on seat cap (no overage mechanism).
_HARD_BLOCK_SEAT_TIERS = frozenset({"free", "pilot"})


def tier_hard_blocks_seats(tier: str) -> bool:
    """Free and pilot hard-block on seat cap. Pioneer+ accrue overage.
    Guardian + unknown tiers don't block."""
    return tier in _HARD_BLOCK_SEAT_TIERS


async def compute_effective_seat_state(workspace_id: str) -> tuple[int, int, int]:
    """Return (seats_used, member_count, guest_count) for a workspace.

    seats_used: total distinct users (members + guests) — the enforcement value.
    member_count: distinct users with a seat role (owner/admin/member/billing).
    guest_count: distinct users with is_external=true.

    Includes derived org admins/owners (via get_effective_members). A user with
    both a direct row and a derived path counts once.
    """
    members = await get_effective_members(workspace_id)

    member_users: set[str] = set()
    guest_users: set[str] = set()
    for m in members:
        uid = m.get("user_id")
        if not uid:
            continue
        if m.get("is_external"):
            guest_users.add(uid)
            continue
        role = m.get("role") or ""
        if role in _SEAT_ROLES:
            member_users.add(uid)

    seats_used = len(member_users) + len(guest_users)
    return seats_used, len(member_users), len(guest_users)


async def count_pending_invites(workspace_id: str) -> tuple[int, int]:
    """Return (pending_member_invites, pending_guest_invites) for a
    workspace. Counts active workspace_invite rows: not yet accepted, not
    expired. Member invite = include_org_membership=True; guest invite =
    include_org_membership=False.

    Used at invite-send time so the cap check accounts for outstanding
    commitments, not just realised memberships. Without this an admin can
    fire 5 invites against a 0/2 workspace and only 2 will succeed
    at accept-time — bad UX. With this, the 3rd send is blocked upfront.

    Acceptance paths still count actuals only (race protection); pending
    isn't relevant there because we're transitioning a pending row to a
    real membership.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    rows = await async_directus.get_items(
        "workspace_invite",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "accepted_at": {"_null": True},
                    "expires_at": {"_gt": now_iso},
                },
                "fields": ["include_org_membership"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return 0, 0
    member_pending = 0
    guest_pending = 0
    for r in rows:
        if r.get("include_org_membership"):
            member_pending += 1
        else:
            guest_pending += 1
    return member_pending, guest_pending


def _format_message(*, audience: Audience, tier: str, cap: int) -> str:
    if audience == "invitee":
        return "This workspace is full. Contact the workspace admin."
    return f"Workspace is at its {cap}-seat limit for the {tier} tier. Upgrade to add more."


async def assert_can_add_seat(
    workspace: dict,
    *,
    audience: Audience = "admin",
    include_pending: bool = False,
) -> None:
    """Raise 402 if adding any user (member or guest) would exceed the
    unified seat cap, but only for tiers that hard-block (free, pilot).

    Pioneer+ never blocks — seat overage applies instead. Guardian and
    unknown tiers are unlimited.

    `include_pending` controls whether outstanding workspace_invite rows
    count toward the cap. Send-paths pass True (don't let admins
    over-issue invites). Acceptance paths pass False — they're
    transitioning pending → actual, so counting pending would double-count.
    """
    tier = (workspace.get("tier") or "").lower()
    cap = get_capacity(tier)
    if cap is None or cap.included_seats is None:
        return  # unknown tier or unlimited
    if not tier_hard_blocks_seats(tier):
        return  # Pioneer+ allow overage

    workspace_id = workspace.get("id")
    if not workspace_id:
        return  # defensive — should never happen
    seats_used, _member_count, _guest_count = await compute_effective_seat_state(workspace_id)
    pending = 0
    if include_pending:
        member_pending, guest_pending = await count_pending_invites(workspace_id)
        pending = member_pending + guest_pending
    if seats_used + pending < cap.included_seats:
        return

    raise HTTPException(
        status_code=402,
        detail=_format_message(audience=audience, tier=tier, cap=cap.included_seats),
        headers={
            "X-Cap-Code": "SEAT_CAP_REACHED",
            "X-Cap-Tier": tier,
            "X-Cap-Next-Tier": next_tier(tier) or "",
        },
    )


# Backwards-compatible aliases — call sites that differentiate between
# member and guest invites can keep calling these; they both route to the
# unified seat check.
async def assert_can_add_member(
    workspace: dict,
    *,
    audience: Audience = "admin",
    include_pending: bool = False,
) -> None:
    """Legacy alias for assert_can_add_seat (member invite path)."""
    await assert_can_add_seat(workspace, audience=audience, include_pending=include_pending)


async def assert_can_add_guest(
    workspace: dict,
    *,
    audience: Audience = "admin",
    include_pending: bool = False,
) -> None:
    """Legacy alias for assert_can_add_seat (guest invite path)."""
    await assert_can_add_seat(workspace, audience=audience, include_pending=include_pending)
