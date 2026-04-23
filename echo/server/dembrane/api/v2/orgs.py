"""V2 team (org) endpoints.

`org` in code == "team" in user-facing copy. Decisions locked in
docs/workspaces/release-checklist.md:
  - D1: /team/:id in user-facing URLs; /v2/orgs/:id in the API
  - D2: admins + owners only create workspaces / manage team
  - D3: workspace roles independent of team roles
  - D4: inherited access is derived, not stored
  - D5: external guests never inherit

Endpoints here cover team-level management:
  GET    /v2/orgs                       — teams the current user belongs to
  GET    /v2/orgs/:id                   — team detail (name, counts)
  PATCH  /v2/orgs/:id                   — rename, logo
  GET    /v2/orgs/:id/members           — team members (list view of Ask 1)
  POST   /v2/orgs/:id/members           — invite to team (include_org_membership=true)
  PATCH  /v2/orgs/:id/members/:uid      — change team role (member/admin/owner)
  DELETE /v2/orgs/:id/members/:uid      — soft-delete team membership
"""

from __future__ import annotations

from datetime import datetime, timezone
from logging import getLogger
from typing import Optional

import requests
from fastapi import APIRouter, HTTPException, UploadFile
from pydantic import BaseModel, EmailStr, Field

from dembrane.directus import directus
from dembrane.async_helpers import run_in_thread_pool

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
        raise HTTPException(
            status_code=400, detail="Logo URL must start with http:// or https://"
        )
    return cleaned

from dembrane.utils import generate_uuid
from dembrane.app_user import get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.inheritance import on_team_member_removed
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.orgs")

_VALID_ORG_ROLES = {"member", "admin", "owner"}


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
    # but we give the team-admin page a rolled-up count for the list view.
    accessible_workspace_count: int = 0
    is_pending: bool = False  # placeholder — will cover pending org invites later
    # Direct workspace memberships: workspace_id → role. Powers the team
    # admin matrix page so non-admin team members with a direct invite
    # on a specific workspace aren't hidden. Includes is_external=true
    # rows (guests) — frontend decides how to display.
    direct_workspace_roles: dict[str, str] = {}


class OrgDetailResponse(BaseModel):
    id: str
    name: str
    logo_url: Optional[str] = None
    role: str
    member_count: int
    workspace_count: int
    external_count: int = 0


