"""Workspace-scoped project endpoints: list and create."""

from logging import getLogger
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import (
    WorkspaceContext,
    get_workspace_context,
    require_no_pilot_block,
)
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()
logger = getLogger("api.v2.workspace_projects")


class ProjectAccessPreview(BaseModel):
    """A single avatar bubble on the project list card."""
    display_name: str
    avatar: Optional[str] = None


async def _enrich_previews(
    user_ids: list[str],
) -> dict[str, ProjectAccessPreview]:
    """Given app_user ids, return a dict of user_id → preview.

    One Directus call for app_user rows + one for directus_users avatars,
    regardless of how many user_ids we're enriching.
    """
    if not user_ids:
        return {}

    app_users = await async_directus.get_items(
        "app_user",
        {
            "query": {
                "filter": {"id": {"_in": user_ids}},
                "fields": ["id", "display_name", "directus_user_id"],
                "limit": -1,
            }
        },
    ) or []
    if not isinstance(app_users, list):
        return {}

    du_ids = [u["directus_user_id"] for u in app_users if u.get("directus_user_id")]
    avatar_map: dict[str, Optional[str]] = {}
    if du_ids:
        profiles = await async_directus.get_users(
            {
                "query": {
                    "filter": {"id": {"_in": du_ids}},
                    "fields": ["id", "avatar"],
                    "limit": -1,
                }
            }
        )
        if isinstance(profiles, list):
            avatar_map = {p["id"]: p.get("avatar") for p in profiles}

    return {
        u["id"]: ProjectAccessPreview(
            display_name=u.get("display_name") or "",
            avatar=avatar_map.get(u.get("directus_user_id") or "") or None,
        )
        for u in app_users
    }


async def _build_access_previews(
    *,
    workspace_id: str,
    project_ids: list[str],
    project_visibilities: dict[str, str],
) -> dict[str, tuple[list[ProjectAccessPreview], int]]:
    """Produce avatar bubbles + access count per project for the list view.

    Access model mirrors inheritance.get_user_project_access:
      - visibility='workspace' → every effective workspace member
        (direct + derived team admins/owners/members) has access.
      - visibility='private' → workspace admins/owners + users with a
        project_membership row.

    Returns: { project_id: (previews[:3], total_count) }
    """
    if not project_ids:
        return {}

    # Effective workspace members — includes derived team admins/owners.
    # One source of truth, matches what user_can_access would return per
    # user. This replaces the naive "only direct workspace_membership"
    # read which undercounted teams with inheritance.
    from dembrane.inheritance import get_effective_members

    effective = await get_effective_members(workspace_id)
    # Stable ordering so bubble preview is deterministic across requests:
    # direct rows first (they have real created_at), then derived.
    effective.sort(
        key=lambda m: (0 if m.get("source") == "direct" else 1, m.get("user_id", ""))
    )
    ws_user_ids_full = [m["user_id"] for m in effective if m.get("user_id")]
    ws_member_count = len(ws_user_ids_full)
    # Admins/owners subset — for the private-project fallback bubble set.
    ws_admin_user_ids = [
        m["user_id"]
        for m in effective
        if m.get("user_id") and m.get("role") in ("admin", "owner")
    ]

    # Per-private-project share rows.
    private_ids = [
        pid for pid in project_ids if project_visibilities.get(pid) == "private"
    ]
    private_shares: dict[str, list[str]] = {}
    if private_ids:
        rows = await async_directus.get_items(
            "project_membership",
            {
                "query": {
                    "filter": {"project_id": {"_in": private_ids}},
                    "fields": ["project_id", "user_id"],
                    "limit": -1,
                }
            },
        ) or []
        if isinstance(rows, list):
            for row in rows:
                pid = row.get("project_id")
                uid = row.get("user_id")
                if pid and uid:
                    private_shares.setdefault(pid, []).append(uid)

    # Per-private-project total count (admins union share rows, deduped).
    def _private_access_ids(project_id: str) -> list[str]:
        """Admins + shared users, deduped. Admins come first so they fill
        the preview bubbles when a project has few explicit shares."""
        shares = private_shares.get(project_id, [])
        seen: set[str] = set()
        ordered: list[str] = []
        for uid in ws_admin_user_ids + shares:
            if uid and uid not in seen:
                seen.add(uid)
                ordered.append(uid)
        return ordered

    # Collect the union of user_ids we'll need avatars for (capped at 3 per
    # project since that's all the UI renders). One batched enrich call.
    bubble_uids: set[str] = set(ws_user_ids_full[:3])
    for pid in private_ids:
        bubble_uids.update(_private_access_ids(pid)[:3])
    enriched = await _enrich_previews(list(bubble_uids))

    ws_previews = [enriched[u] for u in ws_user_ids_full[:3] if u in enriched]

    out: dict[str, tuple[list[ProjectAccessPreview], int]] = {}
    for pid in project_ids:
        if project_visibilities.get(pid) == "private":
            ids = _private_access_ids(pid)
            out[pid] = (
                [enriched[u] for u in ids[:3] if u in enriched],
                len(ids),
            )
        else:
            out[pid] = (ws_previews, ws_member_count)
    return out


