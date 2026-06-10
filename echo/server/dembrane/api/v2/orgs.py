"""V2 organisation (org) endpoints.

`org` in code == "organisation" in user-facing copy. Decisions locked in
docs/workspaces/release-checklist.md:
  - D1: /organisation/:id in user-facing URLs; /v2/orgs/:id in the API
  - D2: admins + owners only create workspaces / manage organisation
  - D3: workspace roles independent of organisation roles
  - D4: inherited access is derived, not stored
  - D5: external guests never inherit

Endpoints here cover organisation-level management:
  GET    /v2/orgs                       — organisations the current user belongs to
  GET    /v2/orgs/:id                   — organisation detail (name, counts)
  PATCH  /v2/orgs/:id                   — rename, logo
  GET    /v2/orgs/:id/members           — organisation members (list view of Ask 1)
  POST   /v2/orgs/:id/members           — invite to organisation (non-external workspace invite)
  PATCH  /v2/orgs/:id/members/:uid      — change organisation role (member/admin/owner)
  DELETE /v2/orgs/:id/members/:uid      — soft-delete organisation membership
"""

from __future__ import annotations

import asyncio
from typing import Literal, Optional
from logging import getLogger
from datetime import datetime, timezone, timedelta

import requests
from fastapi import APIRouter, UploadFile, HTTPException
from pydantic import Field, EmailStr, BaseModel

from dembrane.utils import generate_uuid
from dembrane.app_user import resolve_app_user, get_app_user_or_raise
from dembrane.directus import directus
from dembrane.policies import ROLE_HIERARCHY
from dembrane.settings import get_settings
from dembrane.inheritance import is_org_external_only, on_organisation_member_removed
from dembrane.async_helpers import run_in_thread_pool
from dembrane.seat_capacity import (
    tier_hard_blocks_seats,
    compute_effective_seat_state,
)
from dembrane.tier_capacity import get_capacity
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.api.v2.invites import compute_invite_hash, _enqueue_invite_email
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

# Only http/https logos allowed — blocks javascript:/data: URIs. Shared
# logic lives in workspace_settings; duplicated here to avoid a cross-router
# import dependency. If a third place needs it, promote to a shared helper.
_LOGO_URL_SCHEMES = ("http://", "https://")


def _validate_logo_url(value: str) -> str:
    if value is None:
        return value
    cleaned = value.strip()
    if cleaned == "":
        return ""
    if len(cleaned) > 2048:
        raise HTTPException(status_code=400, detail="Logo URL is too long")
    if not cleaned.lower().startswith(_LOGO_URL_SCHEMES):
        raise HTTPException(status_code=400, detail="Logo URL must start with http:// or https://")
    return cleaned


router = APIRouter()
logger = getLogger("api.v2.orgs")

_VALID_ORG_ROLES = {"member", "admin", "billing", "owner"}

settings = get_settings()

# Per-surface (not aggregate): 20/hour; mirrors workspace_invite cap.
_org_invite_rate_limiter = create_user_rate_limiter(
    name="org_invite", capacity=20, window_seconds=3600
)


# ── Response shapes ─────────────────────────────────────────────────────


class OrgSummaryResponse(BaseModel):
    id: str
    name: str
    logo_url: Optional[str] = None
    role: str
    member_count: int
    workspace_count: int


class OrgMemberResponse(BaseModel):
    user_id: str
    app_user_id: str
    email: str
    display_name: str
    avatar: Optional[str] = None
    role: str
    # Workspace access is derived per-workspace (see inheritance.user_can_access)
    # but we give the organisation-admin page a rolled-up count for the list view.
    accessible_workspace_count: int = 0
    is_pending: bool = False  # placeholder — will cover pending org invites later
    # True when the user is only reachable through external workspace
    # memberships (no org_membership in this organisation). Frontend renders
    # the External badge and scopes organisation-level actions accordingly.
    # Derived from role='external' on the workspace_membership row (ADR-0003)
    # for response only — internal lookups key on role directly.
    is_external: bool = False
    # Direct workspace memberships: workspace_id → role. Powers the organisation
    # admin matrix page so non-admin organisation members with a direct invite
    # on a specific workspace aren't hidden. Includes role='external'
    # rows — frontend decides how to display.
    direct_workspace_roles: dict[str, str] = {}
    # Membership id per workspace so the organisation people tab can mutate a
    # row's role directly (PATCH /v2/workspaces/:ws/members/:membership).
    # Parallel to direct_workspace_roles (same keys).
    direct_workspace_membership_ids: dict[str, str] = {}


class OrgDetailResponse(BaseModel):
    id: str
    name: str
    # Short blurb shown on the organisation overview. Editable in settings.
    description: Optional[str] = None
    logo_url: Optional[str] = None
    role: str
    member_count: int
    workspace_count: int
    external_count: int = 0


class UpdateOrgRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    # Empty string clears the description; None leaves it untouched.
    description: Optional[str] = Field(default=None, max_length=2000)
    logo_url: Optional[str] = None


class InviteToOrganisationRequest(BaseModel):
    """Org-only invite payload.

    Org-level roles are member/admin/billing/owner; external is workspace-
    scoped only (ADR-0003) and not valid here. Out-of-enum values fail at
    Pydantic validation (422); the endpoint enforces role-hierarchy
    escalation rules separately.
    """

    email: EmailStr
    role: Literal["member", "admin", "billing", "owner"] = "member"


class InviteToOrganisationResponse(BaseModel):
    # invited | added | reactivated | already_member | already_invited
    status: str
    email: str
    user_existed: bool
    email_sent: bool = True


class ChangeMemberRoleRequest(BaseModel):
    role: str  # member/admin/owner


# ── Helpers ─────────────────────────────────────────────────────────────


async def _require_org_role(org_id: str, app_user_id: str, minimum: str = "member") -> str:
    """Return the caller's role in this org or raise 403.

    `minimum`: 'member' (any membership), 'admin' (admin+owner only),
    'owner' (owner only).
    """
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["role"],
                "limit": 1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=403, detail="No access to this organisation")
    role = rows[0].get("role", "")
    if minimum == "owner" and role != "owner":
        raise HTTPException(status_code=403, detail="Owner-only action")
    if minimum == "admin" and role not in ("admin", "owner"):
        raise HTTPException(status_code=403, detail="Organisation admins or owners only")
    return role


async def _count_organisation_members(org_id: str) -> int:
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "deleted_at": {"_null": True},
                },
                "aggregate": {"count": "id"},
            }
        },
    )
    if isinstance(rows, list) and rows:
        return int(rows[0].get("count", {}).get("id", 0) or 0)
    return 0


async def _count_organisation_workspaces(org_id: str) -> int:
    rows = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "deleted_at": {"_null": True},
                },
                "aggregate": {"count": "id"},
            }
        },
    )
    if isinstance(rows, list) and rows:
        return int(rows[0].get("count", {}).get("id", 0) or 0)
    return 0