class UpdateOrgRequest(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    logo_url: Optional[str] = None


class InviteToTeamRequest(BaseModel):
    email: EmailStr
    role: str = "member"  # member/admin/owner


class ChangeMemberRoleRequest(BaseModel):
    role: str  # member/admin/owner


# ── Helpers ─────────────────────────────────────────────────────────────


async def _require_org_role(
    org_id: str, app_user_id: str, minimum: str = "member"
) -> str:
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
        raise HTTPException(status_code=403, detail="No access to this team")
    role = rows[0].get("role", "")
    if minimum == "owner" and role != "owner":
        raise HTTPException(status_code=403, detail="Owner-only action")
    if minimum == "admin" and role not in ("admin", "owner"):
        raise HTTPException(status_code=403, detail="Team admins or owners only")
    return role


async def _count_team_members(org_id: str) -> int:
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


async def _count_team_workspaces(org_id: str) -> int:
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


async def _count_external_in_team(org_id: str) -> int:
    """Count distinct users who are external on any workspace in this team.

    External = has workspace_membership with is_external=True and no
    org_membership in this org. Informational; used by Ask 1 header count.
    """
    workspaces = await async_directus.get_items(
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
    ) or []
    if not isinstance(workspaces, list) or not workspaces:
        return 0
    ws_ids = [w["id"] for w in workspaces if w.get("id")]
    if not ws_ids:
        return 0

    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_in": ws_ids},
                    "is_external": {"_eq": True},
                    "deleted_at": {"_null": True},
                },
                "fields": ["user_id"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(rows, list):
        return 0
    return len({r["user_id"] for r in rows if r.get("user_id")})


# ── Endpoints ───────────────────────────────────────────────────────────


@router.get("", response_model=list[OrgSummaryResponse])
async def list_my_orgs(
    auth: DependencyDirectusSession,
) -> list[OrgSummaryResponse]:
    """Every team the current user belongs to, with headline counts.

    Used by the app shell when the user opens the team switcher / nav.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    memberships = await async_directus.get_items(
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
    ) or []
    if not isinstance(memberships, list) or not memberships:
        return []

    org_ids = [m["org_id"] for m in memberships if m.get("org_id")]
    if not org_ids:
        return []

    orgs = await async_directus.get_items(
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
    ) or []
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
                member_count=await _count_team_members(org_id),
                workspace_count=await _count_team_workspaces(org_id),
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
        raise HTTPException(status_code=404, detail="Team not found")

    return OrgDetailResponse(
        id=org_id,
        name=org.get("name", ""),
        logo_url=org.get("logo_url"),
        role=role,
        member_count=await _count_team_members(org_id),
        workspace_count=await _count_team_workspaces(org_id),
        external_count=await _count_external_in_team(org_id),
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


# ── Team logo upload ──
# Mirrors the workspace-logo pattern: bare file_id stored in org.logo_url;
# frontend resolves via logoUrl() helper. Legacy external URLs keep working.

_ALLOWED_LOGO_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/svg+xml",
    "image/webp",
}
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
    """Upload a team logo. Admin/owner only."""
    app_user = await get_app_user_or_raise(auth.user_id)
    await _require_org_role(org_id, app_user["id"], minimum="admin")

    if file.content_type and file.content_type not in _ALLOWED_LOGO_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Logo must be PNG, JPEG, SVG, or WebP",
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
            logger.error(f"Failed to upload team logo: {response.status_code} {response.text}")
            raise HTTPException(status_code=500, detail="Failed to upload file") from None
        file_id = response.json()["data"]["id"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload team logo: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload file") from None

    org = await async_directus.get_item("org", org_id)
    prev_logo = (org or {}).get("logo_url") or ""
    await async_directus.update_item("org", org_id, {"logo_url": file_id})

    if prev_logo and not prev_logo.lower().startswith(("http://", "https://")):
        try:
            await run_in_thread_pool(directus.delete_file, prev_logo)
        except Exception as e:
            logger.warning(f"Failed to delete old team logo {prev_logo}: {e}")

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
            logger.warning(f"Failed to delete team logo {prev_logo}: {e}")
    return {"status": "ok"}


@router.get("/{org_id}/members", response_model=list[OrgMemberResponse])
async def list_org_members(
    org_id: str,
    auth: DependencyDirectusSession,
) -> list[OrgMemberResponse]:
    """Team members list. Anyone in the team can read this (members need to
    see who their admins are, per Q3 decision: we don't build an "ask an
    admin" CTA, but members should still be able to find them).

    Email redaction: mirrors the workspace-settings pattern — only team
    admins/owners see the full email. Members see display_name only.
    A member always sees their own email (self-row).
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(org_id, app_user["id"], minimum="member")
    can_manage = caller_role in ("admin", "owner")

    memberships = await async_directus.get_items(
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
    ) or []
    if not isinstance(memberships, list) or not memberships:
        return []

    user_ids = [m["user_id"] for m in memberships if m.get("user_id")]
    if not user_ids:
        return []

    # Batch-fetch app_user rows + directus_users for avatars.
    app_users = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"id": {"_in": user_ids}},
                "fields": ["id", "directus_user_id", "display_name", "email"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(app_users, list):
        app_users = []
    app_user_map = {u["id"]: u for u in app_users}

    directus_ids = [
        u["directus_user_id"]
        for u in app_users
        if u.get("directus_user_id")
    ]
    avatar_map: dict[str, Optional[str]] = {}
    if directus_ids:
        du_rows = await async_directus.get_users(
            {
                "query": {
                    "filter": {"id": {"_in": directus_ids}},
                    "fields": ["id", "avatar"],
                    "limit": -1,
                }
            }
        ) or []
        if isinstance(du_rows, list):
            avatar_map = {u["id"]: u.get("avatar") for u in du_rows}

    # Count workspaces each user can access. For admins/owners this is every
    # workspace in the team (derived). For members it's only workspaces
    # with inherit_team_members=true plus any direct memberships.
    workspace_counts = await _rollup_workspace_access(org_id, user_ids)

    # Direct workspace roles per team user — keyed {user_id: {workspace_id: role}}.
    # Powers the matrix page so direct-invited members on specific
    # workspaces show correctly (they were hidden before when the
    # matrix relied on derivation alone). Dedup'd by (workspace_id,
    # user_id) with direct-over-inherited priority.
    direct_roles = await _direct_workspace_roles_by_user(org_id, user_ids)

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
                direct_workspace_roles=direct_roles.get(uid, {}),
            )
        )
    return out