async def _shared_private_project_ids(user_id: str) -> set[str]:
    """Return project_ids where this user has an explicit project_membership
    row. Used to un-hide private projects the user was shared on.
    """
    shares = await async_directus.get_items(
        "project_membership",
        {
            "query": {
                "filter": {"user_id": {"_eq": user_id}},
                "fields": ["project_id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(shares, list):
        return set()
    return {row["project_id"] for row in shares if row.get("project_id")}


class V2ProjectSummary(BaseModel):
    id: str
    name: Optional[str] = None
    updated_at: Optional[str] = None
    language: Optional[str] = None
    pin_order: Optional[int] = None
    conversations_count: int = 0
    visibility: str = "workspace"
    # Up to 3 previews + total access count. For workspace-visible projects
    # this is the first 3 workspace members. For private projects it's the
    # first 3 shared people (via project_membership).
    access_preview: list[ProjectAccessPreview] = []
    access_count: int = 0


class V2ProjectsListResponse(BaseModel):
    pinned: list[V2ProjectSummary] = []
    projects: list[V2ProjectSummary]
    total_count: int
    has_more: bool
    is_admin: bool = False


def _visibility_filter_for_caller(
    caller_role: str,
    shared_ids: set[str],
    creator_directus_id: Optional[str],
) -> Optional[dict]:
    """Build a Directus filter clause that server-side restricts the
    project query to visible rows for this caller.

    Admins/owners see everything → returns None (no extra clause).
    Non-admins see: workspace-visible OR shared-on OR legacy-creator.

    Keeps pagination and total_count honest — no post-filter Python slicing.
    """
    if caller_role in ("admin", "owner"):
        return None

    or_clauses: list[dict] = [
        {"visibility": {"_neq": "private"}},
        {"visibility": {"_null": True}},  # legacy rows with null visibility
    ]
    if shared_ids:
        or_clauses.append({"id": {"_in": list(shared_ids)}})
    if creator_directus_id:
        or_clauses.append({"directus_user_id": {"_eq": creator_directus_id}})

    return {"_or": or_clauses}


@router.get("/{workspace_id}/projects", response_model=V2ProjectsListResponse)
async def list_workspace_projects(
    auth: DependencyDirectusSession,
    ctx: WorkspaceContext = Depends(get_workspace_context),
    search: Optional[str] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(15, ge=1, le=100),
) -> V2ProjectsListResponse:
    """List projects in a workspace. Requires project:read policy.

    Private projects (visibility='private') are filtered at the Directus
    query level (via `_or`) so pagination, has_more, and total_count
    remain server-authoritative. See inheritance.get_user_project_access
    for the access ladder this mirrors.
    """
    ctx.require_policy("project:read")

    shared_ids = await _shared_private_project_ids(ctx.app_user_id)
    visibility_clause = _visibility_filter_for_caller(
        caller_role=ctx.role,
        shared_ids=shared_ids,
        creator_directus_id=auth.user_id,
    )

    base_filter: dict = {
        "workspace_id": {"_eq": ctx.workspace_id},
        "deleted_at": {"_null": True},
    }
    effective_filter = (
        {**base_filter, **visibility_clause}
        if visibility_clause is not None
        else base_filter
    )

    query: dict = {
        "fields": [
            "id",
            "name",
            "updated_at",
            "language",
            "pin_order",
            "visibility",
            "directus_user_id",
            "count(conversations)",
        ],
        "filter": effective_filter,
        "sort": ["-updated_at"],
        "limit": limit + 1,
        "offset": offset,
    }
    if search:
        query["search"] = search

    projects_raw = await async_directus.get_items("project", {"query": query})
    if not isinstance(projects_raw, list):
        projects_raw = []

    has_more = len(projects_raw) > limit
    page_rows = projects_raw[:limit]

    page_ids = [p["id"] for p in page_rows]
    page_visibilities = {
        p["id"]: (p.get("visibility") or "workspace") for p in page_rows
    }
    preview_map = await _build_access_previews(
        workspace_id=ctx.workspace_id,
        project_ids=page_ids,
        project_visibilities=page_visibilities,
    )

    projects = [
        V2ProjectSummary(
            id=p["id"],
            name=p.get("name"),
            updated_at=p.get("updated_at"),
            language=p.get("language"),
            pin_order=p.get("pin_order"),
            conversations_count=int(p.get("conversations_count", 0) or 0),
            visibility=p.get("visibility") or "workspace",
            access_preview=preview_map.get(p["id"], ([], 0))[0],
            access_count=preview_map.get(p["id"], ([], 0))[1],
        )
        for p in page_rows
    ]

    total_count = 0
    if not search:
        count_result = await async_directus.get_items(
            "project",
            {
                "query": {
                    "aggregate": {"count": ["id"]},
                    "filter": effective_filter,
                }
            },
        )
        if isinstance(count_result, list) and len(count_result) > 0:
            total_count = int(count_result[0].get("count", {}).get("id", 0))
    else:
        total_count = offset + len(projects) + (1 if has_more else 0)

    # Pinned list uses the same visibility filter so members don't see a
    # pinned private project they can't reach.
    pinned_raw = await async_directus.get_items("project", {"query": {
        "fields": [
            "id",
            "name",
            "updated_at",
            "language",
            "pin_order",
            "visibility",
            "directus_user_id",
            "count(conversations)",
        ],
        "filter": {**effective_filter, "pin_order": {"_nnull": True}},
        "sort": ["pin_order"],
        "limit": 3,
    }})
    pinned_rows = pinned_raw if isinstance(pinned_raw, list) else []
    pinned_ids = [p["id"] for p in pinned_rows]
    pinned_visibilities = {
        p["id"]: (p.get("visibility") or "workspace") for p in pinned_rows
    }
    pinned_preview_map = await _build_access_previews(
        workspace_id=ctx.workspace_id,
        project_ids=pinned_ids,
        project_visibilities=pinned_visibilities,
    )
    pinned = [
        V2ProjectSummary(
            id=p["id"],
            name=p.get("name"),
            updated_at=p.get("updated_at"),
            language=p.get("language"),
            pin_order=p.get("pin_order"),
            conversations_count=int(p.get("conversations_count", 0) or 0),
            visibility=p.get("visibility") or "workspace",
            access_preview=pinned_preview_map.get(p["id"], ([], 0))[0],
            access_count=pinned_preview_map.get(p["id"], ([], 0))[1],
        )
        for p in pinned_rows
    ]

    return V2ProjectsListResponse(
        pinned=pinned,
        projects=projects,
        total_count=total_count,
        has_more=has_more,
        is_admin=ctx.has_policy("settings:manage"),
    )


class V2CreateProjectRequest(BaseModel):
    name: str = "New Project"
    language: str = "en"


class V2CreateProjectResponse(BaseModel):
    id: str
    name: str
    workspace_id: str


@router.post("/{workspace_id}/projects", response_model=V2CreateProjectResponse)
async def create_workspace_project(
    body: V2CreateProjectRequest,
    auth: DependencyDirectusSession,
    ctx: WorkspaceContext = Depends(get_workspace_context),
) -> V2CreateProjectResponse:
    """Create a project in a workspace. Requires project:create policy.

    Host-side operation — gated by the Pilot hard-block (matrix §8). A
    Pilot workspace at the 10h cap cannot create new projects until the
    admin upgrades; the participant portal continues to operate regardless.
    """
    ctx.require_policy("project:create")
    await require_no_pilot_block(ctx)

    project_id = generate_uuid()
    result = await async_directus.create_item("project", {
        "id": project_id,
        "name": body.name,
        "language": body.language,
        "workspace_id": ctx.workspace_id,
        "directus_user_id": auth.user_id,
        "is_conversation_allowed": True,
    })
    project = result["data"]

    logger.info(f"Created project {project_id} in workspace {ctx.workspace_id} by {ctx.app_user_id}")

    return V2CreateProjectResponse(
        id=project["id"],
        name=project.get("name", body.name),
        workspace_id=ctx.workspace_id,
    )
