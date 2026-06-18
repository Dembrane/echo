"""Workspace settings: detail, update, members, and invite (from settings)."""

from typing import Optional, Annotated
from logging import getLogger
from datetime import datetime, timezone

import requests
from fastapi import Depends, APIRouter, UploadFile, HTTPException
from pydantic import BaseModel

from dembrane.directus import directus
from dembrane.inheritance import (
    workspace_follows_organisation_admins,
    workspace_follows_organisation_members,
)
from dembrane.async_helpers import run_in_thread_pool
from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import WorkspaceContext, get_workspace_context

router = APIRouter()
logger = getLogger("api.v2.workspace_settings")


# Reusable Annotated alias keeps handler signatures readable and avoids
# Ruff B008 ("Depends() in arg defaults"). Mirrors the convention in
# dembrane/api/v2/workspaces.py.
DependencyWorkspaceContext = Annotated[WorkspaceContext, Depends(get_workspace_context)]


# ── Detail ──


class WorkspaceMember(BaseModel):
    id: str  # membership id
    user_id: str
    display_name: str
    email: str
    avatar: Optional[str] = None
    role: str
    source: str


class PendingInvite(BaseModel):
    id: str
    email: str
    role: str
    created_at: Optional[str] = None
    invited_by_name: Optional[str] = None
    expires_at: Optional[str] = None


class WorkspaceDetailResponse(BaseModel):
    id: str
    name: str
    tier: str
    org_id: str
    org_name: str
    is_default: bool
    legal_basis: Optional[str] = None
    privacy_policy_url: Optional[str] = None
    description: Optional[str] = None
    members: list[WorkspaceMember] = []
    pending_invites: list[PendingInvite] = []
    # Current user's access
    my_role: str = ""
    my_policies: list[str] = []
    # Privacy + settings context for the settings page controls.
    # `description` lives above (shared with legacy consumers).
    inherit_organisation_admins: bool = True
    inherit_organisation_members: bool = False
    logo_url: Optional[str] = None
    type_discount: Optional[str] = None
    percent_discount: Optional[int] = None
    # Billing cadence sourced from the billing account. `None` defaults to
    # annual for display.
    billing_period: Optional[str] = None
    # Billing account this workspace resolves to (the payer) + its payment
    # status, so the billing tab can drive checkout / show subscription state.
    billing_account_id: Optional[str] = None
    billing_status: Optional[str] = None
    # True when the account is org-scoped (the org manages billing and this
    # workspace just attaches). The billing tab shows a "managed by {org}"
    # notice + link instead of a checkout when this is set.
    billing_org_managed: bool = False


