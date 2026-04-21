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

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr, Field

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
            )
        )
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
