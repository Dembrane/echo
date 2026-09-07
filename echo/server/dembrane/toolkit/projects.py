"""Project read primitives: find a project by name across everything the
caller can reach."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from pydantic import BaseModel

from dembrane.app_user import get_app_user_or_raise
from dembrane.inheritance import get_user_project_access
from dembrane.directus_async import async_directus
from dembrane.search_filters import merge_search_filter

if TYPE_CHECKING:
    from dembrane.api.dependency_auth import DirectusSession

FIND_LIMIT_MAX = 200


class ProjectHit(BaseModel):
    id: str
    name: str
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    org_id: Optional[str] = None
    updated_at: Optional[str] = None


def _s(value: Any) -> Optional[str]:
    return None if value is None else str(value)


async def reachable_workspace_ids(app_user_id: str) -> list[str]:
    """Workspaces the user holds a membership in, plus every workspace of an
    organisation they admin or own (the derived route the ladder allows)."""
    memberships = await async_directus.get_items(
        "workspace_membership",
        {
            "query": {
                "filter": {"user_id": {"_eq": app_user_id}, "deleted_at": {"_null": True}},
                "fields": ["workspace_id"],
                "limit": -1,
            }
        },
    )
    ws_ids: list[str] = []
    for row in memberships if isinstance(memberships, list) else []:
        ws_id = _s(row.get("workspace_id"))
        if ws_id and ws_id not in ws_ids:
            ws_ids.append(ws_id)

    org_rows = await async_directus.get_items(
        "org_membership",
        {
            "query": {
                "filter": {
                    "user_id": {"_eq": app_user_id},
                    "deleted_at": {"_null": True},
                    "role": {"_in": ["admin", "owner"]},
                },
                "fields": ["org_id"],
                "limit": -1,
            }
        },
    )
    org_ids = [
        str(row["org_id"])
        for row in (org_rows if isinstance(org_rows, list) else [])
        if row.get("org_id")
    ]
    if org_ids:
        derived = await async_directus.get_items(
            "workspace",
            {
                "query": {
                    "filter": {"org_id": {"_in": org_ids}, "deleted_at": {"_null": True}},
                    "fields": ["id"],
                    "limit": -1,
                }
            },
        )
        for row in derived if isinstance(derived, list) else []:
            ws_id = _s(row.get("id"))
            if ws_id and ws_id not in ws_ids:
                ws_ids.append(ws_id)
    return ws_ids


async def _workspaces_by_id(ws_ids: list[str]) -> dict[str, dict[str, Any]]:
    if not ws_ids:
        return {}
    rows = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {"id": {"_in": ws_ids}},
                "fields": ["id", "name", "org_id"],
                "limit": -1,
            }
        },
    )
    return {
        str(row["id"]): row
        for row in (rows if isinstance(rows, list) else [])
        if isinstance(row, dict) and row.get("id")
    }


async def find_projects(
    query: Optional[str],
    *,
    limit: int,
    session: DirectusSession,
    workspace_id: Optional[str] = None,
) -> list[ProjectHit]:
    """Projects the caller can open, across every workspace they can reach,
    most recently updated first. `query` matches the name, case-insensitive,
    every word required. `workspace_id` narrows to one workspace; one the
    caller cannot reach yields nothing rather than an error. Fewer than
    `limit` may come back: the access ladder filters after the read, so
    private projects without a share drop out."""
    app_user = await get_app_user_or_raise(session.user_id)
    app_user_id = str(app_user["id"])
    ws_ids = await reachable_workspace_ids(app_user_id)
    if workspace_id:
        ws_ids = [ws_id for ws_id in ws_ids if ws_id == workspace_id]
    if not ws_ids:
        return []

    flt: dict[str, Any] = {"workspace_id": {"_in": ws_ids}, "deleted_at": {"_null": True}}
    if query and query.strip():
        flt = merge_search_filter(flt, query.strip(), ["name"])
    rows = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": flt,
                # visibility and directus_user_id feed the access ladder, so it
                # need not re-read the project row.
                "fields": [
                    "id",
                    "name",
                    "workspace_id",
                    "visibility",
                    "directus_user_id",
                    "updated_at",
                ],
                "sort": ["-updated_at"],
                "limit": max(1, min(int(limit), FIND_LIMIT_MAX)),
            }
        },
    )
    projects = [
        row
        for row in (rows if isinstance(rows, list) else [])
        if isinstance(row, dict) and row.get("id")
    ]
    workspaces = await _workspaces_by_id(
        sorted({str(row["workspace_id"]) for row in projects if row.get("workspace_id")})
    )

    out: list[ProjectHit] = []
    for row in projects:
        access = await get_user_project_access(
            project_id=str(row["id"]),
            user_id=app_user_id,
            directus_user_id=session.user_id,
            project=row,
        )
        if access is None:
            continue
        workspace = workspaces.get(str(row.get("workspace_id")), {})
        out.append(
            ProjectHit(
                id=str(row["id"]),
                name=str(row.get("name") or ""),
                workspace_id=_s(row.get("workspace_id")),
                workspace_name=_s(workspace.get("name")),
                org_id=_s(workspace.get("org_id")),
                updated_at=_s(row.get("updated_at")),
            )
        )
    return out