@router.get("/{workspace_id}/settings", response_model=WorkspaceDetailResponse)
async def get_workspace_settings(
    ctx: DependencyWorkspaceContext,
) -> WorkspaceDetailResponse:
    """Get workspace details + full member list.

    Access tiers:
      - Any workspace member can read the workspace info + see names/avatars.
      - Only users with member:manage (admin/owner) see full emails + the
        pending-invite list. External guests and viewers don't.

    Closes the guest-data-leak finding from the 2026-04-21 walkthrough:
    external guests previously saw every member's email and the pending
    invites of their host workspace.
    """
    ws = ctx.workspace
    can_manage = ctx.has_policy("member:manage")

    # Org name
    org_name = ""
    if ws.get("org_id"):
        org = await async_directus.get_item("org", ws["org_id"])
        if org:
            org_name = org.get("name", "")

    # Full member list
    memberships = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": ctx.workspace_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "user_id", "role", "source"],
                "limit": -1,
            }
        },
    )
    members: list[WorkspaceMember] = []
    if isinstance(memberships, list) and len(memberships) > 0:
        user_ids = [m["user_id"] for m in memberships if m.get("user_id")]
        app_users = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": user_ids}},
                    "fields": ["id", "display_name", "email", "directus_user_id"],
                    "limit": -1,
                }
            },
        )
        user_map = {u["id"]: u for u in (app_users if isinstance(app_users, list) else [])}

        # Fetch avatars
        du_ids = [u["directus_user_id"] for u in user_map.values() if u.get("directus_user_id")]
        avatar_map: dict[str, Optional[str]] = {}
        if du_ids:
            profiles = await async_directus.get_users(
                {
                    "query": {
                        "filter": {"id": {"_in": du_ids}},
                        "fields": ["id", "avatar"],
                        "limit": -1,
                    }
                },
            )
            if isinstance(profiles, list):
                avatar_map = {u["id"]: u.get("avatar") for u in profiles}

        for m in memberships:
            user = user_map.get(m.get("user_id", ""))
            if not user:
                continue
            # Email is management-only (guest-data-leak fix). Self-row
            # always shows own email — users already know their own.
            is_self = m.get("user_id") == ctx.app_user_id
            show_email = can_manage or is_self
            members.append(
                WorkspaceMember(
                    id=m["id"],
                    user_id=m["user_id"],
                    display_name=user.get("display_name", ""),
                    email=user.get("email", "") if show_email else "",
                    avatar=avatar_map.get(user.get("directus_user_id", "")),
                    role=m.get("role", ""),
                    source=m.get("source", ""),
                )
            )

    # Pending invites — management-only. Emails of not-yet-members aren't
    # anyone else's business.
    pending_invites: list[PendingInvite] = []
    pending_invites_raw: list = []
    if can_manage:
        pending_invites_raw_result = await async_directus.get_items(
            "workspace_invite",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": ctx.workspace_id},
                        "accepted_at": {"_null": True},
                        "deleted_at": {"_null": True},
                        "expires_at": {"_gt": datetime.now(timezone.utc).isoformat()},
                    },
                    "fields": ["id", "email", "role", "created_at", "invited_by", "expires_at"],
                    "sort": ["-created_at"],
                    "limit": 50,
                }
            },
        )
        if isinstance(pending_invites_raw_result, list):
            pending_invites_raw = pending_invites_raw_result
    if len(pending_invites_raw) > 0:
        # Resolve inviter names
        inviter_ids = list(
            {inv.get("invited_by") for inv in pending_invites_raw if inv.get("invited_by")}
        )
        inviter_name_map: dict[str, str] = {}
        if inviter_ids:
            inviters = await async_directus.get_items(
                "app_user",
                {
                    "query": {
                        "filter": {"id": {"_in": inviter_ids}},
                        "fields": ["id", "display_name"],
                        "limit": -1,
                    }
                },
            )
            if isinstance(inviters, list):
                inviter_name_map = {u["id"]: u.get("display_name") or "" for u in inviters}

        pending_invites = [
            PendingInvite(
                id=inv["id"],
                email=inv.get("email", ""),
                role=inv.get("role", ""),
                created_at=inv.get("created_at"),
                invited_by_name=inviter_name_map.get(inv.get("invited_by", "")) or None,
                expires_at=inv.get("expires_at"),
            )
            for inv in pending_invites_raw
        ]

    # Current user's effective policies — expand "*" into all known policies
    from dembrane.policies import WORKSPACE_ROLE_PRESETS, get_effective_policies

    effective = get_effective_policies(ctx.role, ctx.custom_policies, WORKSPACE_ROLE_PRESETS)
    if "*" in effective:
        # Owner gets all policies — show them explicitly instead of "*"
        all_policies = set()
        for preset_policies in WORKSPACE_ROLE_PRESETS.values():
            for p in preset_policies:
                if p != "*":
                    all_policies.add(p)
        effective = sorted(all_policies)

    from dembrane.billing_account import resolve_workspace_billing

    billing = await resolve_workspace_billing(ctx.workspace_id)
    # Cadence now lives on the billing account (single source of truth).
    # UI defaults to "annual" for display when null.
    billing_period = billing.get("billing_period")

    return WorkspaceDetailResponse(
        id=ws["id"],
        name=ws.get("name", ""),
        tier=billing.get("tier") or "",
        org_id=ws.get("org_id", ""),
        org_name=org_name,
        is_default=ws.get("is_default", False),
        legal_basis=ws.get("legal_basis"),
        privacy_policy_url=ws.get("privacy_policy_url"),
        description=ws.get("description"),
        members=members,
        pending_invites=pending_invites,
        my_role=ctx.role,
        my_policies=effective,
        inherit_organisation_admins=workspace_follows_organisation_admins(ws),
        inherit_organisation_members=workspace_follows_organisation_members(ws),
        logo_url=ws.get("logo_url"),
        type_discount=billing.get("type_discount"),
        percent_discount=billing.get("percent_discount"),
        billing_period=billing_period,
        billing_account_id=ws.get("billing_account_id"),
        billing_status=billing.get("status"),
        billing_org_managed=bool(billing.get("org_scoped")),
    )


