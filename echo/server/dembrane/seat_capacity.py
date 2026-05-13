"""Workspace seat + guest capacity enforcement.

Single source of truth for "is there room on this workspace for one more
member / guest?" Builds on inheritance.get_effective_members so the count
includes derived org admins/owners — they count toward seats just like
direct members.

Policy (matrix v1.1 §1, §8 + product decision 2026-05-04):

    | Action            | Pilot         | Pioneer / Innovator / Changemaker | Guardian |
    | Member at cap     | HARD BLOCK    | allow (overage bills)             | allow    |
    | Guest at cap      | HARD BLOCK    | HARD BLOCK                        | allow    |

Guests have no overage mechanism, so the guest cap is hard at every paid
tier. Pioneer+ allow seat overage and bill it (matrix §8); only Pilot
hard-blocks seats. Guardian and unknown-tier rows are treated as
unlimited.

Two surfaces use this:
    1. Invite-creation paths (invites.py, access_requests approve) call
       assert_can_add_*; on 402 the admin sees an upgrade prompt.
    2. Acceptance paths (me.py, onboarding.py) use the same helpers as
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


def tier_hard_blocks_seats(tier: str) -> bool:
    """Pilot is the only tier that hard-blocks on seat cap (matrix §8).
    Pioneer+ accrue overage instead. Guardian + unknown tiers don't block."""
    return tier == "pilot"


async def compute_effective_seat_state(workspace_id: str) -> tuple[int, int]:
    """Return (seat_count, guest_count) for a workspace.

    Seats:  distinct users with role in {owner, admin, member, billing},
            including derived org admins/owners (via get_effective_members).
    Guests: distinct direct rows where is_external=true.

    Mirrors the dedup-by-user logic in get_workspace_usage so a user with
    both a direct row and a derived path counts once.
    """
    members = await get_effective_members(workspace_id)

    seat_users: set[str] = set()
    guest_users: set[str] = set()
    for m in members:
        uid = m.get("user_id")
        if not uid:
            continue
        role = m.get("role") or ""
        # Derived rows can never be external (inheritance.py:303).
        if m.get("is_external"):
            guest_users.add(uid)
            continue
        if role in _SEAT_ROLES:
            seat_users.add(uid)

    return len(seat_users), len(guest_users)


async def count_pending_invites(workspace_id: str) -> tuple[int, int]:
    """Return (pending_member_invites, pending_guest_invites) for a
    workspace. Counts active workspace_invite rows: not yet accepted, not
    expired. Member invite = include_org_membership=True; guest invite =
    include_org_membership=False.

    Used at invite-send time so the cap check accounts for outstanding
    commitments, not just realised memberships. Without this an admin can
    fire 5 guest invites against a 0/2 workspace and only 2 will succeed
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


def _format_message(
    *, kind: Literal["seat", "guest"], audience: Audience, tier: str, cap: int
) -> str:
    if audience == "invitee":
        return "This workspace is full. Contact the workspace admin."
    if kind == "seat":
        return f"Workspace is at its {cap}-seat limit for the {tier} tier. Upgrade to add more."
    return f"Workspace is at its {cap}-guest limit for the {tier} tier. Upgrade to add more."


async def assert_can_add_member(
    workspace: dict,
    *,
    audience: Audience = "admin",
    include_pending: bool = False,
) -> None:
    """Raise 402 if a new direct (non-external) member would exceed cap,
    but only for tiers that hard-block seats (Pilot).

    Pioneer+ never blocks members — overage applies instead. Guardian
    and unknown tiers are unlimited.

    `include_pending` controls whether outstanding workspace_invite rows
    count toward the cap. Send-paths pass True (don't let admins
    over-issue invites that won't all succeed). Acceptance paths pass
    False — they're transitioning pending → actual, so counting pending
    would double-count the row being accepted right now.

    The 402 is raised with a plain-string detail so existing error-toast
    handlers (`data.detail`) display it as-is. The structured cap state
    is still readable from the usage endpoint's
    `member_invite_blocked` / `guest_invite_blocked` flags.
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
    seat_count, _guest_count = await compute_effective_seat_state(workspace_id)
    pending = 0
    if include_pending:
        member_pending, _guest_pending = await count_pending_invites(workspace_id)
        pending = member_pending
    if seat_count + pending < cap.included_seats:
        return

    raise HTTPException(
        status_code=402,
        detail=_format_message(kind="seat", audience=audience, tier=tier, cap=cap.included_seats),
        headers={
            "X-Cap-Code": "SEAT_CAP_REACHED",
            "X-Cap-Tier": tier,
            "X-Cap-Next-Tier": next_tier(tier) or "",
        },
    )


async def assert_can_add_guest(
    workspace: dict,
    *,
    audience: Audience = "admin",
    include_pending: bool = False,
) -> None:
    """Raise 402 if adding a guest (is_external=true row) would exceed
    guest_cap. Hard at every finite-cap tier — guests have no overage
    mechanism. Guardian (cap=None) and unknown tiers don't block.

    `include_pending` mirrors assert_can_add_member: send-paths pass
    True so outstanding guest invites count toward the cap, accept-
    paths pass False.
    """
    tier = (workspace.get("tier") or "").lower()
    cap = get_capacity(tier)
    if cap is None or cap.guest_cap is None:
        return  # unknown tier or unlimited

    workspace_id = workspace.get("id")
    if not workspace_id:
        return
    _seat_count, guest_count = await compute_effective_seat_state(workspace_id)
    pending = 0
    if include_pending:
        _member_pending, guest_pending = await count_pending_invites(workspace_id)
        pending = guest_pending
    if guest_count + pending < cap.guest_cap:
        return

    raise HTTPException(
        status_code=402,
        detail=_format_message(kind="guest", audience=audience, tier=tier, cap=cap.guest_cap),
        headers={
            "X-Cap-Code": "GUEST_CAP_REACHED",
            "X-Cap-Tier": tier,
            "X-Cap-Next-Tier": next_tier(tier) or "",
        },
    )
