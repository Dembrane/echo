"""BFF endpoints for project_tag + project_analysis_run + project writes.

Route prefix: /v2/bff/tags, /v2/bff/analysis-runs, /v2/bff/projects.

Tags are a project-local collection (no deleted_at — hard deletes).
Analysis runs are project-local too. Project writes (update + delete)
live here so we can retire the frontend's direct Directus calls.
"""

from __future__ import annotations

from typing import Optional
from logging import getLogger
from datetime import datetime, timezone

from fastapi import Query, APIRouter, HTTPException
from pydantic import BaseModel

from dembrane.utils import generate_uuid
from dembrane.directus_async import async_directus
from dembrane.api.v2.bff._access import (
    resolve_tag_access,
    resolve_project_access,
    resolve_analysis_run_access,
)
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()  # /v2/bff/tags
run_router = APIRouter()  # /v2/bff/analysis-runs
project_router = APIRouter()  # /v2/bff/projects
logger = getLogger("api.v2.bff.tags")


# ── /v2/bff/tags ──────────────────────────────────────────────────────


@router.get("")
async def list_tags(
    auth: DependencyDirectusSession,
    project_id: str = Query(...),
) -> list[dict]:
    """List tags for a project. Sorted by the stored `sort` field."""
    access = await resolve_project_access(project_id, auth)
    access.require("project:read")

    rows = await async_directus.get_items(
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
    return rows if isinstance(rows, list) else []


class TagCreate(BaseModel):
    project_id: str
    text: str
    sort: Optional[int] = None


@router.post("")
async def create_tag(
    body: TagCreate,
    auth: DependencyDirectusSession,
) -> dict:
    access = await resolve_project_access(body.project_id, auth)
    access.require("project:update")

    payload: dict = {
        "id": generate_uuid(),
        "project_id": body.project_id,
        "text": body.text,
    }
    if body.sort is not None:
        payload["sort"] = body.sort
    created = await async_directus.create_item("project_tag", payload)
    if isinstance(created, dict) and "data" in created:
        return created["data"]
    return created or {}


class TagUpdate(BaseModel):
    text: Optional[str] = None
    sort: Optional[int] = None


@router.patch("/{tag_id}")
async def update_tag(
    tag_id: str,
    body: TagUpdate,
    auth: DependencyDirectusSession,
) -> dict:
    access, _ = await resolve_tag_access(tag_id, auth)
    access.require("project:update")

    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")
    updated = await async_directus.update_item("project_tag", tag_id, payload)
    if isinstance(updated, dict) and "data" in updated:
        return updated["data"]
    return updated or {}


@router.delete("/{tag_id}")
async def delete_tag(
    tag_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Hard-delete a tag (no deleted_at on project_tag).

    Also cleans up any conversation_project_tag junction rows so
    orphaned references don't linger.
    """
    access, _ = await resolve_tag_access(tag_id, auth)
    access.require("project:update")

    junctions = await async_directus.get_items(
        "conversation_project_tag",
        {
            "query": {
                "filter": {"project_tag_id": {"_eq": tag_id}},
                "fields": ["id"],
                "limit": -1,
            }
        },
    )
    if isinstance(junctions, list):
        for row in junctions:
            rid = row.get("id")
            if rid:
                try:
                    await async_directus.delete_item("conversation_project_tag", rid)
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "conversation_project_tag cleanup delete failed id=%s",
                        rid,
                    )

    await async_directus.delete_item("project_tag", tag_id)
    return {"status": "deleted"}


# ── /v2/bff/analysis-runs ────────────────────────────────────────────


@run_router.get("")
async def list_analysis_runs(
    auth: DependencyDirectusSession,
    project_id: str = Query(...),
    limit: int = Query(20, ge=1, le=200),
) -> list[dict]:
    """List analysis runs for a project. Latest first."""
    access = await resolve_project_access(project_id, auth)
    access.require("project:read")
    rows = await async_directus.get_items(
        "project_analysis_run",
        {
            "query": {
                "filter": {"project_id": {"_eq": project_id}},
                "fields": ["id", "created_at", "updated_at", "processing_status"],
                "sort": ["-created_at"],
                "limit": limit,
            }
        },
    )
    return rows if isinstance(rows, list) else []


@run_router.get("/{run_id}")
async def get_analysis_run(
    run_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    _access, run = await resolve_analysis_run_access(run_id, auth)
    return run


@run_router.get("/{run_id}/new-chunks-count")
async def count_new_chunks(
    run_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Count conversation_chunks in the parent project created after
    this analysis run.

    Powers the "new conversations since last library regen" banner on
    the project overview. Replaces a frontend Directus read that
    forgot to scope by project_id (would have over-counted once
    Directus ACL is locked down).
    """
    _access, run = await resolve_analysis_run_access(run_id, auth)
    project_id = run.get("project_id")
    cutoff = run.get("created_at")
    if not project_id or not cutoff:
        return {"count": 0}

    # Chunks live under conversations — filter via the nested
    # conversation_id → project_id relation.
    rows = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "aggregate": {"count": "id"},
                "filter": {
                    "timestamp": {"_gt": cutoff},
                    "conversation_id": {"project_id": {"_eq": project_id}},
                },
            }
        },
    )
    if isinstance(rows, list) and rows:
        return {"count": int((rows[0].get("count") or {}).get("id", 0) or 0)}
    return {"count": 0}