# ── Update ──


class UpdateWorkspaceRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    logo_url: Optional[str] = None
    # Privacy flags — wizard step 2 equivalents. Flipping true→false makes
    # the workspace private; derivation stops on next access check.
    # Flipping false→true re-enables organisation-admin derivation (subject to the
    # per-user sticky_removed tombstones).
    inherit_organisation_admins: Optional[bool] = None
    inherit_organisation_members: Optional[bool] = None


# Only http/https logos allowed — blocks javascript:/data:/file:// URIs
# that would turn logo rendering into an XSS or SSRF vector downstream.
_LOGO_URL_SCHEMES = ("http://", "https://")


def _validate_logo_url(value: str) -> str:
    """Normalise + validate a logo URL. Raises HTTPException(400) on reject.

    Accepts absolute http(s) URLs only. Length-capped at 2048 to keep stored
    strings reasonable.
    """
    if value is None:
        return value  # caller should not pass None; noop-safe
    cleaned = value.strip()
    if cleaned == "":
        return ""
    if len(cleaned) > 2048:
        raise HTTPException(status_code=400, detail="Logo URL is too long")
    lower = cleaned.lower()
    if not lower.startswith(_LOGO_URL_SCHEMES):
        raise HTTPException(status_code=400, detail="Logo URL must start with http:// or https://")
    return cleaned


@router.patch("/{workspace_id}/settings")
async def update_workspace_settings(
    body: UpdateWorkspaceRequest,
    ctx: DependencyWorkspaceContext,
) -> dict:
    """Update workspace name/description/logo/privacy flags.

    Requires settings:manage. Making a workspace private is tier-gated at
    innovator+ via has_policy's workspace:set_private rule.
    """
    ctx.require_policy("settings:manage")

    payload: dict = {}
    if body.name is not None:
        # Strip control chars — this value ends up in email subject lines
        # (workspace_added / workspace_invite / upgrade_request).
        payload["name"] = body.name.replace("\r", " ").replace("\n", " ").strip()
    if body.description is not None:
        payload["description"] = body.description.strip()
    if body.logo_url is not None:
        # Whitelabel branding is tier-gated (changemaker+). Changing the
        # workspace logo is whitelabel — gate it here so the tier check
        # happens before the DB write, not only on downgrade.
        cleaned_logo = _validate_logo_url(body.logo_url)
        current_logo = ctx.workspace.get("logo_url") or ""
        if cleaned_logo != current_logo:
            ctx.require_policy("workspace:whitelabel")
        payload["logo_url"] = cleaned_logo or None

    # Privacy flags write into workspace.settings (existing JSON column).
    if (
        body.inherit_organisation_admins is not None
        or body.inherit_organisation_members is not None
    ):
        # Normalise NULL settings (legacy rows) to {} before dict ops.
        current_settings = ctx.workspace.get("settings") or {}
        if not isinstance(current_settings, dict):
            current_settings = {}
        # Setting inherit_organisation_admins=false makes the workspace private — gated.
        going_private = (
            body.inherit_organisation_admins is False
            and current_settings.get("inherit_organisation_admins", True) is not False
        )
        if going_private:
            ctx.require_policy("workspace:set_private")

        merged = dict(current_settings)
        if body.inherit_organisation_admins is not None:
            merged["inherit_organisation_admins"] = bool(body.inherit_organisation_admins)
        if body.inherit_organisation_members is not None:
            merged["inherit_organisation_members"] = bool(body.inherit_organisation_members)
        payload["settings"] = merged
        # Same mapping as workspace create (workspaces.py): discovery and
        # POST /access-requests filter on workspace.visibility — it must move
        # whenever Open↔Private toggles, not only settings JSON.
        inherit_admins_effective = bool(merged.get("inherit_organisation_admins", True))
        payload["visibility"] = "open_to_organisation" if inherit_admins_effective else "private"

    if not payload:
        raise HTTPException(status_code=400, detail="Nothing to update")

    await async_directus.update_item("workspace", ctx.workspace_id, payload)
    return {"status": "success"}


