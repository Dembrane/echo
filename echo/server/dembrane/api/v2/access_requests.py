"""Slack-style discovery endpoints (matrix v1.1 §6).

Two paths into a workspace the user doesn't currently belong to:

  1. Team admin → "Join" → immediate `source='direct', role='admin'` row.
     No approval. Workspace visibility (open or private) doesn't matter;
     team admins can join either.

  2. Team member → "Request access" → pending access_request row →
     workspace admin OR team admin approves → `source='direct',
     role='member'` row. Rejection is silent (matrix §6 — no notification
     to the requester).

Both endpoints are workspace-scoped at the URL but use a thinner guard
than the normal WorkspaceContext: the caller does NOT have workspace
access yet. We authenticate their org membership instead.
"""

from __future__ import annotations

from datetime import datetime, timezone
from logging import getLogger
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from dembrane.app_user import get_app_user_or_raise
from dembrane.directus_async import async_directus
from dembrane.api.rate_limit import create_user_rate_limiter
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.utils import generate_uuid

router = APIRouter()
logger = getLogger("api.v2.access_requests")

# Modest rate limit on both join + request-access. Prevents a team admin
# bot from flooding workspace_membership; prevents a curious team member
# from spamming requests across every workspace in a large team.
_join_rate_limiter = create_user_rate_limiter(
    name="workspace_join", capacity=30, window_seconds=3600
)
_request_access_rate_limiter = create_user_rate_limiter(
    name="workspace_request_access", capacity=30, window_seconds=3600
)


# ── Helpers ────────────────────────────────────────────────────────────


async def _org_role(org_id: str, user_id: str) -> Optional[str]:
    rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "org_id": {"_eq": org_id},
                    "user_id": {"_eq": user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["role"],
                "limit": 1,
            }
        },
    )
    if isinstance(rows, list) and rows:
        return rows[0].get("role")
    return None


async def _has_direct_row(workspace_id: str, user_id: str) -> bool:
    rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    return isinstance(rows, list) and bool(rows)


async def _pending_request(
    workspace_id: str, user_id: str
) -> Optional[dict]:
    rows = await async_directus.get_items(
        "access_request",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": user_id},
                    "status": {"_eq": "pending"},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id"],
                "limit": 1,
            }
        },
    )
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


async def _load_workspace_or_404(workspace_id: str) -> dict:
    ws = await async_directus.get_item("workspace", workspace_id)
    if not ws or ws.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


