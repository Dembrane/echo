"""Shared helpers for the invite system: ensure_active_org_membership, find_pending_invites, build_invite_accept_url."""

from __future__ import annotations

from typing import Any, Literal, Optional
from logging import getLogger
from datetime import datetime, timezone
from urllib.parse import urlencode

from fastapi import HTTPException

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus

logger = getLogger("api.v2._invite_helpers")


# ---------------------------------------------------------------------------
# Org membership reactivation
# ---------------------------------------------------------------------------

EnsureMembershipStatus = Literal[
    "created",       # New row written
    "reactivated",   # Soft-deleted row had deleted_at cleared
    "already_active",  # Active row already existed; no write
    "upgraded",      # Active row existed but role was promoted (sweep path)
]


async def ensure_active_org_membership(
    *,
    org_id: str,
    user_id: str,
    role: str,
    promote_role: bool = False,
) -> EnsureMembershipStatus:
    """Idempotently ensure an active org_membership at `role`. With promote_role=True, upgrade existing to max(existing, requested)."""
    # Fetch active + soft-deleted in one round-trip; pick deterministically (no unique constraint on (org_id, user_id)).
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": user_id},
                },
                "fields": ["id", "role", "deleted_at"],
                "limit": -1,
            }
        },
    )

    active_row = None
    deleted_row = None
    if isinstance(rows, list):
        for row in rows:
            if row.get("deleted_at") is None and active_row is None:
                active_row = row
            elif row.get("deleted_at") is not None and deleted_row is None:
                deleted_row = row

    if active_row is not None:
        if promote_role:
            # Take the max of (existing, requested) by ROLE_HIERARCHY.
            # Imported here to avoid circular import with policies.
            from dembrane.policies import ROLE_HIERARCHY

            existing_level = ROLE_HIERARCHY.get(active_row.get("role") or "member", 0)
            new_level = ROLE_HIERARCHY.get(role, 0)
            if new_level > existing_level:
                await async_directus.update_item(
                    "org_membership",
                    active_row["id"],
                    {"role": role},
                )
                return "upgraded"
        return "already_active"

    if deleted_row is not None:
        await async_directus.update_item(
            "org_membership",
            deleted_row["id"],
            {"deleted_at": None, "role": role},
        )
        return "reactivated"

    await async_directus.create_item(
        "org_membership",
        {
            "id": generate_uuid(),
            "org_id": org_id,
            "user_id": user_id,
            "role": role,
        },
    )
    return "created"


async def ensure_active_workspace_membership(
    *,
    workspace_id: str,
    user_id: str,
    role: str,
) -> EnsureMembershipStatus:
    """Mirror of ensure_active_org_membership for workspace_membership."""
    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": user_id},
                },
                "fields": ["id", "role", "deleted_at"],
                "limit": -1,
            }
        },
    )

    active_row = None
    deleted_row = None
    if isinstance(rows, list):
        for row in rows:
            if row.get("deleted_at") is None and active_row is None:
                active_row = row
            elif row.get("deleted_at") is not None and deleted_row is None:
                deleted_row = row

    if active_row is not None:
        return "already_active"

    if deleted_row is not None:
        await async_directus.update_item(
            "workspace_membership",
            deleted_row["id"],
            {"deleted_at": None, "role": role, "source": "direct"},
        )
        return "reactivated"

    await async_directus.create_item(
        "workspace_membership",
        {
            "id": generate_uuid(),
            "workspace_id": workspace_id,
            "user_id": user_id,
            "role": role,
            "source": "direct",
        },
    )
    return "created"


# ---------------------------------------------------------------------------
# Pending-invite probe
# ---------------------------------------------------------------------------

_WS_INVITE_DEFAULT_FIELDS = [
    "id",
    "email",
    "workspace_id",
    "role",
    "accepted_at",
    "deleted_at",
    "expires_at",
    "invited_by",
    "created_at",
]
_ORG_INVITE_DEFAULT_FIELDS = [
    "id",
    "email",
    "org_id",
    "role",
    "accepted_at",
    "deleted_at",
    "expires_at",
    "invited_by",
    "created_at",
]