# ── Logo upload ──
#
# Mirrors the whitelabel-logo pattern on user-settings: file goes into the
# shared `custom_logos` Directus folder; we store only the bare file_id in
# `workspace.logo_url`. The frontend turns that into an /assets/{id} URL.
# Legacy rows with external http(s) URLs keep working — the frontend's
# logo-resolver returns those verbatim.


_ALLOWED_LOGO_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
}
# SVG is intentionally excluded: SVG can carry inline <script>, and files
# served from /assets/{id} are same-origin with the app. Until Directus
# is configured to strip script content on SVG (or we add our own magic-
# byte + script-tag sanitizer), PNG/JPEG/WebP only. Raster-only also
# means we can rely on magic bytes if we ever harden this further.
# 5 MB — same practical cap participant uploads use. Logos are tiny; larger
# than this is almost always a misfired upload.
_MAX_LOGO_BYTES = 5 * 1024 * 1024


def _get_or_create_custom_logos_folder_id() -> str | None:
    """Look up the custom_logos folder id, creating it if missing."""
    try:
        folders = directus.get(
            "/folders",
            params={"filter[name][_eq]": "custom_logos", "limit": 1},
        )
        if folders and len(folders) > 0:
            return folders[0]["id"]
        result = directus.post("/folders", json={"name": "custom_logos"})
        return result.get("data", {}).get("id")
    except Exception as e:
        logger.warning(f"Failed to get or create custom_logos folder: {e}")
        return None


