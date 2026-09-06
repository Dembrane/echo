"""REST face of agent access, mounted at /api/v2/agent.

Same tools as the MCP server, for agents that speak plain HTTP: one route
per tool, the same names in the audit, the same answer shapes. Auth is the
OAuth access token as a bearer header. Every route records an audit row and
counts against the free-tier budget through the shared AgentContext. No
response cap here: an HTTP client pages for itself.
"""

from __future__ import annotations

from typing import Any, Optional, Annotated
from logging import getLogger
from collections.abc import Callable, Awaitable

from fastapi import Query, Depends, Request, APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.agent_access import tools as T
from dembrane.agent_access.oauth import AgentOAuthProvider
from dembrane.agent_access.context import AgentContext, context_from_access_token

logger = getLogger("api.v2.agent")

router = APIRouter()
_provider = AgentOAuthProvider()


async def require_agent(request: Request) -> AgentContext:
    header = request.headers.get("Authorization") or ""
    if not header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Bearer token required")
    token = await _provider.load_access_token(header[7:].strip())
    if token is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return await context_from_access_token(token)


DependencyAgent = Annotated[AgentContext, Depends(require_agent)]


async def _run(
    ctx: AgentContext,
    tool: str,
    params: dict[str, Any],
    fn: Callable[[], Awaitable[Any]],
    *,
    org_id: Optional[str] = None,
) -> Any:
    try:
        result = await fn()
    except HTTPException as exc:
        status = (
            "limited"
            if exc.status_code == 429
            else "denied"
            if exc.status_code in (401, 403, 404)
            else "error"
        )
        await ctx.record(tool, params, org_id=org_id, status=status)
        raise
    except Exception:
        await ctx.record(tool, params, org_id=org_id, status="error")
        raise
    await ctx.record(tool, params, org_id=org_id, status="ok")
    return result


# ── identity and discovery ─────────────────────────────────────────────────


@router.get("/whoami", response_model=T.Whoami)
async def whoami(ctx: DependencyAgent) -> T.Whoami:
    return await _run(ctx, "dembrane_whoami", {}, lambda: T.whoami(ctx))


@router.get("/tools", response_model=T.ToolCatalogue)
async def list_tools(ctx: DependencyAgent) -> T.ToolCatalogue:
    # The catalogue lives with the MCP registry; imported here so the router
    # does not pull the MCP server in at import time.
    from dembrane.agent_access.mcp_server import catalogue

    return await _run(ctx, "dembrane_list_tools", {}, lambda: catalogue(ctx))