# ── /v2/bff/projects (update/delete) ─────────────────────────────────
#
# Reads live at /v2/projects/:id/bff (kept for backward compat).
# Writes go here so every frontend call is behind the access layer.


class ProjectUpdate(BaseModel):
    # Whitelist of editable fields — anything else is rejected. Matches
    # what the host-side edit UIs actually change; raw relationships
    # like workspace_id or directus_user_id are off-limits here (use
    # /move for workspace_id).
    name: Optional[str] = None
    context: Optional[str] = None
    language: Optional[str] = None
    is_conversation_allowed: Optional[bool] = None
    default_conversation_title: Optional[str] = None
    default_conversation_description: Optional[str] = None
    default_conversation_finish_text: Optional[str] = None
    default_conversation_ask_for_participant_name: Optional[bool] = None
    default_conversation_ask_for_participant_email: Optional[bool] = None
    default_conversation_transcript_prompt: Optional[str] = None
    default_conversation_tutorial_slug: Optional[str] = None
    get_reply_mode: Optional[str] = None
    get_reply_prompt: Optional[str] = None
    is_get_reply_enabled: Optional[bool] = None
    is_verify_enabled: Optional[bool] = None
    is_verify_on_finish_enabled: Optional[bool] = None
    selected_verification_key_list: Optional[list] = None
    is_project_notification_subscription_allowed: Optional[bool] = None
    anonymize_transcripts: Optional[bool] = None
    enable_ai_title_and_tags: Optional[bool] = None
    conversation_title_prompt: Optional[str] = None
    image_generation_model: Optional[str] = None
    tutorial_slug: Optional[str] = None