async def _require_can_action_requests(
    workspace: dict, app_user_id: str
) -> None:
    """Guard for approve/reject endpoints.

    Matrix v1.1 §6: either a workspace admin OR a team admin/owner can
    action a pending request. We accept either — otherwise, post-walkback,
    a team admin receiving MEMBERSHIP_REQUESTED would click Approve and
    hit 403 because they don't have a direct workspace row yet.

    Checks (short-circuit on first pass):
      1. Direct workspace_membership with role in (admin, owner) or any
         role whose preset grants `member:manage`.
      2. Team admin/owner on the workspace's org.

    Raises 403 otherwise.
    """
    from dembrane.policies import has_policy

    workspace_id = workspace["id"]
    org_id = workspace.get("org_id")

    # Pass 1: direct workspace membership with member:manage.
    direct_rows = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                },
                "fields": ["role", "custom_policies"],
                "limit": 1,
            }
        },
    )
    if isinstance(direct_rows, list) and direct_rows:
        row = direct_rows[0]
        if has_policy(
            row.get("role") or "",
            row.get("custom_policies") or [],
            "member:manage",
            workspace_tier=workspace.get("tier"),
        ):
            return

    # Pass 2: team admin or owner in the workspace's org.
    if org_id:
        team_rows = await async_directus.get_items(
            "org_membership",
            {
                "query": {
                    "filter": {
                        "org_id": {"_eq": org_id},
                        "user_id": {"_eq": app_user_id},
                        "role": {"_in": ["admin", "owner"]},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["role"],
                    "limit": 1,
                }
            },
        )
        if isinstance(team_rows, list) and team_rows:
            return

    raise HTTPException(status_code=403, detail="Access denied")


# ── Join (team admin, immediate) ───────────────────────────────────────


class JoinResponse(BaseModel):
    status: Literal["joined", "already_member"]
    workspace_id: str
    role: str


@router.post("/{workspace_id}/join", response_model=JoinResponse)
async def join_workspace(
    workspace_id: str,
    auth: DependencyDirectusSession,
) -> JoinResponse:
    """Team admin (or owner) self-joins a workspace in their team.

    Matrix v1.1 §6: team admins can discover and join any workspace in
    the team, open or private. The action is explicit and reversible.
    Writes a direct Admin row.

    403 if the caller is not a team admin/owner on the workspace's org.
    404 if the workspace doesn't exist or is soft-deleted.
    200 + status='already_member' if a direct row already exists —
        idempotent, not an error.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    await _join_rate_limiter.check(app_user_id)

    workspace = await _load_workspace_or_404(workspace_id)
    org_id = workspace.get("org_id")
    if not org_id:
        raise HTTPException(status_code=500, detail="Workspace has no org")

    role = await _org_role(org_id, app_user_id)
    if role not in ("admin", "owner"):
        raise HTTPException(status_code=403, detail="Team admins only")

    # Check existing direct row separately from the insert so the "already
    # joined" response is precise rather than a unique-constraint 500.
    if await _has_direct_row(workspace_id, app_user_id):
        return JoinResponse(
            status="already_member",
            workspace_id=workspace_id,
            role="admin",
        )

    await async_directus.create_item(
        "workspace_membership",
        {
            "id": generate_uuid(),
            "workspace_id": workspace_id,
            "user_id": app_user_id,
            "role": "admin",
            "source": "direct",
            "is_external": False,
        },
    )

    logger.info(
        "workspace_join workspace=%s user=%s (team role=%s)",
        workspace_id, app_user_id, role,
    )

    # Quiet self-notification — "You joined {ws}" — for the activity feed.
    # No broadcast to co-admins: team admin joining their own team's
    # workspace isn't news (matrix §6 treats it as a mundane action).
    from dembrane.notifications import emit
    await emit(
        audience_user_id=app_user_id,
        actor_user_id=app_user_id,
        event_code="WORKSPACE_JOINED",
        title=f"You joined {workspace.get('name') or 'a workspace'}",
        message="You're in as an admin.",
        action="NAVIGATE_WS",
        ref_workspace_id=workspace_id,
        ref_org_id=org_id,
    )

    return JoinResponse(
        status="joined",
        workspace_id=workspace_id,
        role="admin",
    )


# ── Request access (team member, goes pending) ─────────────────────────


class RequestAccessResponse(BaseModel):
    status: Literal["submitted", "already_pending", "already_member"]
    request_id: Optional[str] = None


@router.post(
    "/{workspace_id}/access-requests",
    response_model=RequestAccessResponse,
)
async def request_workspace_access(
    workspace_id: str,
    auth: DependencyDirectusSession,
) -> RequestAccessResponse:
    """Team member requests to join an open-to-team workspace.

    Matrix v1.1 §6:
      - Allowed only when workspace.visibility = 'open_to_team'.
      - Allowed only for team members (org role 'member'). Admins/owners
        use /join directly (they don't need approval).
      - If the caller is already a direct member → 200 already_member.
      - If a pending request already exists → 200 already_pending.
      - Notifies workspace admins + team admins (audience_action_required).
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    await _request_access_rate_limiter.check(app_user_id)

    workspace = await _load_workspace_or_404(workspace_id)
    org_id = workspace.get("org_id")
    if not org_id:
        raise HTTPException(status_code=500, detail="Workspace has no org")

    # Visibility gate. Private workspaces are invisible to team members in
    # discovery; no request path exists for them.
    if workspace.get("visibility") == "private":
        raise HTTPException(
            status_code=404,
            detail="Workspace not found",  # intentional — don't confirm existence
        )

    org_role = await _org_role(org_id, app_user_id)
    if org_role is None:
        raise HTTPException(
            status_code=403, detail="Not a member of this team"
        )
    if org_role in ("admin", "owner"):
        raise HTTPException(
            status_code=400,
            detail="Team admins can join directly — no approval needed",
        )

    if await _has_direct_row(workspace_id, app_user_id):
        return RequestAccessResponse(status="already_member")

    existing = await _pending_request(workspace_id, app_user_id)
    if existing:
        return RequestAccessResponse(
            status="already_pending", request_id=existing["id"]
        )

    req_id = generate_uuid()
    await async_directus.create_item(
        "access_request",
        {
            "id": req_id,
            "workspace_id": workspace_id,
            "user_id": app_user_id,
            "status": "pending",
        },
    )

    # Audience: workspace admins + team admins. Either can approve.
    from dembrane.notifications import (
        emit_to_audience,
        audience_workspace_admins,
        audience_team_admins,
    )
    ws_admins = await audience_workspace_admins(workspace_id)
    team_admins = await audience_team_admins(org_id)
    audience = sorted(set(ws_admins) | set(team_admins))
    requester_name = (
        app_user.get("display_name") or app_user.get("email") or "Someone"
    )
    ws_name = workspace.get("name") or "a workspace"
    await emit_to_audience(
        audience,
        actor_user_id=app_user_id,
        event_code="MEMBERSHIP_REQUESTED",
        title=f"{requester_name} wants to join {ws_name}",
        message=(
            f"{requester_name} requested access. Approve from the "
            f"workspace members tab."
        ),
        action="NAVIGATE_WORKSPACE_SETTINGS",
        ref_workspace_id=workspace_id,
        ref_org_id=org_id,
    )

    logger.info(
        "access_request_submitted workspace=%s user=%s id=%s",
        workspace_id, app_user_id, req_id,
    )

    return RequestAccessResponse(status="submitted", request_id=req_id)


# ── Admin: list + approve + reject ─────────────────────────────────────


class AccessRequestRow(BaseModel):
    id: str
    workspace_id: str
    user_id: str
    user_display_name: Optional[str] = None
    user_email: Optional[str] = None
    status: str
    requested_at: str


class ListAccessRequestsResponse(BaseModel):
    requests: list[AccessRequestRow]


@router.get(
    "/{workspace_id}/access-requests",
    response_model=ListAccessRequestsResponse,
)
async def list_access_requests(
    workspace_id: str,
    auth: DependencyDirectusSession,
) -> ListAccessRequestsResponse:
    """Pending access requests on this workspace.

    Guard: workspace admin (via direct membership's `member:manage`) OR
    team admin/owner on the workspace's org. The latter is what makes
    the UX work post-walkback — team admins can approve without first
    having to /join the workspace.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    workspace = await _load_workspace_or_404(workspace_id)
    await _require_can_action_requests(workspace, app_user["id"])

    rows = await async_directus.get_items(
        "access_request",
        {
            "query": {
                "filter": {
                    "workspace_id": {"_eq": workspace_id},
                    "status": {"_eq": "pending"},
                    "deleted_at": {"_null": True},
                },
                "fields": ["id", "workspace_id", "user_id", "status", "requested_at"],
                "sort": ["-requested_at"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        rows = []

    # Resolve user display info for the list view.
    uids = sorted({r["user_id"] for r in rows if r.get("user_id")})
    users: dict[str, dict] = {}
    if uids:
        urows = await async_directus.get_items(
            "app_user",
            {
                "query": {
                    "filter": {"id": {"_in": uids}},
                    "fields": ["id", "display_name", "email"],
                    "limit": -1,
                }
            },
        )
        if isinstance(urows, list):
            users = {u["id"]: u for u in urows}

    out: list[AccessRequestRow] = []
    for r in rows:
        u = users.get(r.get("user_id") or "", {})
        out.append(
            AccessRequestRow(
                id=r["id"],
                workspace_id=r["workspace_id"],
                user_id=r["user_id"],
                user_display_name=u.get("display_name"),
                user_email=u.get("email"),
                status=r.get("status", "pending"),
                requested_at=r.get("requested_at") or "",
            )
        )
    return ListAccessRequestsResponse(requests=out)


class ActionRequestResponse(BaseModel):
    status: Literal["approved", "rejected"]


async def _load_pending_or_404(workspace_id: str, req_id: str) -> dict:
    req = await async_directus.get_item("access_request", req_id)
    if not req or req.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Request not found")
    if req.get("workspace_id") != workspace_id:
        # URL says one workspace, record says another — treat as 404 so
        # we don't confirm existence of cross-workspace requests.
        raise HTTPException(status_code=404, detail="Request not found")
    if req.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Request already actioned")
    return req


@router.post(
    "/{workspace_id}/access-requests/{req_id}/approve",
    response_model=ActionRequestResponse,
)
async def approve_access_request(
    workspace_id: str,
    req_id: str,
    auth: DependencyDirectusSession,
) -> ActionRequestResponse:
    """Approve: write a direct Member row + mark request approved + notify
    the requester.

    Guard: workspace admin OR team admin/owner (see
    `_require_can_action_requests`).
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    actor_id = app_user["id"]
    workspace = await _load_workspace_or_404(workspace_id)
    await _require_can_action_requests(workspace, actor_id)

    req = await _load_pending_or_404(workspace_id, req_id)
    requester_id = req["user_id"]

    # If a direct row has appeared since the request was filed (e.g. admin
    # manually invited them), just close the request approved without
    # duplicating the membership.
    if not await _has_direct_row(workspace_id, requester_id):
        await async_directus.create_item(
            "workspace_membership",
            {
                "id": generate_uuid(),
                "workspace_id": workspace_id,
                "user_id": requester_id,
                "role": "member",
                "source": "direct",
                "is_external": False,
            },
        )

    await async_directus.update_item(
        "access_request",
        req_id,
        {
            "status": "approved",
            "actioned_at": datetime.now(timezone.utc).isoformat(),
            "actioned_by": actor_id,
        },
    )

    from dembrane.notifications import emit
    ws_name = workspace.get("name") or "a workspace"
    await emit(
        audience_user_id=requester_id,
        actor_user_id=actor_id,
        event_code="MEMBERSHIP_REQUEST_APPROVED",
        title=f"You're in {ws_name}",
        message=f"Your request to join {ws_name} was approved.",
        action="NAVIGATE_WS",
        ref_workspace_id=workspace_id,
        ref_org_id=workspace.get("org_id"),
    )

    logger.info(
        "access_request_approved workspace=%s req=%s requester=%s by=%s",
        workspace_id, req_id, requester_id, actor_id,
    )
    return ActionRequestResponse(status="approved")


@router.post(
    "/{workspace_id}/access-requests/{req_id}/reject",
    response_model=ActionRequestResponse,
)
async def reject_access_request(
    workspace_id: str,
    req_id: str,
    auth: DependencyDirectusSession,
) -> ActionRequestResponse:
    """Reject a pending request. **Silent per matrix §6** — the requester
    receives no notification. They learn of it only by noticing nothing
    happened.

    Guard: workspace admin OR team admin/owner.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    actor_id = app_user["id"]
    workspace = await _load_workspace_or_404(workspace_id)
    await _require_can_action_requests(workspace, actor_id)

    req = await _load_pending_or_404(workspace_id, req_id)

    await async_directus.update_item(
        "access_request",
        req_id,
        {
            "status": "rejected",
            "actioned_at": datetime.now(timezone.utc).isoformat(),
            "actioned_by": actor_id,
        },
    )

    logger.info(
        "access_request_rejected workspace=%s req=%s by=%s",
        workspace_id, req_id, actor_id,
    )
    return ActionRequestResponse(status="rejected")


# ── Discovery (team member sees open workspaces; admin sees all) ───────


class DiscoverableWorkspace(BaseModel):
    id: str
    name: str
    visibility: str
    action: Literal["join", "request-access", "pending", "member"]
    pending_request_id: Optional[str] = None


class DiscoverResponse(BaseModel):
    workspaces: list[DiscoverableWorkspace]


discover_router = APIRouter()


@discover_router.get(
    "/{org_id}/discoverable-workspaces",
    response_model=DiscoverResponse,
)
async def list_discoverable_workspaces(
    org_id: str,
    auth: DependencyDirectusSession,
) -> DiscoverResponse:
    """Workspaces in this team that the caller could join or request.

    - Team admin / owner: sees every workspace (open + private). Action
      is 'join' (unless already a direct member).
    - Team member: sees only open_to_team workspaces. Action is
      'request-access' (unless already a member, or a pending request
      exists).
    - Not a team member: 403.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    org_role = await _org_role(org_id, app_user_id)
    if org_role is None:
        raise HTTPException(status_code=403, detail="Not a member of this team")

    can_see_private = org_role in ("admin", "owner")

    filters: dict = {
        "org_id": {"_eq": org_id},
        "deleted_at": {"_null": True},
    }
    if not can_see_private:
        filters["visibility"] = {"_eq": "open_to_team"}

    workspaces = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": filters,
                "fields": ["id", "name", "visibility"],
                "sort": ["name"],
                "limit": -1,
            }
        },
    )
    if not isinstance(workspaces, list):
        workspaces = []

    # Caller's existing direct rows in this org's workspaces.
    ws_ids = [w["id"] for w in workspaces if w.get("id")]
    existing_direct: set[str] = set()
    if ws_ids:
        mems = await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_in": ws_ids},
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["workspace_id"],
                    "limit": -1,
                }
            },
        )
        if isinstance(mems, list):
            existing_direct = {m["workspace_id"] for m in mems}

    # Caller's pending access requests (relevant for members).
    pending_map: dict[str, str] = {}
    if not can_see_private and ws_ids:
        reqs = await async_directus.get_items(
            "access_request",
            {
                "query": {
                    "filter": {
                        "workspace_id": {"_in": ws_ids},
                        "user_id": {"_eq": app_user_id},
                        "status": {"_eq": "pending"},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["id", "workspace_id"],
                    "limit": -1,
                }
            },
        )
        if isinstance(reqs, list):
            pending_map = {r["workspace_id"]: r["id"] for r in reqs}

    out: list[DiscoverableWorkspace] = []
    for w in workspaces:
        wid = w["id"]
        visibility = w.get("visibility") or "open_to_team"
        if wid in existing_direct:
            action: Literal["join", "request-access", "pending", "member"] = "member"
            pending_id = None
        elif can_see_private:
            action = "join"
            pending_id = None
        elif wid in pending_map:
            action = "pending"
            pending_id = pending_map[wid]
        else:
            action = "request-access"
            pending_id = None
        out.append(
            DiscoverableWorkspace(
                id=wid,
                name=w.get("name") or "",
                visibility=visibility,
                action=action,
                pending_request_id=pending_id,
            )
        )

    return DiscoverResponse(workspaces=out)
