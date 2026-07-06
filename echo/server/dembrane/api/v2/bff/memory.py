"""BFF endpoints for agent_memory: what the assistant remembers.

Route prefix: /v2/bff/memory.

Hosts can see and delete memories; they cannot author or edit them here.
The assistant is the only writer (see api/agentic.py write_project_memory).
Human-written guidance belongs in project.context / workspace.context,
not in agent_memory.

Access mirrors the agent's own memory path: reading or clearing a
project/workspace memory needs chat:use — the same policy that lets a
member create these memories through chat. User-scope memories may hold
private content, so they are visible to and deletable by their owner only.
"""

from __future__ import annotations

from typing import Any
from logging import getLogger

from fastapi import APIRouter, HTTPException

from dembrane.api.agentic import MEMORY_READ_LIMIT, MEMORY_CARD_FIELDS
from dembrane.directus_async import async_directus
from dembrane.api.v2.middleware import get_workspace_context
from dembrane.api.v2.bff._access import resolve_project_access
from dembrane.api.dependency_auth import DependencyDirectusSession

router = APIRouter()  # /v2/bff/memory
logger = getLogger("api.v2.bff.memory")

# The agent's card shape plus created_at for the settings UI. One source
# of truth (agentic.py) so the agent-facing and host-facing cards can't
# drift apart.
MEMORY_LIST_FIELDS = [*MEMORY_CARD_FIELDS, "created_at"]
MEMORY_LIST_LIMIT = MEMORY_READ_LIMIT


def _to_memory_card(row: dict[str, Any]) -> dict[str, Any]:
    return {field: row.get(field) for field in MEMORY_LIST_FIELDS}


async def _list_memory(filter_: dict[str, Any]) -> list[dict[str, Any]]:
    rows = await async_directus.get_items(
        "agent_memory",
        {
            "query": {
                "filter": filter_,
                "fields": MEMORY_LIST_FIELDS,
                "sort": ["-updated_at"],
                "limit": MEMORY_LIST_LIMIT,
            }
        },
    )
    if not isinstance(rows, list):
        # The async client returns Directus's error envelope (a dict) on
        # permission/schema failures. On this surface "empty" must never
        # mask "broken" — hosts read the empty state as "the assistant
        # stores nothing about me".
        logger.error("agent_memory read failed: %s", rows)
        raise HTTPException(status_code=502, detail="Couldn't read memories")
    return [_to_memory_card(row) for row in rows if isinstance(row, dict)]


@router.get("/user")
async def list_user_memory(auth: DependencyDirectusSession) -> list[dict]:
    """The caller's own user-scope memories. Owner-only — no policy gate,
    because the owner is the filter."""
    return await _list_memory(
        {
            "scope": {"_eq": "user"},
            "directus_user_id": {"_eq": auth.user_id},
        }
    )


@router.get("/project/{project_id}")
async def list_project_memory(
    project_id: str,
    auth: DependencyDirectusSession,
) -> list[dict]:
    access = await resolve_project_access(project_id, auth)
    access.require("chat:use")
    return await _list_memory(
        {
            "scope": {"_eq": "project"},
            "project_id": {"_eq": project_id},
        }
    )


@router.get("/workspace/{workspace_id}")
async def list_workspace_memory(
    workspace_id: str,
    auth: DependencyDirectusSession,
) -> list[dict]:
    ctx = await get_workspace_context(workspace_id, auth)
    ctx.require_policy("chat:use")
    return await _list_memory(
        {
            "scope": {"_eq": "workspace"},
            "workspace_id": {"_eq": workspace_id},
        }
    )


@router.delete("/{memory_id}")
async def delete_memory(
    memory_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """Forget one memory. The gate depends on the row's scope: user rows
    are owner-only (404 to everyone else, don't confirm existence),
    project/workspace rows need chat:use on that scope."""
    row = await async_directus.get_item("agent_memory", memory_id)
    if not isinstance(row, dict) or not row.get("id"):
        raise HTTPException(status_code=404, detail="Memory not found")

    scope = row.get("scope")
    if scope == "user":
        if row.get("directus_user_id") != auth.user_id:
            raise HTTPException(status_code=404, detail="Memory not found")
    elif scope == "project" and row.get("project_id"):
        access = await resolve_project_access(row["project_id"], auth)
        access.require("chat:use")
    elif scope == "workspace" and row.get("workspace_id"):
        ctx = await get_workspace_context(row["workspace_id"], auth)
        ctx.require_policy("chat:use")
    else:
        # Malformed row (unknown scope or missing owner id) — nobody can
        # reach it through this API; treat as absent.
        raise HTTPException(status_code=404, detail="Memory not found")

    await async_directus.delete_item("agent_memory", memory_id)
    return {"status": "deleted"}