@router.post("/{workspace_id}/logo")
async def upload_workspace_logo(
    file: UploadFile,
    ctx: DependencyWorkspaceContext,
) -> dict:
    """Upload a workspace logo file.

    Requires settings:manage + workspace:whitelabel (changemaker+).
    Replaces any existing logo and deletes the previous file if it was one
    we owned (bare file_id, not an external URL).
    """
    ctx.require_policy("settings:manage")
    ctx.require_policy("workspace:whitelabel")

    if file.content_type and file.content_type not in _ALLOWED_LOGO_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Logo must be PNG, JPEG, or WebP",
        )

    file_content = await file.read()
    if len(file_content) > _MAX_LOGO_BYTES:
        raise HTTPException(status_code=400, detail="Logo file is too large (max 5 MB)")
    if len(file_content) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    folder_id = _get_or_create_custom_logos_folder_id()
    if not folder_id:
        raise HTTPException(status_code=500, detail="Failed to prepare logo folder")

    url = f"{directus.url}/files"
    headers = {"Authorization": f"Bearer {directus.get_token()}"}
    files = {"file": (file.filename, file_content, file.content_type or "image/png")}
    data = {"folder": folder_id}
    try:
        response = requests.post(
            url, headers=headers, files=files, data=data, verify=directus.verify
        )
        if response.status_code != 200:
            logger.error(f"Failed to upload workspace logo: {response.status_code} {response.text}")
            raise HTTPException(status_code=500, detail="Failed to upload file") from None
        file_id = response.json()["data"]["id"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload workspace logo: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload file") from None

    # Track the previous value so we can GC the old file after the pointer moves.
    prev_logo = ctx.workspace.get("logo_url") or ""
    await async_directus.update_item("workspace", ctx.workspace_id, {"logo_url": file_id})

    if prev_logo and not prev_logo.lower().startswith(("http://", "https://")):
        try:
            await run_in_thread_pool(directus.delete_file, prev_logo)
        except Exception as e:
            logger.warning(f"Failed to delete old workspace logo {prev_logo}: {e}")

    return {"file_id": file_id}


@router.delete("/{workspace_id}/logo")
async def remove_workspace_logo(
    ctx: DependencyWorkspaceContext,
) -> dict:
    """Clear the workspace logo and delete the underlying file if we own it."""
    ctx.require_policy("settings:manage")

    prev_logo = ctx.workspace.get("logo_url") or ""
    if not prev_logo:
        return {"status": "ok"}

    await async_directus.update_item("workspace", ctx.workspace_id, {"logo_url": None})

    # Only delete files we manage; never touch external URLs.
    if not prev_logo.lower().startswith(("http://", "https://")):
        try:
            await run_in_thread_pool(directus.delete_file, prev_logo)
        except Exception as e:
            logger.warning(f"Failed to delete workspace logo {prev_logo}: {e}")

    return {"status": "ok"}


# ── Remove member ──


@router.delete("/{workspace_id}/members/{membership_id}")
async def remove_workspace_member(
    membership_id: str,
    ctx: DependencyWorkspaceContext,
) -> dict:
    """Soft-delete a workspace membership.

    Two callers:
      - Admin removing someone else (member:manage).
      - User removing themselves (self-leave; no policy required — it's
        always valid for a user to leave unless they're the last admin).

    Last-admin protection applies to both paths.
    """
    membership = await async_directus.get_item("workspace_membership", membership_id)
    if not membership or membership.get("workspace_id") != ctx.workspace_id:
        raise HTTPException(status_code=404, detail="Membership not found in this workspace")
    if membership.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Membership already removed")

    # Authorization: self-leave always allowed (for members + guests — HCD
    # audit 2026-04-23). Removing someone else requires member:manage.
    is_self_leave = membership.get("user_id") == ctx.app_user_id
    if not is_self_leave:
        ctx.require_policy("member:manage")

    if membership.get("role") == "owner":
        owners = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": ctx.workspace_id},
                        "role": {"_eq": "owner"},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": 2,
                }
            },
        )
        if isinstance(owners, list) and len(owners) <= 1:
            raise HTTPException(
                status_code=400, detail="Cannot remove the last owner. Transfer ownership first."
            )

    # Last-admin protection (matrix §4: last admin cannot be removed).
    # Applies to both self-leave and admin-removes-admin.
    if membership.get("role") == "admin":
        admins = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": ctx.workspace_id},
                        "role": {"_in": ["admin", "owner"]},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": 2,
                }
            },
        )
        if isinstance(admins, list) and len(admins) <= 1:
            raise HTTPException(
                status_code=400,
                detail=(
                    "You're the only admin. Promote someone else before leaving."
                    if is_self_leave
                    else "Can't remove the last admin. Promote someone else first."
                ),
            )

    await async_directus.update_item(
        "workspace_membership",
        membership_id,
        {"deleted_at": datetime.now(timezone.utc).isoformat()},
    )

    # Bust cached usage so seat / guest counts refresh on next read.
    from dembrane.cache_utils import invalidate_workspace_and_org_usage

    await invalidate_workspace_and_org_usage(ctx.workspace_id, ctx.workspace.get("org_id"))

    # Seat freed: reconcile billing so the next renewal drops to the new count
    # (no mid-cycle refund). Best-effort, never fail the removal on a billing hiccup.
    from dembrane.billing_service import (
        reconcile_account_seats,
        get_account_for_workspace,
    )

    try:
        billing_account = await get_account_for_workspace(ctx.workspace_id)
        if billing_account:
            await reconcile_account_seats(billing_account["id"])
    except Exception:
        logger.exception(
            "Seat reconcile failed after removing member from workspace %s",
            ctx.workspace_id,
        )

    removed_user_id = membership.get("user_id")
    if removed_user_id and removed_user_id != ctx.app_user_id:
        from dembrane.notifications import emit

        await emit(
            audience_user_id=removed_user_id,
            actor_user_id=ctx.app_user_id,
            event_code="WORKSPACE_REMOVED",
            title=f"You were removed from {ctx.workspace.get('name', 'a workspace')}",
            message="Reach out to the workspace admin if this was unexpected.",
            action="NONE",
            ref_workspace_id=ctx.workspace_id,
        )

    # Sticky-remove: if this user would otherwise re-derive admin/member
    # access via their org role (rule-of-system inheritance), tombstone
    # them so organisation-role changes don't silently re-grant access. Only
    # applies when the removed user has an active org_membership.
    from dembrane.inheritance import sticky_remove

    if removed_user_id and ctx.workspace.get("org_id"):
        # Check if they'd re-derive via org role — only tombstone if yes.
        org_rows = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": ctx.workspace["org_id"]},
                        "user_id": {"_eq": removed_user_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["role"],
                    "limit": 1,
                }
            },
        )
        if isinstance(org_rows, list) and org_rows:
            await sticky_remove(
                workspace_id=ctx.workspace_id,
                user_id=removed_user_id,
                by_user_id=ctx.app_user_id,
            )

    return {"status": "success"}


# ── Change member role ──


# Import (not duplicate) so escalation guards stay consistent with policies.py.
from dembrane.policies import ROLE_HIERARCHY  # noqa: E402