async def _direct_workspace_roles_by_user(
    org_id: str, user_ids: list[str]
) -> dict[str, dict[str, str]]:
    """Return {user_id: {workspace_id: role}} for direct memberships this
    team's users hold on any workspace in this team.

    One DB call for the whole team page. Dedup'd (workspace_id, user_id)
    since pre-walkback data can carry inherited+direct rows for the
    same pair (matrix §7 one seat per person per workspace — see
    get_workspace_usage for the same dedup logic).
    """
    if not user_ids:
        return {}

    ws_rows = await async_directus.get_items(
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
    ) or []
    ws_ids = [w["id"] for w in (ws_rows if isinstance(ws_rows, list) else []) if w.get("id")]
    if not ws_ids:
        return {}

    mem_rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_in": ws_ids},
                    "user_id": {"_in": user_ids},
                    "deleted_at": {"_null": True},
                },
                "fields": ["workspace_id", "user_id", "role", "source"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(mem_rows, list):
        return {}

    # Dedup (workspace_id, user_id): direct > inherited.
    by_pair: dict[tuple[str, str], dict] = {}
    for m in mem_rows:
        wid = m.get("workspace_id")
        uid = m.get("user_id")
        if not wid or not uid:
            continue
        key = (wid, uid)
        existing = by_pair.get(key)
        if existing is None or (
            m.get("source") == "direct" and existing.get("source") != "direct"
        ):
            by_pair[key] = m

    out: dict[str, dict[str, str]] = {}
    for (wid, uid), row in by_pair.items():
        out.setdefault(uid, {})[wid] = row.get("role", "member")
    return out


async def _rollup_workspace_access(
    org_id: str, user_ids: list[str]
) -> dict[str, int]:
    """For each user, count how many workspaces in this team they can access.

    Access = direct workspace_membership OR derived via org role + settings.
    Done in Python over the team's workspaces to match the derivation logic
    in dembrane.inheritance exactly.
    """
    from dembrane.inheritance import user_can_access

    workspaces = await async_directus.get_items(
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
    ) or []
    if not isinstance(workspaces, list) or not workspaces:
        return {uid: 0 for uid in user_ids}

    counts = {uid: 0 for uid in user_ids}
    for w in workspaces:
        for uid in user_ids:
            if await user_can_access(w["id"], uid):
                counts[uid] += 1
    # Note: O(users × workspaces) round-trips. Fine at current scale; if a
    # team ever grows past ~50 workspaces × 50 members we should batch-fetch
    # org_memberships + workspace.settings once and derive in-process.
    return counts


class OrgWorkspaceSummary(BaseModel):
    id: str
    name: str
    tier: str
    is_default: bool
    project_count: int = 0
    member_count: int = 0
    is_private: bool = False  # settings.inherit_team_admins == false


@router.get("/{org_id}/workspaces", response_model=list[OrgWorkspaceSummary])
async def list_team_workspaces(
    org_id: str,
    auth: DependencyDirectusSession,
) -> list[OrgWorkspaceSummary]:
    """Every workspace in the team, visible to any team member.

    A team owner's "see all my workspaces" answer — the selector only
    shows workspaces the caller is a member of (direct or derived), but
    team owners may want a roster view including workspaces they haven't
    joined directly. Anyone in the team can read this.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(org_id, app_user["id"], minimum="member")
    caller_is_manager = caller_role in ("admin", "owner")

    # Pull settings.inherit_team_admins explicitly (sub-field projection)
    # so we don't need to send the whole JSON (also avoids accidentally
    # exposing sticky_removed tombstones to the client — the response model
    # drops them, but belt-and-braces). Counts come from separate aggregates
    # because the workspace collection doesn't declare O2M aliases for
    # projects/members.
    workspaces = await async_directus.get_items(
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
                    "is_default",
                    "settings",
                ],
                "sort": ["-is_default", "name"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(workspaces, list) or not workspaces:
        return []

    ws_ids = [w["id"] for w in workspaces if w.get("id")]

    # Batch per-workspace counts with group-by so one call covers the team.
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

    # Hide private workspaces from non-admin team members — the whole
    # point of a private workspace is that team admins can't see it,
    # advertising its name + tier in a team-scoped list contradicts that.
    # Admins/owners still see the full roster (they're the audience).
    out: list[OrgWorkspaceSummary] = []
    for ws in workspaces:
        settings = ws.get("settings") if isinstance(ws.get("settings"), dict) else {}
        is_private = (settings or {}).get("inherit_team_admins") is False
        if is_private and not caller_is_manager:
            continue
        out.append(
            OrgWorkspaceSummary(
                id=ws["id"],
                name=ws.get("name", ""),
                tier=ws.get("tier", "pioneer"),
                is_default=bool(ws.get("is_default", False)),
                project_count=project_counts.get(ws["id"], 0),
                member_count=member_counts.get(ws["id"], 0),
                is_private=is_private,
            )
        )
    return out


@router.patch("/{org_id}/members/{user_id}")
async def change_member_role(
    org_id: str,
    user_id: str,
    body: ChangeMemberRoleRequest,
    auth: DependencyDirectusSession,
) -> dict:
    """Change a team member's role. Admin+owner only. Owners can promote
    another member to owner (ownership transfer is not yet scoped as a
    separate endpoint, but a role=owner PATCH is the mechanism).
    """
    if body.role not in _VALID_ORG_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")

    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(
        org_id, app_user["id"], minimum="admin"
    )

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
    # only remaining person with management rights. Keeps teams from ending
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
                    "Can't demote the last admin. Promote someone else to "
                    "admin or owner first."
                ),
            )

    # Hard rule: a user who is currently external on any of the team's
    # workspaces can never be team admin or owner. External-of-a-team means
    # "they're not really part of this team" — promoting them into the
    # admin chair contradicts that. If they should be admin, un-external
    # them first by removing those workspace rows and re-inviting as
    # team members.
    if body.role in ("admin", "owner"):
        # Look across this team's workspaces for any active direct row
        # marked is_external=True for this user.
        workspaces = await async_directus.get_items(
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
        ) or []
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
                                "is_external": {"_eq": True},
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
                            "This person is an external guest on one of the "
                            "team's workspaces. Clear that first — they can't "
                            "hold team admin/owner while marked as a guest."
                        ),
                    )

    await async_directus.update_item(
        "org_membership", target["id"], {"role": body.role}
    )
    # Note: derived model means no membership fan-out needed — next access
    # check on any workspace re-derives from the new role.

    # Notify the affected user (unless they changed their own role).
    if user_id != app_user["id"]:
        team_row = await async_directus.get_item("org", org_id)
        team_name = (team_row or {}).get("name") or "your team"
        from dembrane.notifications import emit
        await emit(
            audience_user_id=user_id,
            actor_user_id=app_user["id"],
            event_code="TEAM_ROLE_CHANGED",
            title=f"Your role in {team_name} changed",
            message=f"You're now a **{body.role}** in {team_name}.",
            action="NAVIGATE_TEAM_SETTINGS",
            ref_org_id=org_id,
        )

    logger.info(
        f"Team {org_id} role change: user {user_id} "
        f"{target_role} → {body.role} by {app_user['id']}"
    )
    return {"status": "updated", "role": body.role}


@router.delete("/{org_id}/members/{user_id}")
async def remove_team_member(
    org_id: str,
    user_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Soft-delete the team membership. Cascades via inheritance helper:
    user loses all source='direct' rows on workspaces in this team; derived
    access stops automatically because org_membership is gone.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(
        org_id, app_user["id"], minimum="admin"
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
                "fields": ["id", "role"],
                "limit": 1,
            }
        },
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=404, detail="Member not found")
    target = rows[0]

    # Owners can only be removed by owners. Extra guard: don't allow
    # removing the last owner (team would be leaderless).
    if target.get("role") == "owner":
        if caller_role != "owner":
            raise HTTPException(
                status_code=403, detail="Only an owner can remove an owner"
            )
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
            owner_count = int(
                owners[0].get("count", {}).get("id", 0) or 0
            )
        if owner_count <= 1:
            raise HTTPException(
                status_code=409,
                detail="Can't remove the last owner. Transfer ownership first.",
            )

    now_iso = datetime.now(timezone.utc).isoformat()
    await async_directus.update_item(
        "org_membership", target["id"], {"deleted_at": now_iso}
    )

    affected = await on_team_member_removed(org_id, user_id)

    # Notify the removed user — they'll see workspaces drop from their
    # selector; this gives them the honest explanation.
    if user_id != app_user["id"]:
        team_row = await async_directus.get_item("org", org_id)
        team_name = (team_row or {}).get("name") or "the team"
        from dembrane.notifications import emit
        await emit(
            audience_user_id=user_id,
            actor_user_id=app_user["id"],
            event_code="TEAM_REMOVED",
            title=f"You were removed from {team_name}",
            message=(
                "Workspace access that depended on your team role has ended. "
                "Reach out to a team admin if this was unexpected."
            ),
            action="NONE",
            ref_org_id=org_id,
        )

    logger.info(
        f"Removed user {user_id} from team {org_id} by {app_user['id']} — "
        f"soft-deleted direct memberships on {len(affected)} workspace(s)"
    )
    return {
        "status": "removed",
        "workspace_memberships_deleted": len(affected),
    }


# ────────────────────────────────────────────────────────────────────
# Team-level usage rollup (matrix §8 team-scope)
# ────────────────────────────────────────────────────────────────────


class OrgUsageWorkspaceRow(BaseModel):
    id: str
    name: str
    tier: str
    audio_hours: float
    hours_included: Optional[int]      # None = unlimited tier
    hours_pct: Optional[float]         # 0..1 progress; None when unlimited
    at_cap: bool                       # Pilot + at/over cap
    approaching_cap: bool              # >=80% on capped tiers
    # Admin / billing only:
    overage_forecast_eur: Optional[float] = None


class OrgUsageResponse(BaseModel):
    cycle_start: str
    cycle_end_exclusive: str
    workspace_count: int
    total_audio_hours: float
    total_seat_count: int
    total_guest_count: int
    total_project_count: int
    workspaces_at_cap: int            # Pilot + over cap (hard block active)
    workspaces_approaching_cap: int   # tier with cap, usage >= 80%
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
    """Team-wide usage rollup across all active workspaces in the org.

    `month_offset` (0 = current, 1 = last month, capped at 12) lets admins
    audit prior cycles. Forecast is null for historical months.

    Cached 30 min, keyed by (org_id, month_offset). Pass `?refresh=true`
    to bypass.

    Access:
      - Any team member can read raw numbers.
      - Admin / billing (org:view_invoices) additionally receive
        total_overage_forecast_eur.
    """
    from datetime import datetime, timezone

    from dembrane.cache_utils import (
        USAGE_TTL_SECONDS,
        cache_get_json,
        cache_set_json,
    )
    from dembrane.tier_capacity import (
        compute_hour_overage_eur,
        get_capacity,
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

    # All active workspaces in this org.
    workspaces = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "name", "tier"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(workspaces, list):
        workspaces = []

    ws_ids = [w["id"] for w in workspaces if w.get("id")]

    # Projects + conversations (this cycle) across all workspaces — batch.
    project_count = 0
    per_ws_hours: dict[str, float] = {w["id"]: 0.0 for w in workspaces if w.get("id")}
    if ws_ids:
        projects = await async_directus.get_items(
            "project",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_in": ws_ids},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id", "workspace_id"],
                    "limit": -1,
                }
            },
        ) or []
        if isinstance(projects, list):
            project_count = len(projects)
            ws_by_project = {
                p["id"]: p["workspace_id"]
                for p in projects
                if p.get("id") and p.get("workspace_id")
            }
            pids = list(ws_by_project.keys())
            if pids:
                conversations = await async_directus.get_items(
                    "conversation",
                    {
                        "query": {
                            "filter": {
                                "project_id": {"_in": pids},
                                "deleted_at": {"_null": True},
                                "created_at": {
                                    "_gte": cycle_start,
                                    "_lt": cycle_end_exclusive,
                                },
                            },
                            "fields": ["project_id", "duration"],
                            "limit": -1,
                        }
                    },
                ) or []
                if isinstance(conversations, list):
                    for c in conversations:
                        pid = c.get("project_id")
                        ws_id = ws_by_project.get(pid) if pid else None
                        if not ws_id:
                            continue
                        per_ws_hours[ws_id] = (
                            per_ws_hours.get(ws_id, 0.0)
                            + (int(c.get("duration") or 0) / 3600.0)
                        )

    # Memberships — dedupe by (workspace_id, user_id). Pre-walkback data
    # can carry both a direct and an inherited row for the same pair
    # (matrix §7: "one seat per person per workspace"). Row-count alone
    # would double-bill the same human.
    total_seat_count = 0
    total_guest_count = 0
    if ws_ids:
        memberships = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_in": ws_ids},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["workspace_id", "user_id", "role", "source", "is_external"],
                    "limit": -1,
                }
            },
        ) or []
        if isinstance(memberships, list):
            # Dedupe: prefer direct over inherited, then seat-worthy over not.
            by_pair: dict[tuple[str, str], dict] = {}
            seat_roles = {"owner", "admin", "member", "billing"}
            for m in memberships:
                wid = m.get("workspace_id")
                uid = m.get("user_id")
                if not wid or not uid:
                    continue
                key = (wid, uid)
                existing = by_pair.get(key)
                if existing is None:
                    by_pair[key] = m
                    continue
                existing_direct = existing.get("source") == "direct"
                this_direct = m.get("source") == "direct"
                if this_direct and not existing_direct:
                    by_pair[key] = m
                elif this_direct == existing_direct:
                    if (
                        m.get("role") in seat_roles
                        and existing.get("role") not in seat_roles
                    ):
                        by_pair[key] = m
            for m in by_pair.values():
                if m.get("is_external"):
                    total_guest_count += 1
                elif m.get("role") in seat_roles:
                    total_seat_count += 1

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
        hours = per_ws_hours.get(wid, 0.0) if wid else 0.0
        total_hours += hours

        cap = get_capacity(tier)
        hours_included: Optional[int] = cap.included_hours if cap else None
        hours_pct: Optional[float] = None
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
            ws_forecast_eur = (
                compute_hour_overage_eur(tier, hours) if is_current_month else 0.0
            )
            forecast += ws_forecast_eur

        ws_rows.append({
            "id": wid,
            "name": name,
            "tier": tier,
            "audio_hours": round(hours, 2),
            "hours_included": hours_included,
            "hours_pct": hours_pct,
            "at_cap": ws_at_cap,
            "approaching_cap": ws_approaching,
            "overage_forecast_eur": (
                round(ws_forecast_eur, 2) if is_current_month else None
            ),
        })

    # Sort: at-cap first, then approaching, then by hours desc — Team admins
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
        "total_guest_count": total_guest_count,
        "total_project_count": project_count,
        "workspaces_at_cap": at_cap,
        "workspaces_approaching_cap": approaching,
        "workspaces": ws_rows,
        "total_overage_forecast_eur": (
            round(forecast, 2) if is_current_month else None
        ),
    }

    await cache_set_json(cache_key, payload, USAGE_TTL_SECONDS)

    if not sees_financials:
        # Strip both the aggregate and each per-workspace € figure for
        # plain members — matrix §8 says members see raw hours only.
        stripped_rows = [
            {**r, "overage_forecast_eur": None} for r in ws_rows
        ]
        payload = {
            **payload,
            "total_overage_forecast_eur": None,
            "workspaces": stripped_rows,
        }

    return OrgUsageResponse(**payload)


# ────────────────────────────────────────────────────────────────────
# Team-wide projects listing (for the team admin projects view)
# ────────────────────────────────────────────────────────────────────


class OrgProjectRow(BaseModel):
    id: str
    name: str
    workspace_id: str
    workspace_name: str
    visibility: str
    conversation_count: int = 0
    created_at: Optional[str] = None


@router.get("/{org_id}/projects", response_model=list[OrgProjectRow])
async def list_team_projects(
    org_id: str,
    auth: DependencyDirectusSession,
) -> list[OrgProjectRow]:
    """Every project across every workspace in the team.

    Matrix §4: delete-workspace requires empty. Without a cross-team
    projects view, team admins have to walk into each workspace to clear
    it before winding down. This endpoint powers the "Projects" view on
    the team page where admins can scan + soft-delete at scale.

    Team admin/owner only — members have no cross-workspace project
    reach per matrix §5.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    await _require_org_role(org_id, app_user["id"], minimum="admin")

    # Workspaces in the team.
    workspaces = await async_directus.get_items(
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
    ) or []
    if not isinstance(workspaces, list) or not workspaces:
        return []

    ws_by_id: dict[str, str] = {
        w["id"]: w.get("name") or "" for w in workspaces if w.get("id")
    }
    ws_ids = list(ws_by_id.keys())

    projects = await async_directus.get_items(
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
    ) or []
    if not isinstance(projects, list):
        return []

    # Batch conversation-count per project via group-by aggregate.
    pid_list = [p["id"] for p in projects if p.get("id")]
    conv_counts: dict[str, int] = {}
    if pid_list:
        agg = await async_directus.get_items(
            "conversation",
            {
                "query": {
                    "aggregate": {"count": "id"},
                    "groupBy": ["project_id"],
                    "filter": {
                        "project_id": {"_in": pid_list},
                        "deleted_at": {"_null": True},
                    },
                }
            },
        ) or []
        if isinstance(agg, list):
            for row in agg:
                pid = row.get("project_id")
                cnt = int((row.get("count") or {}).get("id", 0) or 0)
                if pid:
                    conv_counts[pid] = cnt

    out: list[OrgProjectRow] = []
    for p in projects:
        wid = p.get("workspace_id")
        if not wid or wid not in ws_by_id:
            continue
        out.append(
            OrgProjectRow(
                id=p["id"],
                name=p.get("name") or "",
                workspace_id=wid,
                workspace_name=ws_by_id[wid],
                visibility=p.get("visibility") or "workspace",
                conversation_count=conv_counts.get(p["id"], 0),
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
    """Matrix §10: a partner team reads its own referral ledger here to
    see which workspaces they earn a kickback on + terms.

    Staff edit the ledger elsewhere (post-release staff console). This
    endpoint is read-only and returns entries where partner_team_id
    equals the requested org. Team admin/owner/billing only — regular
    members don't see financial terms per matrix §7.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    caller_role = await _require_org_role(org_id, app_user["id"], minimum="member")
    if caller_role not in ("admin", "owner", "billing"):
        raise HTTPException(
            status_code=403, detail="Team admin or billing role only"
        )

    rows = await async_directus.get_items(
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
    ) or []
    if not isinstance(rows, list) or not rows:
        return []

    # Join workspace names — batched.
    ws_ids = sorted({r["workspace_id"] for r in rows if r.get("workspace_id")})
    ws_name_map: dict[str, str] = {}
    if ws_ids:
        ws_rows = await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {"id": {"_in": ws_ids}},
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        ) or []
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