async def _count_external_in_organisation(org_id: str) -> int:
    """Count distinct users who are external on any workspace in this organisation.

    External = has workspace_membership with role='external' and no
    org_membership in this org (ADR-0003). Informational; used by Ask 1
    header count.
    """
    workspaces = (
        await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(workspaces, list) or not workspaces:
        return 0
    ws_ids = [w["id"] for w in workspaces if w.get("id")]
    if not ws_ids:
        return 0

    rows = (
        await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_in": ws_ids},
                        "role": {"_eq": "external"},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["user_id"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(rows, list):
        return 0
    external_user_ids = {r["user_id"] for r in rows if r.get("user_id")}
    if not external_user_ids:
        return 0

    # Exclude users who are actually org members — keeps this in sync with
    # list_org_members()'s internal_set filter when stale external rows linger.
    internal_rows = (
        await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "user_id": {"_in": list(external_user_ids)},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["user_id"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if isinstance(internal_rows, list):
        external_user_ids -= {r["user_id"] for r in internal_rows if r.get("user_id")}
    return len(external_user_ids)


async def _invalidate_org_workspace_usage(org_id: str) -> None:
    """Bust the cached usage rollup for every workspace in an org plus the
    org-level rollup. Call after any org-membership mutation (role change,
    removal, on_organisation_member_removed) since derived seat counts on
    every workspace shift the moment org roles change.

    Best-effort — fails-quiet if Redis is down. The 30-min TTL is a
    backstop.
    """
    from dembrane.cache_utils import (
        invalidate_org_usage,
        invalidate_workspace_usage,
    )

    workspaces = (
        await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    # Org rollup once, per-workspace cache once each. Aggregating the
    # invalidations avoids the N×org_invalidate redundancy of calling the
    # combined helper inside the loop.
    await invalidate_org_usage(org_id)
    if not isinstance(workspaces, list):
        return
    for ws in workspaces:
        wid = ws.get("id")
        if not wid:
            continue
        await invalidate_workspace_usage(wid)


# ── Endpoints ───────────────────────────────────────────────────────────


@router.get("", response_model=list[OrgSummaryResponse])
async def list_my_orgs(
    auth: DependencyDirectusSession,
) -> list[OrgSummaryResponse]:
    """Every organisation the current user belongs to, with headline counts.

    Used by the app shell when the user opens the organisation switcher / nav.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    memberships = (
        await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["org_id", "role"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(memberships, list) or not memberships:
        return []

    org_ids = [m["org_id"] for m in memberships if m.get("org_id")]
    if not org_ids:
        return []

    orgs = (
        await async_directus.get_items(
            "org",
            {
                "query": {
                    "filter": {
                        "id": {"_in": org_ids},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id", "name", "logo_url"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(orgs, list):
        orgs = []
    org_map = {o["id"]: o for o in orgs}
    role_map = {m["org_id"]: m["role"] for m in memberships}

    out: list[OrgSummaryResponse] = []
    for org_id in org_ids:
        org = org_map.get(org_id)
        if not org:
            continue
        out.append(
            OrgSummaryResponse(
                id=org_id,
                name=org.get("name", ""),
                logo_url=org.get("logo_url"),
                role=role_map.get(org_id, "member"),
                member_count=await _count_organisation_members(org_id),
                workspace_count=await _count_organisation_workspaces(org_id),
            )
        )
    return out


@router.get("/{org_id}", response_model=OrgDetailResponse)
async def get_org(
    org_id: str,
    auth: DependencyDirectusSession,
) -> OrgDetailResponse:
    app_user = await get_app_user_or_raise(auth.user_id)
    role = await _require_org_role(org_id, app_user["id"], minimum="member")

    org = await async_directus.get_item("org", org_id)
    if not org or org.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Organisation not found")

    return OrgDetailResponse(
        id=org_id,
        name=org.get("name", ""),
        description=org.get("description"),
        logo_url=org.get("logo_url"),
        role=role,
        member_count=await _count_organisation_members(org_id),
        workspace_count=await _count_organisation_workspaces(org_id),
        external_count=await _count_external_in_organisation(org_id),
    )


@router.patch("/{org_id}", response_model=OrgDetailResponse)
async def update_org(
    org_id: str,
    body: UpdateOrgRequest,
    auth: DependencyDirectusSession,
) -> OrgDetailResponse:
    app_user = await get_app_user_or_raise(auth.user_id)
    await _require_org_role(org_id, app_user["id"], minimum="admin")

    payload: dict = {}
    if body.name is not None:
        # Strip control chars — org name can land in email subject lines
        # (upgrade_request, workspace_invite) via templating.
        payload["name"] = body.name.replace("\r", " ").replace("\n", " ").strip()
    if body.description is not None:
        # Trim trailing whitespace; an empty string clears the field.
        cleaned_description = body.description.strip()
        payload["description"] = cleaned_description or None
    if body.logo_url is not None:
        # Org-level logo is legacy/optional — workspace-level whitelabel
        # takes precedence per the release lock (workspace-scoped, not
        # org-scoped). Validate scheme regardless so we don't land
        # javascript:/data: URIs.
        cleaned = _validate_logo_url(body.logo_url)
        payload["logo_url"] = cleaned or None
    if not payload:
        raise HTTPException(status_code=400, detail="Nothing to update")

    await async_directus.update_item("org", org_id, payload)
    return await get_org(org_id, auth)


# ── Organisation logo upload ──
# Mirrors the workspace-logo pattern: bare file_id stored in org.logo_url;
# frontend resolves via logoUrl() helper. Legacy external URLs keep working.

_ALLOWED_LOGO_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
}
# SVG excluded — see workspace_settings.py for rationale (stored XSS
# via <script> in SVG; /assets/ is same-origin). Keep the two sets in
# lockstep.
_MAX_LOGO_BYTES = 5 * 1024 * 1024


def _get_or_create_custom_logos_folder_id() -> str | None:
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


@router.post("/{org_id}/logo")
async def upload_org_logo(
    org_id: str,
    file: UploadFile,
    auth: DependencyDirectusSession,
) -> dict:
    """Upload a organisation logo. Admin/owner only."""
    app_user = await get_app_user_or_raise(auth.user_id)
    await _require_org_role(org_id, app_user["id"], minimum="admin")

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
            logger.error(
                f"Failed to upload organisation logo: {response.status_code} {response.text}"
            )
            raise HTTPException(status_code=500, detail="Failed to upload file") from None
        file_id = response.json()["data"]["id"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload organisation logo: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload file") from None

    org = await async_directus.get_item("org", org_id)
    prev_logo = (org or {}).get("logo_url") or ""
    await async_directus.update_item("org", org_id, {"logo_url": file_id})

    if prev_logo and not prev_logo.lower().startswith(("http://", "https://")):
        try:
            await run_in_thread_pool(directus.delete_file, prev_logo)
        except Exception as e:
            logger.warning(f"Failed to delete old organisation logo {prev_logo}: {e}")

    return {"file_id": file_id}


@router.delete("/{org_id}/logo")
async def remove_org_logo(
    org_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    app_user = await get_app_user_or_raise(auth.user_id)
    await _require_org_role(org_id, app_user["id"], minimum="admin")

    org = await async_directus.get_item("org", org_id)
    prev_logo = (org or {}).get("logo_url") or ""
    if not prev_logo:
        return {"status": "ok"}

    await async_directus.update_item("org", org_id, {"logo_url": None})
    if not prev_logo.lower().startswith(("http://", "https://")):
        try:
            await run_in_thread_pool(directus.delete_file, prev_logo)
        except Exception as e:
            logger.warning(f"Failed to delete organisation logo {prev_logo}: {e}")
    return {"status": "ok"}


@router.get("/{org_id}/members", response_model=list[OrgMemberResponse])
async def list_org_members(
    org_id: str,
    auth: DependencyDirectusSession,
) -> list[OrgMemberResponse]:
    """Organisation members list. Anyone in the organisation can read this (members need to
    see who their admins are, per Q3 decision: we don't build an "ask an
    admin" CTA, but members should still be able to find them).

    Email redaction: mirrors the workspace-settings pattern — only organisation
    admins/owners see the full email. Members see display_name only.
    A member always sees their own email (self-row).
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(org_id, app_user["id"], minimum="member")
    can_manage = caller_role in ("admin", "owner")

    memberships = (
        await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["user_id", "role"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(memberships, list):
        memberships = []

    internal_ids = [m["user_id"] for m in memberships if m.get("user_id")]
    internal_set = set(internal_ids)

    # External users: workspace_membership(role='external') on any
    # workspace in this organisation, minus anyone already in internal_set. These
    # users have no org_membership but need to appear in the organisation Members
    # list so admins can see every person reaching their data (ADR-0003).
    ws_rows = (
        await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    organisation_ws_ids = [
        w["id"] for w in (ws_rows if isinstance(ws_rows, list) else []) if w.get("id")
    ]

    external_ids: list[str] = []
    if organisation_ws_ids:
        ext_rows = (
            await async_directus.get_items(
                "workspace_membership",
                {
                    "query": {
                        "filter": {
                            "workspace_id": {"_in": organisation_ws_ids},
                            "role": {"_eq": "external"},
                            "deleted_at": {"_null": True},
                        },
                        "fields": ["user_id"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        if isinstance(ext_rows, list):
            seen = set()
            for r in ext_rows:
                uid = r.get("user_id")
                if not uid or uid in internal_set or uid in seen:
                    continue
                seen.add(uid)
                external_ids.append(uid)

    user_ids = internal_ids + external_ids
    if not user_ids:
        return []

    # Batch-fetch app_user rows + directus_users for avatars.
    app_users = (
        await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": user_ids}},
                    "fields": ["id", "directus_user_id", "display_name", "email"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(app_users, list):
        app_users = []
    app_user_map = {u["id"]: u for u in app_users}

    directus_ids = [u["directus_user_id"] for u in app_users if u.get("directus_user_id")]
    avatar_map: dict[str, Optional[str]] = {}
    if directus_ids:
        du_rows = (
            await async_directus.get_users(
                {
                    "query": {
                        "filter": {"id": {"_in": directus_ids}},
                        "fields": ["id", "avatar"],
                        "limit": -1,
                    }
                }
            )
            or []
        )
        if isinstance(du_rows, list):
            avatar_map = {u["id"]: u.get("avatar") for u in du_rows}

    # Count workspaces each user can access. Internals: _rollup covers
    # both direct + derived. Externals: no derivation possible (D5), so
    # it's just the count of their external direct memberships.
    workspace_counts = await _rollup_workspace_access(org_id, internal_ids)

    # Direct workspace roles per organisation user — keyed {user_id: {workspace_id: role}}.
    # Powers the matrix page so direct-invited members on specific
    # workspaces show correctly (they were hidden before when the
    # matrix relied on derivation alone). Dedup'd by (workspace_id,
    # user_id) with direct-over-inherited priority. Includes externals
    # since their workspace_membership rows match the same query.
    direct_roles, direct_membership_ids = await _direct_workspace_roles_by_user(org_id, user_ids)

    out: list[OrgMemberResponse] = []
    for m in memberships:
        uid = m["user_id"]
        app_row = app_user_map.get(uid) or {}
        du_id = app_row.get("directus_user_id") or ""
        is_self = uid == app_user["id"]
        show_email = can_manage or is_self
        out.append(
            OrgMemberResponse(
                user_id=uid,
                app_user_id=uid,
                email=(app_row.get("email") or "") if show_email else "",
                display_name=app_row.get("display_name") or "",
                avatar=avatar_map.get(du_id) if du_id else None,
                role=m.get("role", "member"),
                accessible_workspace_count=workspace_counts.get(uid, 0),
                is_external=False,
                direct_workspace_roles=direct_roles.get(uid, {}),
                direct_workspace_membership_ids=direct_membership_ids.get(uid, {}),
            )
        )

    # Externals: no org role to show, so role=="external" tells the
    # frontend to render the External badge. Organisation-level actions
    # (change organisation role) aren't offered for these rows — only
    # per-workspace role edits and "Remove from organisation" (cascades
    # all external rows in this org).
    for uid in external_ids:
        app_row = app_user_map.get(uid) or {}
        du_id = app_row.get("directus_user_id") or ""
        ext_workspace_count = len(direct_roles.get(uid, {}))
        out.append(
            OrgMemberResponse(
                user_id=uid,
                app_user_id=uid,
                # Externals' emails always show to managers — admins need
                # to see who an external actually is. Non-managers can't
                # reach this endpoint as admin anyway (can_manage gate).
                email=(app_row.get("email") or "") if can_manage else "",
                display_name=app_row.get("display_name") or "",
                avatar=avatar_map.get(du_id) if du_id else None,
                role="external",
                accessible_workspace_count=ext_workspace_count,
                is_external=True,
                direct_workspace_roles=direct_roles.get(uid, {}),
                direct_workspace_membership_ids=direct_membership_ids.get(uid, {}),
            )
        )
    return out


class OrgPendingInviteResponse(BaseModel):
    id: str
    type: Literal["org", "workspace"]
    email: str
    role: str
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    created_at: Optional[str] = None
    expires_at: Optional[str] = None
    invited_by_id: Optional[str] = None
    invited_by_name: Optional[str] = None
    invited_by_email: Optional[str] = None


@router.get("/{org_id}/pending-invites", response_model=list[OrgPendingInviteResponse])
async def list_org_pending_invites(
    org_id: str,
    auth: DependencyDirectusSession,
    workspace_id: Optional[str] = None,
) -> list[OrgPendingInviteResponse]:
    """Pending org-only + workspace invitations for this organisation.

    Admin-only. Returns the union of `org_invite` and `workspace_invite`
    rows where `accepted_at IS NULL AND deleted_at IS NULL AND
    expires_at > now()`, sorted by `created_at DESC` (ADR 0004).

    Pass `?workspace_id=` to narrow to a single workspace's invites; the
    response then excludes org-typed rows entirely (workspace members
    page never shows org-only invites).
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    await _require_org_role(org_id, app_user["id"], minimum="admin")

    now_iso = datetime.now(timezone.utc).isoformat()

    ws_rows = (
        await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(ws_rows, list):
        ws_rows = []
    ws_name_map = {w["id"]: w.get("name", "") for w in ws_rows if w.get("id")}
    ws_ids_in_org = list(ws_name_map.keys())

    # `workspace_id` scopes to that workspace if it's in this org; mismatches return [] rather than leaking cross-org.
    scope_ws_ids: list[str] = []
    include_org_invites = True
    if workspace_id is not None:
        if workspace_id not in ws_name_map:
            return []
        scope_ws_ids = [workspace_id]
        include_org_invites = False
    else:
        scope_ws_ids = ws_ids_in_org

    org_invites: list[dict] = []
    if include_org_invites:
        org_invites = (
            await async_directus.get_items(
                "org_invite",
                {
                    "query": {
                        "filter": {
                            "org_id": {"_eq": org_id},
                            "accepted_at": {"_null": True},
                            "deleted_at": {"_null": True},
                            "expires_at": {"_gt": now_iso},
                        },
                        "fields": [
                            "id",
                            "email",
                            "role",
                            "created_at",
                            "expires_at",
                            "invited_by",
                        ],
                        "sort": ["-created_at"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        if not isinstance(org_invites, list):
            org_invites = []

    workspace_invites: list[dict] = []
    if scope_ws_ids:
        workspace_invites = (
            await async_directus.get_items(
                "workspace_invite",
                {
                    "query": {
                        "filter": {
                            "workspace_id": {"_in": scope_ws_ids},
                            "accepted_at": {"_null": True},
                            "deleted_at": {"_null": True},
                            "expires_at": {"_gt": now_iso},
                        },
                        "fields": [
                            "id",
                            "email",
                            "role",
                            "workspace_id",
                            "created_at",
                            "expires_at",
                            "invited_by",
                        ],
                        "sort": ["-created_at"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        if not isinstance(workspace_invites, list):
            workspace_invites = []

    if not org_invites and not workspace_invites:
        return []

    inviter_ids = {
        inv.get("invited_by") for inv in (*org_invites, *workspace_invites) if inv.get("invited_by")
    }
    inviter_map: dict[str, dict] = {}
    if inviter_ids:
        inviter_rows = (
            await async_directus.get_items(
                "app_user",
                {
                    "query": {
                        "filter": {"id": {"_in": list(inviter_ids)}},
                        "fields": ["id", "display_name", "email"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        if isinstance(inviter_rows, list):
            inviter_map = {u["id"]: u for u in inviter_rows if u.get("id")}

    def _inviter_fields(inv: dict) -> dict:
        info = inviter_map.get(inv.get("invited_by") or "", {})
        return {
            "invited_by_id": inv.get("invited_by") or None,
            "invited_by_name": (info.get("display_name") or None) if info else None,
            "invited_by_email": (info.get("email") or None) if info else None,
        }

    org_rows = [
        OrgPendingInviteResponse(
            id=inv["id"],
            type="org",
            email=inv.get("email", ""),
            role=inv.get("role", "member"),
            workspace_id=None,
            workspace_name=None,
            created_at=inv.get("created_at"),
            expires_at=inv.get("expires_at"),
            **_inviter_fields(inv),
        )
        for inv in org_invites
    ]
    ws_rows_out = [
        OrgPendingInviteResponse(
            id=inv["id"],
            type="workspace",
            email=inv.get("email", ""),
            role=inv.get("role", "member"),
            workspace_id=inv.get("workspace_id"),
            workspace_name=ws_name_map.get(inv.get("workspace_id") or "", ""),
            created_at=inv.get("created_at"),
            expires_at=inv.get("expires_at"),
            **_inviter_fields(inv),
        )
        for inv in workspace_invites
    ]

    # Merge-sort by created_at DESC; null created_at goes last.
    combined = org_rows + ws_rows_out
    combined.sort(key=lambda r: (r.created_at or ""), reverse=True)
    return combined


@router.post("/{org_id}/invites", response_model=InviteToOrganisationResponse)
async def invite_to_organisation(
    org_id: str,
    body: InviteToOrganisationRequest,
    auth: DependencyDirectusSession,
) -> InviteToOrganisationResponse:
    """Invite a user to an organisation without selecting any workspace.

    The "org-only" path (ADR 0004). Branches on invitee state:

      - Existing Directus user not in org → create org_membership, send
        "you've been added" email. status='added'.
      - Existing user already in org      → idempotent no-op.
                                              status='already_member', no email.
      - Existing user, soft-deleted org_membership → reactivate (clear
                                              deleted_at, update role).
                                              status='reactivated', send email.
      - No Directus user                  → create org_invite row, send
                                              invite email with hash-protected
                                              URL. status='invited'.

    Org-level invite power is admin/owner. Role-escalation guard rejects
    requests where the caller's hierarchy level is below the requested role.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(org_id, app_user["id"], minimum="admin")

    email = body.email.strip().lower()
    role = body.role

    # Role-escalation guard: caller can only grant roles at or below their own.
    inviter_level = ROLE_HIERARCHY.get(caller_role, 0)
    requested_level = ROLE_HIERARCHY.get(role, 0)
    if requested_level > inviter_level:
        raise HTTPException(status_code=403, detail="Cannot grant a role higher than your own")

    inviter_email = (app_user.get("email") or "").lower()
    if inviter_email and inviter_email == email:
        raise HTTPException(status_code=400, detail="Cannot invite yourself")

    # Rate-limit after validation gates so spam doesn't burn legitimate quota.
    await _org_invite_rate_limiter.check(app_user["id"])

    org_row = await async_directus.get_item("org", org_id)
    if not org_row or org_row.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Organisation not found")
    org_name = org_row.get("name") or "your organisation"

    inviter_name = app_user.get("display_name") or "An admin"

    users = await async_directus.get_users(
        {
            "query": {
                "filter": {"email": {"_eq": email}},
                "fields": ["id", "email", "first_name", "last_name"],
                "limit": 1,
            }
        },
    )
    user_existed = isinstance(users, list) and len(users) > 0

    if user_existed:
        directus_user = users[0]
        invitee_app_user = await resolve_app_user(directus_user["id"])

        if invitee_app_user:
            # Include soft-deleted so we reactivate rather than duplicate.
            existing = await async_directus.get_items(
                "org_membership",
                {
                    "query": {
                        "filter": {
                            "org_id": {"_eq": org_id},
                            "user_id": {"_eq": invitee_app_user["id"]},
                        },
                        "fields": ["id", "role", "deleted_at"],
                        "limit": 1,
                    }
                },
            )

            if isinstance(existing, list) and len(existing) > 0:
                row = existing[0]
                if row.get("deleted_at") is None:
                    return InviteToOrganisationResponse(
                        status="already_member",
                        email=email,
                        user_existed=True,
                        email_sent=False,
                    )

                await async_directus.update_item(
                    "org_membership",
                    row["id"],
                    {"deleted_at": None, "role": role},
                )
                logger.info(
                    f"Reactivated org_membership for {email} in org {org_id} "
                    f"as {role} by {app_user['id']}"
                )
                email_queued = _enqueue_invite_email(
                    to=email,
                    subject=f"You've been re-added to {org_name}",
                    template="org_added",
                    template_data={
                        "inviter_name": inviter_name,
                        "org_name": org_name,
                        "role": role,
                        "invite_url": f"{settings.urls.admin_base_url}/o/{org_id}",
                    },
                    failure_context=f"org_reactivated / org {org_id}",
                )
                return InviteToOrganisationResponse(
                    status="reactivated",
                    email=email,
                    user_existed=True,
                    email_sent=email_queued,
                )

            from dembrane.api.v2._invite_helpers import create_membership_row

            await create_membership_row(
                async_directus,
                "org_membership",
                {
                    "id": generate_uuid(),
                    "org_id": org_id,
                    "user_id": invitee_app_user["id"],
                    "role": role,
                },
            )
            logger.info(f"Added {email} to org {org_id} as {role} by {app_user['id']}")

            # Notify other org admins so they see the new member appear.
            try:
                from dembrane.notifications import (
                    emit_to_audience,
                    audience_organisation_admins,
                )

                admin_ids = await audience_organisation_admins(org_id)
                admin_ids = [
                    a for a in admin_ids if a != app_user["id"] and a != invitee_app_user["id"]
                ]
                new_member_name = invitee_app_user.get("display_name") or email
                if admin_ids:
                    await emit_to_audience(
                        admin_ids,
                        actor_user_id=app_user["id"],
                        event_code="ORGANISATION_MEMBER_ADDED",
                        title=f"{new_member_name} joined {org_name}",
                        message="They're now an organisation member.",
                        action="NAVIGATE_ORGANISATION_SETTINGS",
                        ref_org_id=org_id,
                    )
            except Exception:
                logger.exception("Failed to emit ORGANISATION_MEMBER_ADDED notification")

            email_queued = _enqueue_invite_email(
                to=email,
                subject=f"You've been added to {org_name}",
                template="org_added",
                template_data={
                    "inviter_name": inviter_name,
                    "org_name": org_name,
                    "role": role,
                    "invite_url": f"{settings.urls.admin_base_url}/o/{org_id}",
                },
                failure_context=f"org_added / org {org_id}",
            )
            return InviteToOrganisationResponse(
                status="added",
                email=email,
                user_existed=True,
                email_sent=email_queued,
            )

    # New invitee or user without app_user: create org_invite row; onboarding resolves the membership at first login.
    now_iso = datetime.now(timezone.utc).isoformat()
    existing_invites = await async_directus.get_items(
        "org_invite",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "email": {"_eq": email},
                    "accepted_at": {"_null": True},
                    "deleted_at": {"_null": True},
                    "expires_at": {"_gt": now_iso},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    if isinstance(existing_invites, list) and len(existing_invites) > 0:
        # 200 with status string so the modal renders this per-row rather than as a global failure.
        return InviteToOrganisationResponse(
            status="already_invited",
            email=email,
            user_existed=user_existed,
            email_sent=False,
        )

    invite_id = generate_uuid()
    now_dt = datetime.now(timezone.utc)
    expires_at = (now_dt + timedelta(days=7)).isoformat()
    await async_directus.create_item(
        "org_invite",
        {
            "id": invite_id,
            "org_id": org_id,
            "email": email,
            "role": role,
            "invited_by": app_user["id"],
            "expires_at": expires_at,
            # Set explicitly so a future migration dropping the Directus `date-created` special doesn't NULL these.
            "created_at": now_dt.isoformat(),
        },
    )

    from urllib.parse import urlencode

    invite_hash = compute_invite_hash(invite_id)
    ctx_params = urlencode(
        {
            "iss": inviter_name,
            "org": org_name,
            "role": role,
            "email": email,
            "h": invite_hash,
        }
    )
    invite_url = f"{settings.urls.admin_base_url}/invite/accept?{ctx_params}"

    email_queued = _enqueue_invite_email(
        to=email,
        subject=f"{inviter_name} invited you to {org_name} on dembrane",
        template="org_invite",
        template_data={
            "inviter_name": inviter_name,
            "org_name": org_name,
            "role": role,
            "invite_url": invite_url,
        },
        failure_context=f"org_invite / org {org_id}",
    )

    logger.info(
        f"Invited {email} to org {org_id} as {role} by {app_user['id']} "
        f"(user_existed: {user_existed}, email_queued: {email_queued})"
    )

    return InviteToOrganisationResponse(
        status="invited",
        email=email,
        user_existed=user_existed,
        email_sent=email_queued,
    )


async def _direct_workspace_roles_by_user(
    org_id: str, user_ids: list[str]
) -> tuple[dict[str, dict[str, str]], dict[str, dict[str, str]]]:
    """Return two parallel maps:
      roles: {user_id: {workspace_id: role}}
      ids:   {user_id: {workspace_id: membership_id}}

    One DB call for the whole organisation page. Dedup'd (workspace_id, user_id)
    since pre-walkback data can carry inherited+direct rows for the
    same pair (matrix §7 one seat per person per workspace). IDs power
    the per-workspace role picker on the organisation People tab.
    """
    if not user_ids:
        return {}, {}

    ws_rows = (
        await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    ws_ids = [w["id"] for w in (ws_rows if isinstance(ws_rows, list) else []) if w.get("id")]
    if not ws_ids:
        return {}, {}

    mem_rows = (
        await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_in": ws_ids},
                        "user_id": {"_in": user_ids},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id", "workspace_id", "user_id", "role", "source"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(mem_rows, list):
        return {}, {}

    # Dedup (workspace_id, user_id): direct > inherited.
    by_pair: dict[tuple[str, str], dict] = {}
    for m in mem_rows:
        wid = m.get("workspace_id")
        uid = m.get("user_id")
        if not wid or not uid:
            continue
        key = (wid, uid)
        existing = by_pair.get(key)
        if existing is None or (m.get("source") == "direct" and existing.get("source") != "direct"):
            by_pair[key] = m

    roles: dict[str, dict[str, str]] = {}
    ids: dict[str, dict[str, str]] = {}
    for (wid, uid), row in by_pair.items():
        roles.setdefault(uid, {})[wid] = row.get("role", "member")
        membership_id = row.get("id")
        if membership_id:
            ids.setdefault(uid, {})[wid] = membership_id
    return roles, ids


async def _rollup_workspace_access(org_id: str, user_ids: list[str]) -> dict[str, int]:
    """For each user, count how many workspaces in this organisation they can access.

    Access = direct workspace_membership OR derived via org role + settings.
    Done in Python over the organisation's workspaces to match the derivation logic
    in dembrane.inheritance exactly.
    """
    from dembrane.inheritance import user_can_access

    workspaces = (
        await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(workspaces, list) or not workspaces:
        return {uid: 0 for uid in user_ids}

    counts = {uid: 0 for uid in user_ids}
    for w in workspaces:
        for uid in user_ids:
            if await user_can_access(w["id"], uid):
                counts[uid] += 1
    # Note: O(users × workspaces) round-trips. Fine at current scale; if a
    # organisation ever grows past ~50 workspaces × 50 members we should batch-fetch
    # org_memberships + workspace.settings once and derive in-process.
    return counts


class OrgWorkspacePinnedProject(BaseModel):
    """Minimal pinned-project info for the org overview workspace cards."""

    id: str
    name: str = ""


class OrgWorkspaceSummary(BaseModel):
    id: str
    name: str
    tier: str
    is_default: bool
    project_count: int = 0
    member_count: int = 0
    is_private: bool = False  # settings.inherit_organisation_admins == false
    # Unified seat cap gate. True when seats_used (members + guests) meets
    # or exceeds included_seats on a hard-blocking tier (free, pilot).
    seat_invite_blocked: bool = False
    # Includes pending workspace_invite rows; conservatively overestimates re-invites (backend dedups at submit).
    seats_used_including_pending: int = 0
    seat_cap: int | None = None  # null on unlimited tiers
    # Top pinned projects per workspace, for the org overview cards. Member
    # avatars + usage hours are NOT here: the overview drives those from the
    # caller's own /v2/workspaces list (membership-scoped), so we only enrich
    # the one thing that endpoint can't provide. Default keeps id/name-only
    # consumers (the sidebar) unaffected.
    pinned_projects: list[OrgWorkspacePinnedProject] = []


async def _get_org_workspace_pinned(
    ws_id: str, caller_is_manager: bool
) -> list[OrgWorkspacePinnedProject]:
    """Top-3 pinned projects for a workspace, for the org overview cards.

    Managers see every pinned project; everyone else only non-private ones so
    a member never sees a pinned private project they can't open. (Mirrors the
    conservative end of workspace_projects._visibility_filter_for_caller — we
    skip the shared/creator ladder here and just hide private, which can omit a
    shared-private pin but never leaks one.)
    """
    filt: dict = {
        "workspace_id": {"_eq": ws_id},
        "deleted_at": {"_null": True},
        "pin_order": {"_nnull": True},
    }
    if not caller_is_manager:
        filt["_or"] = [
            {"visibility": {"_neq": "private"}},
            {"visibility": {"_null": True}},
        ]
    rows = await async_directus.get_items(
        "project",
        {
            "query": {
                "fields": ["id", "name", "pin_order"],
                "filter": filt,
                "sort": ["pin_order"],
                "limit": 3,
            }
        },
    )
    if not isinstance(rows, list):
        return []
    return [
        OrgWorkspacePinnedProject(id=r["id"], name=r.get("name") or "")
        for r in rows
        if r.get("id")
    ]


@router.get("/{org_id}/workspaces", response_model=list[OrgWorkspaceSummary])
async def list_organisation_workspaces(
    org_id: str,
    auth: DependencyDirectusSession,
) -> list[OrgWorkspaceSummary]:
    """Workspaces in the organisation that the caller can see.

    - Org admin/owner: every workspace in the org.
    - Org member: every non-private workspace in the org.
    - Guest (no org membership, but has at least one workspace_membership in
      the org): just the workspaces they're a direct member of. Counts and
      tier still populated so the response model stays uniform — the
      sidebar uses id/name only, but other surfaces want the rest.
    """
    app_user = await get_app_user_or_raise(auth.user_id)

    # Resolve the caller's org role without raising — a guest with workspace
    # access in this org has no org_membership but should still see "the
    # basics" (which workspaces they're in). 5xx and other unexpected
    # failures bubble up.
    caller_role: str | None = None
    try:
        caller_role = await _require_org_role(org_id, app_user["id"], minimum="member")
    except HTTPException as e:
        if e.status_code != 403:
            raise
    caller_is_manager = caller_role in ("admin", "owner")
    is_org_member = caller_role is not None

    # An external-only caller (outsider with a stale org_membership) is scoped
    # exactly like a guest: only the workspaces they directly belong to. Real
    # members and managers are unaffected, so OrganisationRoute and InviteModal
    # keep their current behavior.
    if (
        is_org_member
        and not caller_is_manager
        and await is_org_external_only(org_id, app_user["id"])
    ):
        is_org_member = False

    ws_filter: dict = {
        "org_id": {"_eq": org_id},
        "deleted_at": {"_null": True},
    }

    if not is_org_member:
        # Guest path: restrict to workspaces the caller is a direct member
        # of (workspace_membership row). If none, they have no view here.
        membership_rows = (
            await async_directus.get_items(
                "workspace_membership",
                {
                    "query": {
                        "filter": {
                            "user_id": {"_eq": app_user["id"]},
                            "deleted_at": {"_null": True},
                        },
                        "fields": ["workspace_id"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        if not isinstance(membership_rows, list):
            membership_rows = []
        accessible_ids = [r["workspace_id"] for r in membership_rows if r.get("workspace_id")]
        if not accessible_ids:
            raise HTTPException(status_code=403, detail="No access to this organisation")
        ws_filter["id"] = {"_in": accessible_ids}

    # Pull settings.inherit_organisation_admins explicitly (sub-field projection)
    # so we don't need to send the whole JSON. Counts come from separate
    # aggregates because the workspace collection doesn't declare O2M aliases.
    workspaces = (
        await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": ws_filter,
                    "fields": [
                        "id",
                        "name",
                        "tier",
                        "is_default",
                        "settings",
                    ],
                    "sort": ["-is_default", "name"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(workspaces, list) or not workspaces:
        return []

    ws_ids = [w["id"] for w in workspaces if w.get("id")]

    # Batch per-workspace counts with group-by so one call covers the organisation.
    project_counts: dict[str, int] = {}
    member_counts: dict[str, int] = {}
    if ws_ids:
        project_agg = await async_directus.get_items(
            "project",
            {
                "query": {
                    "aggregate": {"count": "id"},
                    "groupBy": ["workspace_id"],
                    "filter": {
                        "workspace_id": {"_in": ws_ids},
                        "deleted_at": {"_null": True},
                    },
                }
            },
        )
        if isinstance(project_agg, list):
            for row in project_agg:
                wid = row.get("workspace_id")
                cnt = int((row.get("count") or {}).get("id", 0) or 0)
                if wid:
                    project_counts[wid] = cnt

        member_agg = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "aggregate": {"count": "id"},
                    "groupBy": ["workspace_id"],
                    "filter": {
                        "workspace_id": {"_in": ws_ids},
                        "deleted_at": {"_null": True},
                    },
                }
            },
        )
        if isinstance(member_agg, list):
            for row in member_agg:
                wid = row.get("workspace_id")
                cnt = int((row.get("count") or {}).get("id", 0) or 0)
                if wid:
                    member_counts[wid] = cnt

    # Hide private workspaces from non-admin organisation members — the whole
    # point of a private workspace is that organisation admins can't see it,
    # advertising its name + tier in a organisation-scoped list contradicts that.
    # Admins/owners still see the full roster. Guests already came in via
    # direct membership so we don't filter them here (they ARE the audience
    # for those private workspaces).
    out: list[OrgWorkspaceSummary] = []
    for ws in workspaces:
        settings = ws.get("settings") if isinstance(ws.get("settings"), dict) else {}
        is_private = (settings or {}).get("inherit_organisation_admins") is False
        if is_org_member and is_private and not caller_is_manager:
            continue

        # Cap-blocked flags. Compute lazily — only call get_effective_members
        # when the tier has finite caps, since the whole point of the wizard
        # disabling cards is hard-block tiers (Pilot) and finite guest caps.
        # Skip for Guardian (unlimited) and unknown tiers. Counts pending
        # workspace_invite rows on top of effective members so the wizard
        # disables a card the moment outstanding invites have saturated
        # the cap, not only after they're accepted.
        tier = (ws.get("tier") or "").lower()
        cap = get_capacity(tier)
        seat_blocked = False
        seats_used_total: int = 0
        seat_cap_value: int | None = None
        if cap is not None and cap.included_seats is not None:
            from dembrane.seat_capacity import count_pending_invites

            seats_used, _member_count, _external_count = await compute_effective_seat_state(
                ws["id"]
            )
            member_pending, external_pending = await count_pending_invites(ws["id"])
            total_pending = member_pending + external_pending
            seats_used_total = seats_used + total_pending
            seat_cap_value = cap.included_seats
            if tier_hard_blocks_seats(tier) and seats_used_total >= cap.included_seats:
                seat_blocked = True

        out.append(
            OrgWorkspaceSummary(
                id=ws["id"],
                name=ws.get("name", ""),
                tier=ws.get("tier", "pioneer"),
                is_default=bool(ws.get("is_default", False)),
                project_count=project_counts.get(ws["id"], 0),
                member_count=member_counts.get(ws["id"], 0),
                is_private=is_private,
                seat_invite_blocked=seat_blocked,
                seats_used_including_pending=seats_used_total,
                seat_cap=seat_cap_value,
            )
        )

    # Pinned-projects enrichment for the overview cards. Member avatars + usage
    # hours come from the caller's own /v2/workspaces list (membership-scoped),
    # so we don't recompute them per org workspace here. Fanned out in parallel.
    if out:
        pinned_lists = await asyncio.gather(
            *[_get_org_workspace_pinned(o.id, caller_is_manager) for o in out]
        )
        for o, pinned in zip(out, pinned_lists, strict=True):
            o.pinned_projects = pinned

    return out


@router.patch("/{org_id}/members/{user_id}")
async def change_member_role(
    org_id: str,
    user_id: str,
    body: ChangeMemberRoleRequest,
    auth: DependencyDirectusSession,
) -> dict:
    """Change a organisation member's role. Admin+owner only. Owners can promote
    another member to owner (ownership transfer is not yet scoped as a
    separate endpoint, but a role=owner PATCH is the mechanism).
    """
    if body.role not in _VALID_ORG_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")

    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(org_id, app_user["id"], minimum="admin")

    # Only owners can promote to owner or demote an existing owner.
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "role"],
                "limit": 1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=404, detail="Member not found")
    target = rows[0]
    target_role = target.get("role")

    if (body.role == "owner" or target_role == "owner") and caller_role != "owner":
        raise HTTPException(
            status_code=403,
            detail="Only an owner can promote to owner or demote another owner",
        )

    # Last-admin guard: if the target currently has a management role
    # (admin or owner) and the new role is neither, block when they're the
    # only remaining person with management rights. Keeps organisations from ending
    # up leaderless through self-demotion or a well-meaning role change.
    if target_role in ("admin", "owner") and body.role not in ("admin", "owner"):
        other_admins = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "role": {"_in": ["admin", "owner"]},
                        "user_id": {"_neq": user_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id"],
                    "limit": 1,
                }
            },
        )
        if not (isinstance(other_admins, list) and other_admins):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Can't demote the last admin. Promote someone else to admin or owner first."
                ),
            )

    # Hard rule: a user who is currently external on any of the organisation's
    # workspaces can never be organisation admin or owner. External-of-a-organisation means
    # "they're not really part of this organisation" — promoting them into the
    # admin chair contradicts that. If they should be admin, un-external
    # them first by removing those workspace rows and re-inviting as
    # organisation members.
    if body.role in ("admin", "owner"):
        # Look across this organisation's workspaces for any active direct row
        # with role='external' for this user.
        workspaces = (
            await async_directus.get_items(
                "workspace",
                {
                    "query": {
                        "filter": {
                            "org_id": {"_eq": org_id},
                            "deleted_at": {"_null": True},
                        },
                        "fields": ["id"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        if isinstance(workspaces, list) and workspaces:
            ws_ids = [w["id"] for w in workspaces if w.get("id")]
            if ws_ids:
                external_rows = await async_directus.get_items(
                    "workspace_membership",
                    {
                        "query": {
                            "filter": {
                                "user_id": {"_eq": user_id},
                                "workspace_id": {"_in": ws_ids},
                                "role": {"_eq": "external"},
                                "deleted_at": {"_null": True},
                            },
                            "fields": ["id"],
                            "limit": 1,
                        }
                    },
                )
                if isinstance(external_rows, list) and external_rows:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "This person is an external on one of the "
                            "organisation's workspaces. Clear that first — they can't "
                            "hold organisation admin/owner while marked as external."
                        ),
                    )

    await async_directus.update_item("org_membership", target["id"], {"role": body.role})
    # Note: derived model means no membership fan-out needed — next access
    # check on any workspace re-derives from the new role.

    # Bust workspace-usage cache for every workspace in the org. Org
    # admins/owners are derived seats; promoting/demoting changes the
    # effective seat count on every workspace they can reach. Without
    # this, /v2/workspaces/:id/usage shows stale numbers for up to
    # USAGE_TTL_SECONDS after a role change.
    await _invalidate_org_workspace_usage(org_id)

    # Notify the affected user (unless they changed their own role).
    if user_id != app_user["id"]:
        organisation_row = await async_directus.get_item("org", org_id)
        organisation_name = (organisation_row or {}).get("name") or "your organisation"
        from dembrane.notifications import emit

        await emit(
            audience_user_id=user_id,
            actor_user_id=app_user["id"],
            event_code="ORGANISATION_ROLE_CHANGED",
            title=f"Your role in {organisation_name} changed",
            message=f"You're now a **{body.role}** in {organisation_name}.",
            action="NAVIGATE_ORGANISATION_SETTINGS",
            ref_org_id=org_id,
        )

    logger.info(
        f"Organisation {org_id} role change: user {user_id} "
        f"{target_role} → {body.role} by {app_user['id']}"
    )
    return {"status": "updated", "role": body.role}


@router.delete("/{org_id}/members/{user_id}")
async def remove_organisation_member(
    org_id: str,
    user_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Soft-delete the organisation membership. Cascades via inheritance helper:
    user loses all source='direct' rows on workspaces in this organisation; derived
    access stops automatically because org_membership is gone.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(org_id, app_user["id"], minimum="admin")

    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "role"],
                "limit": 1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        # No internal org_membership — the target may still be a guest
        # (external on one or more workspaces in this organisation). Treat
        # DELETE as "remove all their external access here" so the Organisation
        # Members list has one consistent "Remove from organisation" action for
        # both internals and guests.
        ws_rows_for_ext = (
            await async_directus.get_items(
                "workspace",
                {
                    "query": {
                        "filter": {
                            "org_id": {"_eq": org_id},
                            "deleted_at": {"_null": True},
                        },
                        "fields": ["id"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        ext_ws_ids = [
            w["id"]
            for w in (ws_rows_for_ext if isinstance(ws_rows_for_ext, list) else [])
            if w.get("id")
        ]
        ext_rows: list[dict] = []
        if ext_ws_ids:
            found = (
                await async_directus.get_items(
                    "workspace_membership",
                    {
                        "query": {
                            "filter": {
                                "workspace_id": {"_in": ext_ws_ids},
                                "user_id": {"_eq": user_id},
                                "role": {"_eq": "external"},
                                "deleted_at": {"_null": True},
                            },
                            "fields": ["id", "workspace_id"],
                            "limit": -1,
                        }
                    },
                )
                or []
            )
            if isinstance(found, list):
                ext_rows = found
        if not ext_rows:
            raise HTTPException(status_code=404, detail="Member not found")

        now_iso = datetime.now(timezone.utc).isoformat()
        for r in ext_rows:
            mid = r.get("id")
            if mid:
                await async_directus.update_item(
                    "workspace_membership", mid, {"deleted_at": now_iso}
                )
        logger.info(
            f"Removed guest {user_id} from organisation {org_id} by {app_user['id']} — "
            f"soft-deleted {len(ext_rows)} external workspace_membership row(s)"
        )
        return {
            "status": "removed",
            "workspace_memberships_deleted": len(ext_rows),
        }
    target = rows[0]

    # Owners can only be removed by owners. Extra guard: don't allow
    # removing the last owner (organisation would be leaderless).
    if target.get("role") == "owner":
        if caller_role != "owner":
            raise HTTPException(status_code=403, detail="Only an owner can remove an owner")
        owners = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "role": {"_eq": "owner"},
                        "deleted_at": {"_null": True},
                    },
                    "aggregate": {"count": "id"},
                }
            },
        )
        owner_count = 0
        if isinstance(owners, list) and owners:
            owner_count = int(owners[0].get("count", {}).get("id", 0) or 0)
        if owner_count <= 1:
            raise HTTPException(
                status_code=409,
                detail="Can't remove the last owner. Transfer ownership first.",
            )

    now_iso = datetime.now(timezone.utc).isoformat()
    await async_directus.update_item("org_membership", target["id"], {"deleted_at": now_iso})

    affected = await on_organisation_member_removed(org_id, user_id)

    # Bust workspace + org usage caches: derived seat counts shift the
    # moment an org-level role disappears. Without this, /v2/.../usage
    # serves stale numbers for up to USAGE_TTL_SECONDS.
    await _invalidate_org_workspace_usage(org_id)

    # Notify the removed user — they'll see workspaces drop from their
    # selector; this gives them the honest explanation.
    if user_id != app_user["id"]:
        organisation_row = await async_directus.get_item("org", org_id)
        organisation_name = (organisation_row or {}).get("name") or "the organisation"
        from dembrane.notifications import emit

        await emit(
            audience_user_id=user_id,
            actor_user_id=app_user["id"],
            event_code="ORGANISATION_REMOVED",
            title=f"You were removed from {organisation_name}",
            message=(
                "Workspace access that depended on your organisation role has ended. "
                "Reach out to a organisation admin if this was unexpected."
            ),
            action="NONE",
            ref_org_id=org_id,
        )

    logger.info(
        f"Removed user {user_id} from organisation {org_id} by {app_user['id']} — "
        f"soft-deleted direct memberships on {len(affected)} workspace(s)"
    )
    return {
        "status": "removed",
        "workspace_memberships_deleted": len(affected),
    }


# ────────────────────────────────────────────────────────────────────
# Organisation-level usage rollup (matrix §8 organisation-scope)
# ────────────────────────────────────────────────────────────────────


class OrgUsageWorkspaceRow(BaseModel):
    id: str
    name: str
    tier: str
    is_private: bool = False
    audio_hours: float
    hours_included: Optional[int]  # None = unlimited tier
    hours_pct: Optional[float]  # 0..1 progress; None when unlimited
    hours_over: float  # max(0, audio_hours - hours_included)
    seat_count: int = 0
    seats_included: Optional[int] = None
    seats_pct: Optional[float] = None  # 0..1 progress; None when unlimited
    at_cap: bool  # Pilot + at/over cap
    approaching_cap: bool  # >=80% on capped tiers
    approaching_seat_cap: bool = False  # >=80% on capped seats
    seat_cap_hit: bool = False  # seat_count >= seats_included
    downgraded_at: Optional[str] = None
    # Externals share the seat pool. Count exposed separately for breakdown.
    external_count: int = 0
    # Admin / billing only:
    overage_forecast_eur: Optional[float] = None


class OrgUsageResponse(BaseModel):
    cycle_start: str
    cycle_end_exclusive: str
    workspace_count: int
    total_audio_hours: float
    # Unified seat total across all workspaces (members + externals).
    total_seat_count: int
    total_external_count: int
    total_project_count: int
    workspaces_at_cap: int  # Pilot + over cap (hard block active)
    workspaces_approaching_cap: int  # tier with cap, usage >= 80%
    workspaces: list[OrgUsageWorkspaceRow] = []
    # Admin / billing only (null for plain members):
    total_overage_forecast_eur: Optional[float] = None


@router.get("/{org_id}/usage", response_model=OrgUsageResponse)
async def get_org_usage(
    org_id: str,
    auth: DependencyDirectusSession,
    refresh: bool = False,
    month_offset: int = 0,
) -> OrgUsageResponse:
    """Organisation-wide usage rollup across all active workspaces in the org.

    `month_offset` (0 = current, 1 = last month, capped at 12) lets admins
    audit prior cycles. Forecast is null for historical months.

    Cached 30 min, keyed by (org_id, month_offset). Pass `?refresh=true`
    to bypass.

    Access:
      - Any organisation member can read raw numbers.
      - Admin / billing (org:view_invoices) additionally receive
        total_overage_forecast_eur.
    """
    from dembrane.cache_utils import (
        USAGE_TTL_SECONDS,
        cache_get_json,
        cache_set_json,
    )
    from dembrane.tier_capacity import (
        get_capacity,
        compute_hour_overage_eur,
    )
    from dembrane.api.v2.workspaces import _calendar_month_bounds

    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(org_id, app_user["id"], minimum="member")
    sees_financials = caller_role in ("admin", "owner", "billing")

    if month_offset < 0 or month_offset > 12:
        raise HTTPException(status_code=400, detail="month_offset must be 0–12")
    is_current_month = month_offset == 0

    cache_key = f"org_usage:{org_id}"
    if not is_current_month:
        cache_key = f"{cache_key}:m{month_offset}"
    if not refresh:
        cached = await cache_get_json(cache_key)
        if isinstance(cached, dict):
            if not sees_financials:
                cached = {**cached, "total_overage_forecast_eur": None}
            return OrgUsageResponse(**cached)

    # Cycle bounds.
    now = datetime.now(timezone.utc)
    cycle_start, cycle_end_exclusive = _calendar_month_bounds(now, month_offset)

    # All active workspaces in this org. Fetch `settings` + `downgraded_at`
    # so the per-workspace row can surface private-state and recent
    # downgrades (powers the "Needs attention" panel on the organisation usage
    # tab).
    workspaces = (
        await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": [
                        "id",
                        "name",
                        "tier",
                        "settings",
                        "downgraded_at",
                    ],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(workspaces, list):
        workspaces = []

    ws_ids = [w["id"] for w in workspaces if w.get("id")]

    # Soft-deleted rows stay in the rollup (PRD §270, delete preserves
    # billable duration). project_count below is the live count.
    # TODO: PRD §218 usage_event table replaces this scan path; until
    # then this fetches every project across every workspace in the org.
    project_count = 0
    per_ws_hours: dict[str, float] = {w["id"]: 0.0 for w in workspaces if w.get("id")}
    if ws_ids:
        projects = (
            await async_directus.get_items(
                "project",
                {
                    "query": {
                        "filter": {
                            "workspace_id": {"_in": ws_ids},
                        },
                        "fields": ["id", "workspace_id", "deleted_at"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        if isinstance(projects, list):
            project_count = sum(1 for p in projects if not p.get("deleted_at"))
            ws_by_project = {
                p["id"]: p["workspace_id"]
                for p in projects
                if p.get("id") and p.get("workspace_id")
            }
            pids = list(ws_by_project.keys())
            if pids:
                conversations = (
                    await async_directus.get_items(
                        "conversation",
                        {
                            "query": {
                                "filter": {
                                    "project_id": {"_in": pids},
                                    "created_at": {
                                        "_gte": cycle_start,
                                        "_lt": cycle_end_exclusive,
                                    },
                                },
                                "fields": ["project_id", "duration"],
                                "limit": -1,
                            }
                        },
                    )
                    or []
                )
                if isinstance(conversations, list):
                    for c in conversations:
                        pid = c.get("project_id")
                        ws_id = ws_by_project.get(pid) if pid else None
                        if not ws_id:
                            continue
                        per_ws_hours[ws_id] = per_ws_hours.get(ws_id, 0.0) + (
                            int(c.get("duration") or 0) / 3600.0
                        )

    # Effective seat + guest counts per workspace. Uses
    # compute_effective_seat_state (which delegates to
    # inheritance.get_effective_members) so derived org admins/owners
    # count as seats, matching /v2/workspaces/:id/usage. The previous
    # implementation walked workspace_membership directly and missed
    # derived rows, producing a stale "seat_count" on the org rollup
    # that didn't match the per-workspace UI.
    # total_seat_count is the unified pool (members + externals) per
    # ADR-0003. Per-workspace rows expose member/external split.
    total_seat_count = 0
    total_external_count = 0
    per_ws_seats: dict[str, int] = {wid: 0 for wid in ws_ids}
    per_ws_externals: dict[str, int] = {wid: 0 for wid in ws_ids}
    if ws_ids:
        seat_state_results = await asyncio.gather(
            *[compute_effective_seat_state(wid) for wid in ws_ids]
        )
        for wid, (seats_used, _member_count, external_count) in zip(
            ws_ids, seat_state_results, strict=True
        ):
            per_ws_seats[wid] = seats_used
            per_ws_externals[wid] = external_count
            total_seat_count += seats_used
            total_external_count += external_count

    # Per-workspace rows + aggregation. We build the rows even when the
    # caller doesn't see financials — the €-field is stripped below.
    total_hours = 0.0
    at_cap = 0
    approaching = 0
    forecast = 0.0
    ws_rows: list[dict] = []
    for w in workspaces:
        wid = w.get("id") or ""
        name = w.get("name") or ""
        tier = w.get("tier") or ""
        settings = w.get("settings") or {}
        if not isinstance(settings, dict):
            settings = {}
        # Private = inherit_organisation_admins flipped off (matrix §6). Absence
        # of the flag means "open" (legacy default).
        is_private = settings.get("inherit_organisation_admins") is False
        hours = per_ws_hours.get(wid, 0.0) if wid else 0.0
        total_hours += hours

        cap = get_capacity(tier)
        hours_included: Optional[int] = cap.included_hours if cap else None
        hours_pct: Optional[float] = None
        seats_included: Optional[int] = cap.included_seats if cap else None
        seat_count = per_ws_seats.get(wid, 0)
        seats_pct: Optional[float] = (
            round(seat_count / seats_included, 3)
            if seats_included is not None and seats_included > 0
            else None
        )
        seat_cap_hit = seats_included is not None and seat_count >= seats_included
        approaching_seat_cap = seats_pct is not None and seats_pct >= 0.8 and not seat_cap_hit
        external_count = per_ws_externals.get(wid, 0)
        ws_at_cap = False
        ws_approaching = False
        ws_forecast_eur = 0.0

        if cap and cap.included_hours is not None:
            pct = hours / cap.included_hours if cap.included_hours else 0.0
            hours_pct = round(pct, 3)
            if cap.hard_block_on_hours and hours >= cap.included_hours:
                at_cap += 1
                ws_at_cap = True
            elif pct >= 0.8:
                approaching += 1
                ws_approaching = True
            # Forecast is end-of-cycle; nonsensical for closed months.
            ws_forecast_eur = compute_hour_overage_eur(tier, hours) if is_current_month else 0.0
            forecast += ws_forecast_eur

        hours_over = (
            round(max(0.0, hours - hours_included), 2) if hours_included is not None else 0.0
        )
        ws_rows.append(
            {
                "id": wid,
                "name": name,
                "tier": tier,
                "is_private": is_private,
                "audio_hours": round(hours, 2),
                "hours_included": hours_included,
                "hours_pct": hours_pct,
                "hours_over": hours_over,
                "seat_count": seat_count,
                "seats_included": seats_included,
                "seats_pct": seats_pct,
                "seat_cap_hit": seat_cap_hit,
                "approaching_seat_cap": approaching_seat_cap,
                "external_count": external_count,
                "at_cap": ws_at_cap,
                "approaching_cap": ws_approaching,
                "downgraded_at": w.get("downgraded_at"),
                "overage_forecast_eur": (round(ws_forecast_eur, 2) if is_current_month else None),
            }
        )

    # Sort: at-cap first, then approaching, then by hours desc — Organisation admins
    # reading top-to-bottom hit the hot workspaces immediately.
    ws_rows.sort(
        key=lambda r: (
            0 if r["at_cap"] else 1 if r["approaching_cap"] else 2,
            -r["audio_hours"],
        )
    )

    payload = {
        "cycle_start": cycle_start,
        "cycle_end_exclusive": cycle_end_exclusive,
        "workspace_count": len(workspaces),
        "total_audio_hours": round(total_hours, 2),
        "total_seat_count": total_seat_count,
        "total_external_count": total_external_count,
        "total_project_count": project_count,
        "workspaces_at_cap": at_cap,
        "workspaces_approaching_cap": approaching,
        "workspaces": ws_rows,
        "total_overage_forecast_eur": (round(forecast, 2) if is_current_month else None),
    }

    await cache_set_json(cache_key, payload, USAGE_TTL_SECONDS)

    if not sees_financials:
        # Strip both the aggregate and each per-workspace € figure for
        # plain members — matrix §8 says members see raw hours only.
        stripped_rows = [{**r, "overage_forecast_eur": None} for r in ws_rows]
        payload = {
            **payload,
            "total_overage_forecast_eur": None,
            "workspaces": stripped_rows,
        }

    return OrgUsageResponse.model_validate(payload)


# ────────────────────────────────────────────────────────────────────
# Organisation-wide projects listing (for the organisation admin projects view)
# ────────────────────────────────────────────────────────────────────


class OrgProjectRow(BaseModel):
    id: str
    name: str
    workspace_id: str
    workspace_name: str
    visibility: str
    conversation_count: int = 0
    # All-time audio hours across this project's conversations. Matches
    # the workspace usage calc (sum(duration seconds) / 3600).
    audio_hours: float = 0.0
    created_at: Optional[str] = None


@router.get("/{org_id}/projects", response_model=list[OrgProjectRow])
async def list_organisation_projects(
    org_id: str,
    auth: DependencyDirectusSession,
) -> list[OrgProjectRow]:
    """Every project across every workspace in the organisation.

    Matrix §4: delete-workspace requires empty. Without a cross-organisation
    projects view, organisation admins have to walk into each workspace to clear
    it before winding down. This endpoint powers the "Projects" view on
    the organisation page where admins can scan + soft-delete at scale.

    Organisation admin/owner only — members have no cross-workspace project
    reach per matrix §5.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    await _require_org_role(org_id, app_user["id"], minimum="admin")

    # Workspaces in the organisation.
    workspaces = (
        await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(workspaces, list) or not workspaces:
        return []

    ws_by_id: dict[str, str] = {w["id"]: w.get("name") or "" for w in workspaces if w.get("id")}
    ws_ids = list(ws_by_id.keys())

    projects = (
        await async_directus.get_items(
            "project",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_in": ws_ids},
                        "deleted_at": {"_null": True},
                    },
                    "fields": [
                        "id",
                        "name",
                        "workspace_id",
                        "visibility",
                        "created_at",
                    ],
                    "sort": ["-created_at"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(projects, list):
        return []

    # Per-project conversation-count + duration sum. One fetch with the
    # two fields we need; aggregate on the client so we don't need two
    # separate Directus group-by calls (the current SDK doesn't return
    # both count + sum from a single aggregate cleanly).
    pid_list = [p["id"] for p in projects if p.get("id")]
    conv_counts: dict[str, int] = {}
    conv_seconds: dict[str, float] = {}
    if pid_list:
        convs = (
            await async_directus.get_items(
                "conversation",
                {
                    "query": {
                        "filter": {
                            "project_id": {"_in": pid_list},
                            "deleted_at": {"_null": True},
                        },
                        "fields": ["project_id", "duration"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        if isinstance(convs, list):
            for row in convs:
                pid = row.get("project_id")
                if not pid:
                    continue
                conv_counts[pid] = conv_counts.get(pid, 0) + 1
                dur = row.get("duration") or 0
                conv_seconds[pid] = conv_seconds.get(pid, 0.0) + float(dur)

    out: list[OrgProjectRow] = []
    for p in projects:
        wid = p.get("workspace_id")
        if not wid or wid not in ws_by_id:
            continue
        pid = p["id"]
        out.append(
            OrgProjectRow(
                id=pid,
                name=p.get("name") or "",
                workspace_id=wid,
                workspace_name=ws_by_id[wid],
                visibility=p.get("visibility") or "workspace",
                conversation_count=conv_counts.get(pid, 0),
                audio_hours=round(conv_seconds.get(pid, 0.0) / 3600, 1),
                created_at=p.get("created_at"),
            )
        )
    return out


# ────────────────────────────────────────────────────────────────────
# Referral ledger (matrix §10, partner read view)
# ────────────────────────────────────────────────────────────────────


class ReferralLedgerRow(BaseModel):
    id: str
    workspace_id: str
    workspace_name: str
    partner_team_id: str
    partner_kickback_percent: int
    starts_at: str
    expires_at: Optional[str] = None
    notes: Optional[str] = None


@router.get(
    "/{org_id}/referral-ledger",
    response_model=list[ReferralLedgerRow],
)
async def list_org_referral_ledger(
    org_id: str,
    auth: DependencyDirectusSession,
) -> list[ReferralLedgerRow]:
    """Matrix §10: a partner organisation reads its own referral ledger here to
    see which workspaces they earn a kickback on + terms.

    Staff edit the ledger elsewhere (post-release staff console). This
    endpoint is read-only and returns entries where partner_team_id
    equals the requested org. Organisation admin/owner/billing only — regular
    members don't see financial terms per matrix §7.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(org_id, app_user["id"], minimum="member")
    if caller_role not in ("admin", "owner", "billing"):
        raise HTTPException(status_code=403, detail="Organisation admin or billing role only")

    rows = (
        await async_directus.get_items(
            "referral_ledger",
            {
                "query": {
                    "filter": {
                        "partner_team_id": {"_eq": org_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": [
                        "id",
                        "workspace_id",
                        "partner_team_id",
                        "partner_kickback_percent",
                        "starts_at",
                        "expires_at",
                        "notes",
                    ],
                    "sort": ["-starts_at"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(rows, list) or not rows:
        return []

    # Join workspace names — batched.
    ws_ids = sorted({r["workspace_id"] for r in rows if r.get("workspace_id")})
    ws_name_map: dict[str, str] = {}
    if ws_ids:
        ws_rows = (
            await async_directus.get_items(
                "workspace",
                {
                    "query": {
                        "filter": {"id": {"_in": ws_ids}},
                        "fields": ["id", "name"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        if isinstance(ws_rows, list):
            ws_name_map = {w["id"]: w.get("name") or "" for w in ws_rows}

    out: list[ReferralLedgerRow] = []
    for r in rows:
        out.append(
            ReferralLedgerRow(
                id=r["id"],
                workspace_id=r["workspace_id"],
                workspace_name=ws_name_map.get(r["workspace_id"], ""),
                partner_team_id=r["partner_team_id"],
                partner_kickback_percent=int(r.get("partner_kickback_percent", 20) or 20),
                starts_at=r.get("starts_at") or "",
                expires_at=r.get("expires_at"),
                notes=r.get("notes"),
            )
        )
    return out