class ChangeRoleRequest(BaseModel):
    role: str


@router.patch("/{workspace_id}/members/{membership_id}")
async def change_member_role(
    membership_id: str,
    body: ChangeRoleRequest,
    ctx: DependencyWorkspaceContext,
) -> dict:
    """Change a member's role. Requires member:manage."""
    ctx.require_policy("member:manage")

    if body.role not in ("member", "billing", "admin", "owner"):
        raise HTTPException(status_code=400, detail="Invalid role")

    # Prevent escalation — can only set roles at or below your own level
    caller_level = ROLE_HIERARCHY.get(ctx.role, 0)
    requested_level = ROLE_HIERARCHY.get(body.role, 0)
    if requested_level > caller_level:
        raise HTTPException(status_code=403, detail="Cannot grant a role higher than your own")

    membership = await async_directus.get_item("workspace_membership", membership_id)
    if not membership or membership.get("workspace_id") != ctx.workspace_id:
        raise HTTPException(status_code=404, detail="Membership not found in this workspace")
    if membership.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Membership already removed")

    # Cross-boundary lever (ADR-0003): the role dropdown is not used to
    # promote an external into a non-external role (or vice versa). The
    # admin must take the cross-table action through the org settings
    # page: add to org, return to workspace, remove external row, re-invite
    # as member. Reject any attempt to flip the row across that boundary.
    current_role = membership.get("role")
    crossing_external_boundary = (current_role == "external" and body.role != "external") or (
        current_role != "external" and body.role == "external"
    )
    if crossing_external_boundary:
        raise HTTPException(
            status_code=400,
            detail=(
                "Cannot change a member into an external (or vice versa) from this "
                "dropdown. Add or remove the user via the org settings page, then "
                "re-invite them to the workspace."
            ),
        )

    # Prevent demoting the last owner
    if membership.get("role") == "owner" and body.role != "owner":
        owners = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": ctx.workspace_id},
                        "role": {"_eq": "owner"},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": 2,
                }
            },
        )
        if isinstance(owners, list) and len(owners) <= 1:
            raise HTTPException(
                status_code=400, detail="Cannot demote the last owner. Promote someone else first."
            )

    # Mirrors the last-owner guard so a direct API call can't strand the
    # workspace; the frontend lock alone isn't enough (matrix §4).
    if membership.get("role") == "admin" and body.role not in ("admin", "owner"):
        admins = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_eq": ctx.workspace_id},
                        "role": {"_in": ["admin", "owner"]},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": 2,
                }
            },
        )
        if isinstance(admins, list) and len(admins) <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot demote the last admin. Promote someone else first.",
            )

    await async_directus.update_item(
        "workspace_membership",
        membership_id,
        {"role": body.role},
    )

    # Role change can flip a row between seat-worthy and not (member ↔
    # billing keep counting; demotion to a non-seat role would shrink
    # the count). Bust the cache so the next read reflects it.
    from dembrane.cache_utils import invalidate_workspace_and_org_usage

    await invalidate_workspace_and_org_usage(ctx.workspace_id, ctx.workspace.get("org_id"))

    # A member <-> external flip changes the billed seat count, so reconcile the
    # account now instead of waiting for the cron. Best-effort + idempotent.
    try:
        from dembrane.billing_service import (
            get_account_for_workspace,
            reconcile_account_seats,
        )

        account = await get_account_for_workspace(ctx.workspace_id)
        if account:
            await reconcile_account_seats(account["id"])
    except Exception:
        logger.exception(
            "Seat reconcile failed after role change in workspace %s",
            ctx.workspace_id,
        )

    # Notify the affected user (unless they're the one making the change).
    if membership.get("user_id") and membership["user_id"] != ctx.app_user_id:
        from dembrane.notifications import emit

        await emit(
            audience_user_id=membership["user_id"],
            actor_user_id=ctx.app_user_id,
            event_code="WORKSPACE_ROLE_CHANGED",
            title=f"Your role changed in {ctx.workspace.get('name', 'a workspace')}",
            message=f"You're now a **{body.role}** here.",
            action="NAVIGATE_WS",
            ref_workspace_id=ctx.workspace_id,
        )

    return {"status": "success"}


# Resend/cancel of pending invites moved to api/v2/invite_actions.py (handles both invite types).
