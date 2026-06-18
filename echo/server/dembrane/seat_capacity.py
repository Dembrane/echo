"""Workspace seat capacity enforcement (unified model).

Single source of truth for "is there room on this workspace for one more
user?" Only direct workspace members consume a seat; derived org-admin/owner
access does not (ADR-0004).

Externals (role='external') share the same seat pool as members. There is
no separate external cap — only `included_seats` matters. The `external`
role drives policy (read-mostly per matrix §4) but no longer has a
parallel capacity limit. See ADR-0003.

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


# Every workspace role consumes a seat. external sits in the same pool as
# member/admin/billing/owner — the unified-pool decision in ADR-0003.
_SEAT_ROLES = {"owner", "admin", "member", "billing", "external"}
_EXTERNAL_ROLE = "external"

# Tiers that hard-block on seat cap (no overage mechanism).
# Free is single-user: the one tier that hard-caps seats. Paid tiers are
# per-seat metered and never block (ADR 0005).
_HARD_BLOCK_SEAT_TIERS = frozenset({"free"})


def tier_hard_blocks_seats(tier: str) -> bool:
    """Only Free hard-caps seats (single user). Paid tiers bill per seat and
    never block. Unknown tiers don't block."""
    return tier in _HARD_BLOCK_SEAT_TIERS


async def effective_seat_user_ids(workspace_id: str) -> set[str]:
    """Distinct app_user ids that occupy a seat in this workspace.

    Same predicate as `compute_effective_seat_state` (direct members only,
    role in the seat pool incl. external), but returns the ids so callers can
    pool seats across an account's workspaces and dedupe a user who is a member
    of several of them (otherwise they'd be counted once per workspace — the
    phantom-seat bug)."""
    members = await get_effective_members(workspace_id)
    user_ids: set[str] = set()
    for m in members:
        if m.get("source") != "direct":
            continue
        uid = m.get("user_id")
        if not uid:
            continue
        if (m.get("role") or "") in _SEAT_ROLES:
            user_ids.add(uid)
    return user_ids


async def compute_effective_seat_state(workspace_id: str) -> tuple[int, int, int]:
    """Return (seats_used, member_count, external_count) for a workspace.

    seats_used: total distinct users — the enforcement value.
    member_count: distinct users with a non-external seat role
        (owner/admin/member/billing).
    external_count: distinct users with role='external'.

    Only direct members occupy a seat; derived org-admin/owner access
    (source='inherited') grants oversight but does not (ADR-0004).
    """
    members = await get_effective_members(workspace_id)

    member_users: set[str] = set()
    external_users: set[str] = set()
    for m in members:
        # Derived oversight access doesn't consume a seat.
        if m.get("source") != "direct":
            continue
        uid = m.get("user_id")
        if not uid:
            continue
        role = m.get("role") or ""
        if role == _EXTERNAL_ROLE:
            external_users.add(uid)
        elif role in _SEAT_ROLES:
            member_users.add(uid)

    seats_used = len(member_users) + len(external_users)
    return seats_used, len(member_users), len(external_users)


async def count_pending_invites(workspace_id: str) -> tuple[int, int]:
    """Return (pending_member_invites, pending_external_invites) for a
    workspace. Counts active workspace_invite rows: not yet accepted, not
    expired. Buckets by the invite's `role` column.

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
                    "deleted_at": {"_null": True},
                    "expires_at": {"_gt": now_iso},
                },
                "fields": ["role"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return 0, 0
    member_pending = 0
    external_pending = 0
    for r in rows:
        # NULL-role rows (pre-ADR-0003, before invite.role was populated)
        # default to member_pending — the safer bucket. The migration backfills
        # these to 'member', so this branch is only for in-flight rows during
        # the rollout window.
        if (r.get("role") or "") == _EXTERNAL_ROLE:
            external_pending += 1
        else:
            member_pending += 1
    return member_pending, external_pending


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
    """Raise 402 if adding any user (member or external) would exceed the
    unified seat cap, but only for tiers that hard-block (free, pilot).

    Pioneer+ never blocks — seat overage applies instead. Guardian and
    unknown tiers are unlimited.

    `include_pending` controls whether outstanding workspace_invite rows
    count toward the cap. Send-paths pass True (don't let admins
    over-issue invites). Acceptance paths pass False — they're
    transitioning pending → actual, so counting pending would double-count.
    """
    # `tier` here is the billing-account tier: callers resolve it onto the
    # workspace dict (via the account) before calling.
    tier = (workspace.get("tier") or "").lower()
    cap = get_capacity(tier)
    if cap is None or cap.included_seats is None:
        return  # unknown tier or unlimited
    if not tier_hard_blocks_seats(tier):
        return  # Pioneer+ allow overage

    workspace_id = workspace.get("id")
    if not workspace_id:
        return  # defensive — should never happen
    seats_used, _member_count, _external_count = await compute_effective_seat_state(workspace_id)
    pending = 0
    if include_pending:
        member_pending, external_pending = await count_pending_invites(workspace_id)
        pending = member_pending + external_pending
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