async def find_pending_invites(
    *,
    email: str,
    workspace_ids: Optional[list[str]] = None,
    org_id: Optional[str] = None,
    exclude_workspace_invite_id: Optional[str] = None,
    exclude_org_invite_id: Optional[str] = None,
    fields_workspace: Optional[list[str]] = None,
    fields_org: Optional[list[str]] = None,
) -> tuple[list[dict], list[dict]]:
    """Live-pending probe: returns (workspace_invites, org_invites) filtered by accepted/deleted/expires."""
    now_iso = datetime.now(timezone.utc).isoformat()

    ws_filter: dict[str, Any] = {
        "email": {"_eq": email},
        "accepted_at": {"_null": True},
        "deleted_at": {"_null": True},
        "expires_at": {"_gt": now_iso},
    }
    if workspace_ids is not None:
        if not workspace_ids:
            ws_invites: list[dict] = []
        else:
            ws_filter["workspace_id"] = {"_in": workspace_ids}
    if exclude_workspace_invite_id:
        ws_filter["id"] = {"_neq": exclude_workspace_invite_id}

    if workspace_ids is None or workspace_ids:
        ws_result = await async_directus.get_items(
            "workspace_invite",
            {
                "query": {
                    "filter": ws_filter,
                    "fields": fields_workspace or _WS_INVITE_DEFAULT_FIELDS,
                    "limit": -1,
                }
            },
        )
        ws_invites = ws_result if isinstance(ws_result, list) else []

    org_filter: dict[str, Any] = {
        "email": {"_eq": email},
        "accepted_at": {"_null": True},
        "deleted_at": {"_null": True},
        "expires_at": {"_gt": now_iso},
    }
    if org_id is not None:
        org_filter["org_id"] = {"_eq": org_id}
    if exclude_org_invite_id:
        org_filter["id"] = {"_neq": exclude_org_invite_id}

    org_result = await async_directus.get_items(
        "org_invite",
        {
            "query": {
                "filter": org_filter,
                "fields": fields_org or _ORG_INVITE_DEFAULT_FIELDS,
                "limit": -1,
            }
        },
    )
    org_invites = org_result if isinstance(org_result, list) else []

    return ws_invites, org_invites


# ---------------------------------------------------------------------------
# Email URL assembly
# ---------------------------------------------------------------------------

InviteType = Literal["workspace", "org"]


def build_invite_accept_url(
    *,
    invite_type: InviteType,
    admin_base_url: str,
    hash_value: str,
    inviter_name: str,
    subject_name: str,
    role: str,
    email: str,
) -> str:
    """Build /invite/accept?h=...&iss=...&(ws|org)=...&role=...&email=... URL."""
    params: dict[str, str] = {
        "iss": inviter_name,
        "role": role,
        "email": email,
        "h": hash_value,
    }
    if invite_type == "workspace":
        params["ws"] = subject_name
    else:
        params["org"] = subject_name
    return f"{admin_base_url}/invite/accept?{urlencode(params)}"


# ---------------------------------------------------------------------------
# External membership reconciliation
# ---------------------------------------------------------------------------


async def _org_workspace_roles_local(org_id: str, user_id: str) -> list[str]:
    """Roles on the user's active workspace memberships across this org.

    Local to this module so reconcile's directus calls all route through the
    module-level async_directus (keeps the write path easy to test in
    isolation).
    """
    workspaces = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {"org_id": {"_eq": org_id}, "deleted_at": {"_null": True}},
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    ws_ids = (
        [w["id"] for w in workspaces if w.get("id")]
        if isinstance(workspaces, list)
        else []
    )
    if not ws_ids:
        return []
    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_in": ws_ids},
                    "user_id": {"_eq": user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["role"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return []
    return [r.get("role") for r in rows if r.get("role")]


async def reconcile_external_membership_org_row(org_id: str, user_id: str) -> None:
    """Keep the insider/outsider invariant when a user is being made external.

    Call this BEFORE creating the external workspace_membership, so the roles
    read here are the user's OTHER memberships in the org:
      - If any is internal (member/billing/admin/owner), being external too is
        contradictory: raise 400.
      - Otherwise soft-delete any active org_membership so the outsider rule
        (external implies no org_membership) holds.
    """
    roles = await _org_workspace_roles_local(org_id, user_id)
    if any(r in ("member", "billing", "admin", "owner") for r in roles):
        raise HTTPException(
            status_code=400,
            detail=(
                "This person is already a member of the organisation and cannot "
                "also be added as an external. Remove them from the organisation first."
            ),
        )
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return
    for row in rows:
        if row.get("id"):
            await async_directus.update_item(
                "org_membership",
                row["id"],
                {"deleted_at": datetime.now(timezone.utc).isoformat()},
            )