@router.get("/projects/find", response_model=T.ProjectsFound)
async def find_projects(
    ctx: DependencyAgent,
    query: Optional[str] = Query(None),
    workspace_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> T.ProjectsFound:
    return await _run(
        ctx,
        "dembrane_find_projects",
        {"query": (query or "")[:200], "workspace_id": workspace_id, "limit": limit},
        lambda: T.find_projects(ctx, query=query, workspace_id=workspace_id, limit=limit),
    )


# ── projects ───────────────────────────────────────────────────────────────


@router.get("/projects/{project_id}", response_model=T.ProjectOut)
async def get_project(project_id: str, ctx: DependencyAgent) -> T.ProjectOut:
    return await _run(
        ctx,
        "dembrane_get_project",
        {"project_id": project_id},
        lambda: T.get_project(ctx, project_id),
    )


@router.patch("/projects/{project_id}", response_model=T.ProjectOut)
async def update_project(
    project_id: str, body: T.ProjectUpdateIn, ctx: DependencyAgent
) -> T.ProjectOut:
    return await _run(
        ctx,
        "dembrane_update_project",
        {"project_id": project_id, "fields": sorted(body.model_dump(exclude_unset=True))},
        lambda: T.update_project(ctx, project_id, body),
    )


@router.get("/projects/{project_id}/webhooks", response_model=T.WebhookList)
async def list_project_webhooks(project_id: str, ctx: DependencyAgent) -> T.WebhookList:
    return await _run(
        ctx,
        "dembrane_list_project_webhooks",
        {"project_id": project_id},
        lambda: T.list_project_webhooks(ctx, project_id),
    )


# ── conversations ──────────────────────────────────────────────────────────


@router.get("/projects/{project_id}/conversations", response_model=T.ConversationList)
async def list_conversations(
    project_id: str,
    ctx: DependencyAgent,
    search: Optional[str] = Query(None),
    created_after: Optional[str] = Query(None),
    created_before: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    sort: Annotated[T.ConversationSort, Query()] = "-created_at",
    format: Annotated[T.ResultFormat, Query()] = "concise",
) -> T.ConversationList:
    return await _run(
        ctx,
        "dembrane_list_conversations",
        {
            "project_id": project_id,
            "search": search,
            "created_after": created_after,
            "created_before": created_before,
            "limit": limit,
            "offset": offset,
            "sort": sort,
            "format": format,
        },
        lambda: T.list_conversations(
            ctx,
            project_id,
            search=search,
            limit=limit,
            offset=offset,
            sort=sort,
            created_after=created_after,
            created_before=created_before,
            format=format,
        ),
    )


@router.get("/projects/{project_id}/search", response_model=T.SearchResult)
async def search_transcripts(
    project_id: str,
    ctx: DependencyAgent,
    query: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> T.SearchResult:
    return await _run(
        ctx,
        "dembrane_search_transcripts",
        {"project_id": project_id, "query": query[:200], "limit": limit, "offset": offset},
        lambda: T.search_transcripts(ctx, project_id, query, limit=limit, offset=offset),
    )


@router.get("/conversations/{conversation_id}/grep", response_model=T.GrepResult)
async def grep_conversation(
    conversation_id: str,
    ctx: DependencyAgent,
    query: str = Query(..., min_length=1),
    max_matches: int = Query(10, ge=1, le=50),
) -> T.GrepResult:
    return await _run(
        ctx,
        "dembrane_grep_conversation",
        {"conversation_id": conversation_id, "query": query[:200], "max_matches": max_matches},
        lambda: T.grep_conversation(ctx, conversation_id, query, max_matches=max_matches),
    )


@router.get("/conversations/{conversation_id}/transcript", response_model=T.TranscriptPageOut)
async def read_transcript(
    conversation_id: str,
    ctx: DependencyAgent,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    format: Annotated[T.ResultFormat, Query()] = "concise",
) -> T.TranscriptPageOut:
    return await _run(
        ctx,
        "dembrane_read_transcript",
        {"conversation_id": conversation_id, "offset": offset, "limit": limit, "format": format},
        lambda: T.read_transcript(ctx, conversation_id, offset=offset, limit=limit, format=format),
    )


@router.get("/conversations/{conversation_id}", response_model=T.ConversationOut)
async def get_conversation(conversation_id: str, ctx: DependencyAgent) -> T.ConversationOut:
    return await _run(
        ctx,
        "dembrane_get_conversation",
        {"conversation_id": conversation_id},
        lambda: T.get_conversation(ctx, conversation_id),
    )


# ── documentation ──────────────────────────────────────────────────────────


@router.get("/docs/read", response_model=T.DocReadOut)
async def read_doc(
    ctx: DependencyAgent,
    path: str = Query(...),
    offset: int = Query(1, ge=1),
    limit: int = Query(400, ge=1, le=400),
) -> T.DocReadOut:
    return await _run(
        ctx,
        "dembrane_read_doc",
        {"path": path, "offset": offset, "limit": limit},
        lambda: T.read_doc(ctx, path, offset=offset, limit=limit),
    )


@router.get("/docs/search", response_model=T.DocSearchOut)
async def search_docs(
    ctx: DependencyAgent,
    pattern: Optional[str] = Query(None),
    max_results: int = Query(50, ge=1, le=50),
) -> T.DocSearchOut:
    return await _run(
        ctx,
        "dembrane_search_docs",
        {"pattern": (pattern or "")[:200], "max_results": max_results},
        lambda: T.search_docs(ctx, pattern, max_results=max_results),
    )


# ── reporting back to dembrane ─────────────────────────────────────────────


class IssueIn(BaseModel):
    message: str = Field(..., min_length=1, max_length=8000)
    project_id: Optional[str] = None
    conversation_id: Optional[str] = None


class ToolRequestIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: str = Field(..., min_length=1, max_length=8000)
    example: Optional[str] = Field(None, max_length=2000)


@router.post("/issues", response_model=T.TicketOut)
async def report_issue(body: IssueIn, ctx: DependencyAgent) -> T.TicketOut:
    return await _run(
        ctx,
        "dembrane_report_issue",
        {
            "project_id": body.project_id,
            "conversation_id": body.conversation_id,
            "chars": len(body.message),
        },
        lambda: T.report_issue(
            ctx, body.message, project_id=body.project_id, conversation_id=body.conversation_id
        ),
    )


@router.post("/tool-requests", response_model=T.TicketOut)
async def request_tool(body: ToolRequestIn, ctx: DependencyAgent) -> T.TicketOut:
    return await _run(
        ctx,
        "dembrane_request_tool",
        {"name": body.name, "chars": len(body.description)},
        lambda: T.request_tool(ctx, body.name, body.description, example=body.example),
    )
