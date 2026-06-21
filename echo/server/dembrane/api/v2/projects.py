"""V2 project endpoints — non-workspace-scoped operations."""

from typing import Literal, Optional
from logging import getLogger

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.app_user import get_app_user_or_raise
from dembrane.policies import has_policy
from dembrane.inheritance import user_can_access, get_user_project_access
from dembrane.api.v2.schemas import MoveProjectRequest, MoveProjectResponse
from dembrane.directus_async import async_directus
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.projects")


class V2ProjectDetail(BaseModel):
    id: str
    name: Optional[str] = None
    workspace_id: Optional[str] = None
    visibility: str = "workspace"
    role: str  # caller's effective role on this project
    source: str  # direct | inherited | workspace | project_share | legacy
    language: Optional[str] = None
    updated_at: Optional[str] = None


@router.get("/{project_id}", response_model=V2ProjectDetail)
async def get_project_detail(
    project_id: str,
    auth: DependencyDirectusSession,
) -> V2ProjectDetail:
    """Fetch a project's public-ish detail with read-time access enforced.

    Returns 404 (not 403) when the caller can't access — matches the
    design-subagent recommendation: don't confirm existence of private
    projects to people outside the share list.

    Use this instead of reading `project` via the Directus SDK from the
    frontend — the SDK doesn't know about visibility gating.
    """
    app_user = await get_app_user_or_raise(auth.user_id)

    access = await get_user_project_access(
        project_id=project_id,
        user_id=app_user["id"],
        directus_user_id=auth.user_id,
    )
    if access is None:
        # Intentional 404 — don't tell them whether the project exists.
        raise HTTPException(status_code=404, detail="Project not found")

    role, source = access

    project = await async_directus.get_item("project", project_id)
    if not project or project.get("deleted_at"):
        # Guard — get_user_project_access already checked, but race-safe.
        raise HTTPException(status_code=404, detail="Project not found")

    return V2ProjectDetail(
        id=project["id"],
        name=project.get("name"),
        workspace_id=project.get("workspace_id"),
        visibility=project.get("visibility") or "workspace",
        role=role,
        source=source,
        language=project.get("language"),
        updated_at=project.get("updated_at"),
    )


