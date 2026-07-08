"""BFF endpoints for project goals and methodologies."""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import Query, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.utils import generate_uuid
from dembrane.methodologies import (
    METHODOLOGY_VERSION_DETAIL_FIELDS,
    methodology_card,
    methodology_detail,
    list_visible_methodologies,
)
from dembrane.project_goals import to_goal_revision, list_project_goal_revisions
from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import get_workspace_context
from dembrane.api.v2.bff._access import resolve_project_access
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()  # /v2/bff/projects
methodologies_router = APIRouter()  # /v2/bff/methodologies


class GoalCreate(BaseModel):
    content: str = Field(..., min_length=1)
    chat_id: Optional[str] = None
    # Provenance: 'interview' when the host applies a goal the assistant
    # proposed after interviewing; 'loop' is reserved for the system.
    set_by: Literal["host-edit", "interview"] = "host-edit"


class MethodologyCreate(BaseModel):
    workspace_id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    description: str = Field(..., min_length=1)
    framing: str = Field(..., min_length=1)
    content: Any = None


class MethodologyEdit(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    framing: Optional[str] = None
    content: Any = None
    note: Optional[str] = None


def _trim_required(value: str, field: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail=f"{field} is required")
    return normalized


def _trim_optional(value: Optional[str], field: str) -> Optional[str]:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        raise HTTPException(status_code=400, detail=f"{field} cannot be empty")
    return normalized


async def _get_methodology_or_404(methodology_id: str) -> dict[str, Any]:
    row = await async_directus.get_item("methodology", methodology_id)
    if not isinstance(row, dict) or not row:
        raise HTTPException(status_code=404, detail="Methodology not found")
    return row


async def _list_methodology_versions(methodology_id: str) -> list[dict[str, Any]]:
    rows = await async_directus.get_items(
        "methodology_version",
        {
            "query": {
                "filter": {"methodology_id": {"_eq": methodology_id}},
                "fields": METHODOLOGY_VERSION_DETAIL_FIELDS,
                "sort": ["-created_at"],
                "limit": -1,
            }
        },
    )
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


async def _require_methodology_visible(row: dict[str, Any], auth: DependencyDirectusSession) -> None:
    visibility = row.get("visibility")
    owner_id = row.get("owner_directus_user_id")
    workspace_id = row.get("workspace_id")
    if visibility == "public" or owner_id == auth.user_id:
        return
    if workspace_id:
        await get_workspace_context(str(workspace_id), auth)
        return
    raise HTTPException(status_code=404, detail="Methodology not found")


async def _require_methodology_editable(row: dict[str, Any], auth: DependencyDirectusSession) -> None:
    if row.get("is_seeded"):
        raise HTTPException(status_code=403, detail="The dembrane methodology is read-only")
    if row.get("owner_directus_user_id") == auth.user_id:
        return
    workspace_id = row.get("workspace_id")
    if row.get("visibility") == "workspace" and workspace_id:
        ctx = await get_workspace_context(str(workspace_id), auth)
        if ctx.has_policy("settings:manage"):
            return
    raise HTTPException(status_code=403, detail="Not allowed")


@router.get("/{project_id}/goal")
async def get_project_goal(
    project_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    access = await resolve_project_access(project_id, auth)
    access.require("project:read")

    revisions = await list_project_goal_revisions(project_id)
    return {
        "current": revisions[0] if revisions else None,
        "revisions": revisions,
    }


@router.post("/{project_id}/goal")
async def create_project_goal_revision(
    project_id: str,
    body: GoalCreate,
    auth: DependencyDirectusSession,
) -> dict:
    access = await resolve_project_access(project_id, auth)
    access.require("project:update")

    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    created = await async_directus.create_item(
        "project_goal_revision",
        {
            "id": generate_uuid(),
            "project_id": project_id,
            "content": content,
            "set_by": body.set_by,
            "chat_id": body.chat_id,
            "created_by": auth.user_id,
        },
    )
    row = created.get("data") if isinstance(created, dict) else created
    return to_goal_revision(row if isinstance(row, dict) else {})


@methodologies_router.get("")
async def list_methodologies(
    auth: DependencyDirectusSession,
    workspace_id: str = Query(..., min_length=1),
) -> list[dict]:
    await get_workspace_context(workspace_id, auth)
    return await list_visible_methodologies(
        workspace_id=workspace_id,
        directus_user_id=auth.user_id,
    )


@methodologies_router.post("")
async def create_methodology(
    body: MethodologyCreate,
    auth: DependencyDirectusSession,
) -> dict:
    workspace_id = body.workspace_id.strip()
    ctx = await get_workspace_context(workspace_id, auth)
    if not ctx.has_policy("project:create"):
        raise HTTPException(status_code=403, detail="Not allowed")

    methodology_id = generate_uuid()
    version_id = generate_uuid()
    methodology_payload = {
        "id": methodology_id,
        "workspace_id": workspace_id,
        "owner_directus_user_id": auth.user_id,
        "visibility": "workspace",
        "is_seeded": False,
        "name": _trim_required(body.name, "name"),
        "description": _trim_required(body.description, "description"),
        "framing": _trim_required(body.framing, "framing"),
    }
    created = await async_directus.create_item("methodology", methodology_payload)
    methodology_row = created.get("data") if isinstance(created, dict) else created
    if not isinstance(methodology_row, dict):
        methodology_row = methodology_payload

    version_payload = {
        "id": version_id,
        "methodology_id": methodology_id,
        # methodology_version.content is NOT NULL in the schema; an omitted
        # content must land as an empty object, not null (echo-next 500).
        "content": body.content if body.content is not None else {},
        "note": "Initial history",
        "created_by": auth.user_id,
    }
    created_version = await async_directus.create_item("methodology_version", version_payload)
    version_row = created_version.get("data") if isinstance(created_version, dict) else created_version
    if not isinstance(version_row, dict):
        version_row = version_payload
    return methodology_card(methodology_row, [version_row])


@methodologies_router.get("/{methodology_id}")
async def get_methodology(
    methodology_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    row = await _get_methodology_or_404(methodology_id)
    await _require_methodology_visible(row, auth)
    versions = await _list_methodology_versions(methodology_id)
    return methodology_detail(row, versions)


@methodologies_router.post("/{methodology_id}/versions")
async def update_methodology(
    methodology_id: str,
    body: MethodologyEdit,
    auth: DependencyDirectusSession,
) -> dict:
    row = await _get_methodology_or_404(methodology_id)
    await _require_methodology_editable(row, auth)

    updates: dict[str, Any] = {}
    if "name" in body.model_fields_set:
        updates["name"] = _trim_optional(body.name, "name")
    if "description" in body.model_fields_set:
        updates["description"] = _trim_optional(body.description, "description")
    if "framing" in body.model_fields_set:
        updates["framing"] = _trim_optional(body.framing, "framing")
    updates = {key: value for key, value in updates.items() if value is not None}

    if updates:
        updated = await async_directus.update_item("methodology", methodology_id, updates)
        updated_row = updated.get("data") if isinstance(updated, dict) else updated
        if isinstance(updated_row, dict):
            row = {**row, **updated_row}
        else:
            row = {**row, **updates}

    versions = await _list_methodology_versions(methodology_id)
    if "content" in body.model_fields_set:
        version_payload = {
            "id": generate_uuid(),
            "methodology_id": methodology_id,
            "content": body.content if body.content is not None else {},
            "note": _trim_optional(body.note, "note") if "note" in body.model_fields_set else None,
            "created_by": auth.user_id,
        }
        created = await async_directus.create_item("methodology_version", version_payload)
        version_row = created.get("data") if isinstance(created, dict) else created
        if not isinstance(version_row, dict):
            version_row = version_payload
        versions = [version_row, *versions]

    return methodology_card(row, versions)
