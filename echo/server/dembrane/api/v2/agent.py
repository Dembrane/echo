"""REST face of agent access, mounted at /api/v2/agent.

Same tools as the MCP server, for agents that speak plain HTTP. Auth is the
OAuth access token as a bearer header. Every route records an audit row and
counts against the free-tier budget through the shared AgentContext.
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


@router.get("/whoami", response_model=T.Whoami)
async def whoami(ctx: DependencyAgent) -> T.Whoami:
    return await _run(ctx, "whoami", {}, lambda: T.whoami(ctx))


@router.get("/organisations", response_model=list[T.OrganisationOut])
async def list_organisations(ctx: DependencyAgent) -> list[T.OrganisationOut]:
    return await _run(ctx, "list_organisations", {}, lambda: T.list_organisations(ctx))


@router.get("/organisations/{organisation_id}/workspaces", response_model=list[T.WorkspaceOut])
async def list_workspaces(organisation_id: str, ctx: DependencyAgent) -> list[T.WorkspaceOut]:
    return await _run(
        ctx,
        "list_workspaces",
        {"organisation_id": organisation_id},
        lambda: T.list_workspaces(ctx, organisation_id),
        org_id=organisation_id,
    )


@router.get("/workspaces/{workspace_id}/projects", response_model=list[T.ProjectOut])
async def list_projects(
    workspace_id: str,
    ctx: DependencyAgent,
    search: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> list[T.ProjectOut]:
    return await _run(
        ctx,
        "list_projects",
        {"workspace_id": workspace_id, "search": search, "limit": limit},
        lambda: T.list_projects(ctx, workspace_id, search=search, limit=limit),
    )


@router.get("/projects/find", response_model=list[T.ProjectHit])
async def find_projects(
    ctx: DependencyAgent,
    q: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
) -> list[T.ProjectHit]:
    return await _run(
        ctx,
        "find_projects",
        {"query": (q or "")[:200], "limit": limit},
        lambda: T.find_projects(ctx, query=q, limit=limit),
    )


@router.get("/projects/{project_id}", response_model=T.ProjectOut)
async def get_project(project_id: str, ctx: DependencyAgent) -> T.ProjectOut:
    return await _run(
        ctx, "get_project", {"project_id": project_id}, lambda: T.get_project(ctx, project_id)
    )


@router.patch("/projects/{project_id}", response_model=T.ProjectOut)
async def update_project(
    project_id: str, body: T.ProjectUpdateIn, ctx: DependencyAgent
) -> T.ProjectOut:
    return await _run(
        ctx,
        "update_project",
        {"project_id": project_id, "fields": sorted(body.model_dump(exclude_unset=True))},
        lambda: T.update_project(ctx, project_id, body),
    )


@router.get("/projects/{project_id}/conversations", response_model=list[T.ConversationSummary])
async def list_conversations(
    project_id: str,
    ctx: DependencyAgent,
    search: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    sort: Annotated[T.ConversationSort, Query()] = "-created_at",
    created_after: Optional[str] = Query(None),
    created_before: Optional[str] = Query(None),
) -> list[T.ConversationSummary]:
    return await _run(
        ctx,
        "list_conversations",
        {
            "project_id": project_id,
            "search": search,
            "limit": limit,
            "offset": offset,
            "sort": sort,
            "created_after": created_after,
            "created_before": created_before,
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
        ),
    )


@router.get("/projects/{project_id}/search", response_model=T.SearchResult)
async def search_transcripts(
    project_id: str,
    ctx: DependencyAgent,
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> T.SearchResult:
    return await _run(
        ctx,
        "search_transcripts",
        {"project_id": project_id, "query": q[:200], "limit": limit, "offset": offset},
        lambda: T.search_transcripts(ctx, project_id, q, limit=limit, offset=offset),
    )


@router.get("/conversations/{conversation_id}/grep", response_model=list[T.Snippet])
async def grep_conversation(
    conversation_id: str,
    ctx: DependencyAgent,
    q: str = Query(..., min_length=1),
    max_matches: int = Query(10, ge=1, le=50),
) -> list[T.Snippet]:
    return await _run(
        ctx,
        "grep_conversation",
        {"conversation_id": conversation_id, "query": q[:200], "max_matches": max_matches},
        lambda: T.grep_conversation(ctx, conversation_id, q, max_matches=max_matches),
    )


@router.get("/conversations/{conversation_id}/transcript", response_model=T.TranscriptPage)
async def read_transcript(
    conversation_id: str,
    ctx: DependencyAgent,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> T.TranscriptPage:
    return await _run(
        ctx,
        "read_transcript",
        {"conversation_id": conversation_id, "offset": offset, "limit": limit},
        lambda: T.read_transcript(ctx, conversation_id, offset=offset, limit=limit),
    )


@router.get("/conversations/{conversation_id}", response_model=T.ConversationOut)
async def get_conversation(conversation_id: str, ctx: DependencyAgent) -> T.ConversationOut:
    return await _run(
        ctx,
        "get_conversation",
        {"conversation_id": conversation_id},
        lambda: T.get_conversation(ctx, conversation_id),
    )


@router.get("/docs", response_model=list[T.DocOut])
async def list_docs(ctx: DependencyAgent) -> list[T.DocOut]:
    return await _run(ctx, "list_docs", {}, lambda: T.list_docs(ctx))


@router.get("/docs/read", response_model=T.DocReadOut)
async def read_doc(
    ctx: DependencyAgent,
    path: str = Query(...),
    offset: int = Query(1, ge=1),
    limit: int = Query(400, ge=1, le=400),
) -> T.DocReadOut:
    return await _run(
        ctx,
        "read_doc",
        {"path": path, "offset": offset, "limit": limit},
        lambda: T.read_doc(ctx, path, offset=offset, limit=limit),
    )


@router.get("/docs/search", response_model=list[T.DocHitOut])
async def search_docs(
    ctx: DependencyAgent,
    pattern: str = Query(..., min_length=1),
    max_results: int = Query(50, ge=1, le=50),
) -> list[T.DocHitOut]:
    return await _run(
        ctx,
        "search_docs",
        {"pattern": pattern[:200], "max_results": max_results},
        lambda: T.search_docs(ctx, pattern, max_results=max_results),
    )


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
        "report_issue",
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
        "request_tool",
        {"name": body.name, "chars": len(body.description)},
        lambda: T.request_tool(ctx, body.name, body.description, example=body.example),
    )


class ConversationBatchIn(BaseModel):
    ids: list[str] = Field(..., max_length=T.BATCH_MAX)


@router.post("/conversations/batch", response_model=list[T.ConversationOut])
async def get_conversations(
    body: ConversationBatchIn, ctx: DependencyAgent
) -> list[T.ConversationOut]:
    return await _run(
        ctx,
        "get_conversations",
        {"conversation_ids": body.ids, "count": len(body.ids)},
        lambda: T.get_conversations(ctx, body.ids),
    )


@router.get("/projects/{project_id}/webhooks", response_model=list[T.WebhookOut])
async def list_project_webhooks(project_id: str, ctx: DependencyAgent) -> list[T.WebhookOut]:
    return await _run(
        ctx,
        "list_project_webhooks",
        {"project_id": project_id},
        lambda: T.list_project_webhooks(ctx, project_id),
    )