@router.get("/{project_id}/bff")
async def get_project_bff(
    project_id: str,
    auth: DependencyDirectusSession,
    include_tags: bool = True,
    fields: Optional[str] = None,
) -> dict:
    """BFF project fetch — project row for the frontend detail page.

    Access is resolved via get_user_project_access so the v2
    inheritance + sharing + tier model decides (the Directus row ACL
    is now admin-only and doesn't know about those rules).

    `fields` accepts a comma-separated allowlist — the response carries
    only those keys plus `_role` and `_source`. Defaults to the whole
    row so callers that want everything don't have to enumerate.
    Per-field trimming matters for the summary-card callers that only
    need one boolean.
    """
    app_user = await get_app_user_or_raise(auth.user_id)

    # Single project fetch, passed into the access resolver so we don't
    # round-trip the same row twice.
    project = await async_directus.get_item("project", project_id)
    if not project or project.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Project not found")

    access = await get_user_project_access(
        project_id=project_id,
        user_id=app_user["id"],
        directus_user_id=auth.user_id,
        project=project,
    )
    if access is None:
        raise HTTPException(status_code=404, detail="Project not found")

    role, source = access

    # Apply the fields allowlist before enriching so `_role`/`_source`
    # can't be filtered out — they're cheap metadata the UI uses.
    if fields:
        requested = {f.strip() for f in fields.split(",") if f.strip()}
        # Always return `id` so response is identifiable; other fields
        # come from the allowlist only.
        requested.add("id")
        project = {k: v for k, v in project.items() if k in requested}

    project["_role"] = role
    project["_source"] = source

    if include_tags:
        tags = (
            await async_directus.get_items(
                "project_tag",
                {
                    "query": {
                        "filter": {"project_id": {"_eq": project_id}},
                        "fields": ["id", "created_at", "text", "sort"],
                        "sort": ["sort"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        project["tags"] = tags if isinstance(tags, list) else []

    return project


@router.post("/{project_id}/move", response_model=MoveProjectResponse)
async def move_project(
    project_id: str,
    body: MoveProjectRequest,
    auth: DependencyDirectusSession,
) -> MoveProjectResponse:
    """Move a project to a different workspace.

    Requires admin/owner on BOTH source and target workspace.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]
    target_workspace_id = body.target_workspace_id

    project = await async_directus.get_item("project", project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Project not found")

    source_workspace_id = project.get("workspace_id")

    # Orphaned projects: verify ownership via directus_user_id
    if not source_workspace_id:
        if project.get("directus_user_id") != auth.user_id:
            raise HTTPException(status_code=403, detail="Not the owner of this project")

    # Source + target access must both resolve as admin/owner. Using
    # user_can_access honors derived inheritance — a organisation owner who has
    # no direct workspace row still legitimately administers the
    # workspace. The previous raw workspace_membership lookup 403'd them
    # incorrectly. (Audit round 2026-04-21, HIGH.)
    if source_workspace_id:
        src = await user_can_access(source_workspace_id, app_user_id)
        if src is None:
            raise HTTPException(status_code=403, detail="No access to source workspace")
        if src[0] not in ("admin", "owner"):
            raise HTTPException(
                status_code=403,
                detail="Must be admin or owner of source workspace",
            )

    tgt = await user_can_access(target_workspace_id, app_user_id)
    if tgt is None:
        raise HTTPException(status_code=403, detail="No access to target workspace")
    if tgt[0] not in ("admin", "owner"):
        raise HTTPException(status_code=403, detail="Must be admin or owner of target workspace")

    target_workspace = await async_directus.get_item("workspace", target_workspace_id)
    if not target_workspace or target_workspace.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Target workspace not found")

    # Projects move only within one billing / data-ownership context (ISSUE-033):
    # internal workspaces of the same org share the org context and move freely;
    # an external (workspace-scoped) workspace is its own isolated context. A
    # project can't move OUT of an external workspace, nor INTO one from a
    # different context — including an orphaned project (no source workspace),
    # which must never be dropped into a client's isolated compliance context.
    from dembrane.billing_service import same_billing_context
    from dembrane.billing_account import workspace_is_external_client

    cross_context = (
        not await same_billing_context(source_workspace_id, target_workspace_id)
        if source_workspace_id
        # Orphan: only blocked from entering an external-client workspace.
        else workspace_is_external_client(target_workspace)
    )
    if cross_context:
        raise HTTPException(
            status_code=403,
            detail=(
                "Projects can only move between workspaces in the same billing "
                "and data-ownership context. External-client workspaces keep "
                "their projects within their own context."
            ),
        )

    await async_directus.update_item(
        "project",
        project_id,
        {
            "workspace_id": target_workspace_id,
        },
    )

    logger.info(
        f"Moved project {project_id} from workspace {source_workspace_id} "
        f"to {target_workspace_id} by user {app_user_id}"
    )

    return MoveProjectResponse(
        project_id=project_id,
        workspace_id=target_workspace_id,
    )


# ── Visibility toggle (workspace ↔ private) ─────────────────────────────


class SetVisibilityRequest(BaseModel):
    visibility: Literal["workspace", "private"]


@router.patch("/{project_id}/visibility")
async def set_project_visibility(
    project_id: str,
    body: SetVisibilityRequest,
    auth: DependencyDirectusSession,
) -> dict:
    """Flip a project between 'workspace' (visible to all workspace members)
    and 'private' (creator + workspace admins + explicit project_membership
    shares only — enforced by inheritance.get_user_project_access on reads).

    Authorization (round-2 audit, R2-H2 follow-up — now uses the
    middleware pattern for consistency):
      - Caller must have workspace access via user_can_access.
      - Caller role must be admin or owner (externals are below this).
      - Going private additionally requires project:set_private which
        auto-enforces innovator+ via has_policy's tier wiring.

    Existing project_membership rows are preserved across a flip — admin
    curates via the share modal afterwards.
    """
    app_user = await get_app_user_or_raise(auth.user_id)

    project = await async_directus.get_item("project", project_id)
    if not project or project.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Project not found")

    workspace_id = project.get("workspace_id")
    if not workspace_id:
        raise HTTPException(
            status_code=400,
            detail="Project is not attached to a workspace",
        )

    # Resolve workspace context manually (can't use the Depends form
    # because the path doesn't include workspace_id). Mirrors what
    # get_workspace_context does.
    resolved = await user_can_access(workspace_id, app_user["id"])
    if resolved is None:
        raise HTTPException(status_code=403, detail="No access to this project")
    role, source = resolved

    workspace = await async_directus.get_item("workspace", workspace_id)
    if not workspace or workspace.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Workspace not found")

    # Externals are excluded by the admin/owner role check below. No
    # separate is_external lookup needed (ADR-0003: role is the single
    # source of truth).
    if role not in ("admin", "owner"):
        raise HTTPException(
            status_code=403,
            detail="Only workspace admins can change project visibility",
        )

    from dembrane.billing_account import resolve_workspace_tier

    tier = (await resolve_workspace_tier(workspace["id"])) or "pioneer"

    current = project.get("visibility") or "workspace"
    if current == body.visibility:
        return {"status": "unchanged", "visibility": current}

    # Going private is tier-gated. Going public is free (you're
    # downgrading your own privacy, not unlocking a paid feature).
    if body.visibility == "private":
        if not has_policy(role, [], "project:set_private", workspace_tier=tier):
            raise HTTPException(
                status_code=403,
                detail="Private projects require innovator tier or above.",
            )

    await async_directus.update_item("project", project_id, {"visibility": body.visibility})
    logger.info(
        f"Project {project_id} visibility: {current} → {body.visibility} by {app_user['id']}"
    )

    # Notify workspace members so they understand why a project they
    # could see yesterday is suddenly gone (or why a new one appeared).
    # Skip the actor so they don't see "you changed the visibility".
    from dembrane.notifications import emit_to_audience, audience_workspace_members

    project_name = project.get("name") or "A project"
    audience = await audience_workspace_members(workspace_id)
    if body.visibility == "private":
        await emit_to_audience(
            audience,
            actor_user_id=app_user["id"],
            event_code="PROJECT_NOW_PRIVATE",
            title=f"{project_name} is now private",
            message=(
                "It's no longer visible to the whole workspace. "
                "Only the people explicitly shared can see it."
            ),
            action="NONE",
            ref_workspace_id=workspace_id,
            ref_project_id=project_id,
        )
    else:
        await emit_to_audience(
            audience,
            actor_user_id=app_user["id"],
            event_code="PROJECT_NOW_WORKSPACE",
            title=f"{project_name} is now shared with the workspace",
            message=(f"Everyone in {workspace.get('name', 'this workspace')} can see it."),
            action="NAVIGATE_PROJECT",
            ref_workspace_id=workspace_id,
            ref_project_id=project_id,
        )

    return {"status": "updated", "visibility": body.visibility}


class ConversationUsageRow(BaseModel):
    id: str
    title: Optional[str] = None
    hours: float  # round to 2 decimals
    is_deleted: bool


class ConversationUsageResponse(BaseModel):
    active: list[ConversationUsageRow]
    deleted: list[ConversationUsageRow]
    total_hours: float
    active_hours: float
    deleted_hours: float


@router.get(
    "/{project_id}/conversation-usage",
    response_model=ConversationUsageResponse,
)
async def get_project_conversation_usage(
    project_id: str,
    auth: DependencyDirectusSession,
) -> ConversationUsageResponse:
    """Breakdown of per-conversation audio usage for the Access & usage
    tab (2026-04-24). Splits active from soft-deleted conversations so
    the UI can show a deleted-bucket segment with hover tooltips.
    """
    app_user = await get_app_user_or_raise(auth.user_id)
    access = await get_user_project_access(
        project_id=project_id,
        user_id=app_user["id"],
        directus_user_id=auth.user_id,
    )
    if access is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # No deleted_at filter — we want both buckets in one fetch.
    convs = (
        await async_directus.get_items(
            "conversation",
            {
                "query": {
                    "filter": {"project_id": {"_eq": project_id}},
                    "fields": ["id", "title", "duration", "deleted_at"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    if not isinstance(convs, list):
        convs = []

    active: list[ConversationUsageRow] = []
    deleted: list[ConversationUsageRow] = []
    for c in convs:
        hours = round(float(c.get("duration") or 0) / 3600, 2)
        row = ConversationUsageRow(
            id=c["id"],
            title=c.get("title"),
            hours=hours,
            is_deleted=bool(c.get("deleted_at")),
        )
        (deleted if row.is_deleted else active).append(row)

    # Longest conversations first — easier to scan the hover tooltips.
    active.sort(key=lambda r: r.hours, reverse=True)
    deleted.sort(key=lambda r: r.hours, reverse=True)

    active_hours = round(sum(r.hours for r in active), 2)
    deleted_hours = round(sum(r.hours for r in deleted), 2)

    return ConversationUsageResponse(
        active=active,
        deleted=deleted,
        total_hours=round(active_hours + deleted_hours, 2),
        active_hours=active_hours,
        deleted_hours=deleted_hours,
    )