@project_router.get("")
async def list_my_projects(
    auth: DependencyDirectusSession,
    limit: int = Query(1000, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    search: Optional[str] = Query(None),
) -> list[dict]:
    """List every project the caller can access, across all workspaces.

    Powers the move-conversation picker (needs a cross-workspace list
    of targets). Enumerates the caller's workspaces, fetches projects
    per workspace, then filters by access via get_user_project_access
    so derived-only members see the right set.

    Intended for picker UIs — if you already know the workspace id,
    use /v2/workspaces/{id}/projects instead; it's cheaper.
    """
    from dembrane.app_user import get_app_user_or_raise
    from dembrane.inheritance import get_user_project_access

    app_user = await get_app_user_or_raise(auth.user_id)
    app_user_id = app_user["id"]

    # Direct rows — plus any workspace the user can derive into (organisation
    # admin/owner inheritance). Simpler: pull workspace ids via
    # get_effective_members... actually the cheapest read is
    # workspace_membership rows the user has.
    ws_rows = (
        await async_directus.get_items(
            "workspace_membership",
            {
                "query": {
                    "filter": {
                        "user_id": {"_eq": app_user_id},
                        "deleted_at": {"_null": True},
                    },
                    "fields": ["workspace_id"],
                    "limit": -1,
                }
            },
        )
        or []
    )
    ws_ids = [
        row["workspace_id"]
        for row in (ws_rows if isinstance(ws_rows, list) else [])
        if row.get("workspace_id")
    ]

    # Also include workspaces the user reaches by organisation admin/owner
    # derivation. Org rows where role in (admin, owner) grant access to
    # every workspace under that org.
    org_rows = (
        await async_directus.get_items(
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
        or []
    )
    org_ids = [
        row["org_id"]
        for row in (org_rows if isinstance(org_rows, list) else [])
        if row.get("org_id")
    ]
    if org_ids:
        derived_ws = (
            await async_directus.get_items(
                "workspace",
                {
                    "query": {
                        "filter": {
                            "org_id": {"_in": org_ids},
                            "deleted_at": {"_null": True},
                        },
                        "fields": ["id"],
                        "limit": -1,
                    }
                },
            )
            or []
        )
        for row in derived_ws if isinstance(derived_ws, list) else []:
            if row.get("id") and row["id"] not in ws_ids:
                ws_ids.append(row["id"])

    if not ws_ids:
        return []

    filt: dict = {
        "workspace_id": {"_in": ws_ids},
        "deleted_at": {"_null": True},
    }
    # Directus project rows don't have a full-text index; `search` param
    # does a LIKE match across string fields when the server-side
    # directus_client supports it.
    query: dict = {
        "filter": filt,
        "fields": [
            "id",
            "name",
            "workspace_id",
            "visibility",
            "language",
            "updated_at",
            "directus_user_id",
        ],
        "sort": ["-updated_at"],
        "limit": limit,
        "offset": offset,
    }
    if search and search.strip():
        query["search"] = search.strip()
    raw = await async_directus.get_items("project", {"query": query}) or []
    raw_list = raw if isinstance(raw, list) else []

    # Final filter via access layer — admins/owners derive in, members
    # with a workspace_membership row pass through trivially, private
    # projects get filtered for non-admins without a share.
    out: list[dict] = []
    for p in raw_list:
        access = await get_user_project_access(
            project_id=p["id"],
            user_id=app_user_id,
            directus_user_id=auth.user_id,
        )
        if access is None:
            continue
        out.append(p)
    return out


@project_router.patch("/{project_id}")
async def update_project(
    project_id: str,
    body: ProjectUpdate,
    auth: DependencyDirectusSession,
) -> dict:
    """Edit a project. Gated on project:update.

    Language changes + visibility changes are NOT handled here — use
    /v2/projects/:id/visibility for visibility (tier-gated, already
    implemented). Language is writable via the normal path for now.
    """
    access = await resolve_project_access(project_id, auth)
    access.require("project:update")

    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")

    updated = await async_directus.update_item("project", project_id, payload)
    if isinstance(updated, dict) and "data" in updated:
        return updated["data"]
    return updated or {}


@project_router.delete("/{project_id}")
async def delete_project(
    project_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Soft-delete a project. Admin only (project:delete)."""
    access = await resolve_project_access(project_id, auth)
    access.require("project:delete")

    now_iso = datetime.now(timezone.utc).isoformat()
    await async_directus.update_item("project", project_id, {"deleted_at": now_iso})

    workspace_id = access.workspace_id
    if workspace_id:
        from dembrane.cache_utils import invalidate_workspace_and_org_usage

        await invalidate_workspace_and_org_usage(workspace_id, access.org_id)

    return {"status": "deleted"}
