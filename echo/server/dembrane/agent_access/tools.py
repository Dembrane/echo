"""The tools an agent can call, as plain async functions over an AgentContext.

Both the REST router (`api/v2/agent.py`) and the MCP server call these. Each
one resolves access through the same helpers the dashboard uses, then narrows
to the organisations in the grant. Nothing here re-implements a permission.

Output shapes are deliberately small and stable: every tool answers with one
object, lists sit under a named key (`projects`, `conversations`, `chunks`),
and ids travel with names so an agent can read an answer without a second
call. A `format` switch on the two long-list tools keeps the default answer
short; `detailed` adds the text fields.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import HTTPException
from pydantic import BaseModel

from dembrane.settings import get_settings
from dembrane.free_tier import workspace_over_cap_active
from dembrane.directus_async import async_directus
from dembrane.api.v2.bff._access import (
    resolve_project_access,
    resolve_conversation_access,
)
from dembrane.agent_access.context import AgentContext
from dembrane.toolkit.conversations import (
    Snippet as Snippet,
    SearchResult as SearchResult,
    ConversationSort as ConversationSort,
    ConversationSummary as ConversationSummary,
    normalize_query_tokens,
)
from dembrane.api.v2.bff.conversations import _enrich_conversation

ResultFormat = Literal["concise", "detailed"]


# ── output models ──────────────────────────────────────────────────────────


class WorkspaceOut(BaseModel):
    id: str
    name: str
    role: Optional[str] = None
    tier: Optional[str] = None


class OrganisationOut(BaseModel):
    id: str
    name: str
    role: str
    # False when an organisation admin switched agent access off: the org is
    # still named so the agent understands why calls into it fail.
    agent_access_enabled: bool
    workspaces: list[WorkspaceOut] = []


class Whoami(BaseModel):
    app_user_id: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    scopes: list[str]
    grant_id: str
    client_name: str
    build_version: str
    organisations: list[OrganisationOut] = []


class ProjectFound(BaseModel):
    id: str
    name: str
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    organisation_id: Optional[str] = None
    organisation_name: Optional[str] = None
    updated_at: Optional[str] = None


class ProjectsFound(BaseModel):
    query: Optional[str] = None
    workspace_id: Optional[str] = None
    projects: list[ProjectFound] = []


class ProjectOut(BaseModel):
    id: str
    name: str
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    organisation_id: Optional[str] = None
    organisation_name: Optional[str] = None
    language: Optional[str] = None
    context: Optional[str] = None
    is_conversation_allowed: Optional[bool] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ProjectUpdateIn(BaseModel):
    name: Optional[str] = None
    context: Optional[str] = None
    language: Optional[str] = None
    is_conversation_allowed: Optional[bool] = None
    default_conversation_title: Optional[str] = None
    default_conversation_description: Optional[str] = None
    default_conversation_finish_text: Optional[str] = None


class ConversationConcise(BaseModel):
    id: str
    participant_name: Optional[str] = None
    title: Optional[str] = None
    created_at: Optional[str] = None
    duration: Optional[float] = None
    status: str


class ConversationDetailed(BaseModel):
    id: str
    participant_name: Optional[str] = None
    title: Optional[str] = None
    created_at: Optional[str] = None
    duration: Optional[float] = None
    status: str
    locked: bool = False
    summary: Optional[str] = None
    tags: list[str] = []


class ConversationList(BaseModel):
    project_id: str
    format: ResultFormat
    offset: int
    has_more: bool
    conversations: list[ConversationDetailed | ConversationConcise] = []


class ConversationOut(ConversationSummary):
    """One conversation's metadata: everything the list shows plus tags and
    the chunk count. Never the transcript; that is `read_transcript`."""

    chunk_count: int = 0
    tags: list[str] = []


class GrepResult(BaseModel):
    conversation_id: str
    tokens: list[str]
    matches: list[Snippet] = []


class TranscriptChunkConcise(BaseModel):
    timestamp: Optional[str] = None
    transcript: Optional[str] = None


class TranscriptChunkDetailed(BaseModel):
    id: str
    timestamp: Optional[str] = None
    transcript: Optional[str] = None


class TranscriptPageOut(BaseModel):
    conversation_id: str
    format: ResultFormat
    offset: int
    limit: int
    total: int
    has_more: bool
    transcript_locked: bool
    chunks: list[TranscriptChunkDetailed | TranscriptChunkConcise] = []


class TicketOut(BaseModel):
    id: str
    status: str
    kind: Literal["issue", "tool_request"]


class WebhookOut(BaseModel):
    id: str
    name: Optional[str] = None
    url: Optional[str] = None
    events: list[str] = []
    status: Optional[str] = None


class WebhookList(BaseModel):
    project_id: str
    webhooks: list[WebhookOut] = []


class ToolInfo(BaseModel):
    name: str
    description: str
    read_only: bool


class ToolCatalogue(BaseModel):
    build_version: str
    tools: list[ToolInfo] = []


# ── helpers ────────────────────────────────────────────────────────────────


def _s(value: Any) -> Optional[str]:
    return None if value is None else str(value)


def _rows(value: Any) -> list[dict[str, Any]]:
    return [r for r in value if isinstance(r, dict)] if isinstance(value, list) else []


async def _org_role(org_id: str, app_user_id: str) -> Optional[str]:
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
    if isinstance(rows, list) and rows:
        return _s(rows[0].get("role"))
    return None


async def _org_of(access: Any) -> Optional[str]:
    org_id = access.org_id
    if not org_id and access.workspace_id:
        ws = await async_directus.get_item("workspace", access.workspace_id)
        org_id = ws.get("org_id") if isinstance(ws, dict) else None
    return _s(org_id)


async def _project_access(ctx: AgentContext, project_id: str) -> Any:
    """Resolve project access as the user, then confirm its org is in the
    grant and switched on, then charge. 404 either way, so an agent cannot
    probe."""
    access = await resolve_project_access(project_id, ctx.session)
    org_id = await ctx.require_org(await _org_of(access))
    await ctx.charge(org_id)
    return access, org_id


async def _conversation_access(
    ctx: AgentContext, conversation_id: str
) -> tuple[Any, dict[str, Any], str]:
    """Resolve conversation access as the user and confirm its org is in the
    grant and switched on, then charge."""
    access, conv = await resolve_conversation_access(conversation_id, ctx.session)
    org_id = await ctx.require_org(await _org_of(access))
    await ctx.charge(org_id)
    return access, conv, org_id


async def _place_names(workspace_id: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """(workspace name, organisation name) for one workspace, so a project
    answer carries the names an agent would otherwise fetch."""
    if not workspace_id:
        return None, None
    rows = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {"id": {"_eq": workspace_id}},
                "fields": ["name", "org_id.name"],
                "limit": 1,
            }
        },
    )
    ws = next(iter(_rows(rows)), None)
    if ws is None:
        return None, None
    org = ws.get("org_id")
    return _s(ws.get("name")), _s(org.get("name")) if isinstance(org, dict) else None


async def _project_out(row: dict[str, Any], org_id: Optional[str]) -> ProjectOut:
    workspace_id = _s(row.get("workspace_id"))
    workspace_name, organisation_name = await _place_names(workspace_id)
    return ProjectOut(
        id=str(row["id"]),
        name=str(row.get("name") or ""),
        workspace_id=workspace_id,
        workspace_name=workspace_name,
        organisation_id=org_id,
        organisation_name=organisation_name,
        language=_s(row.get("language")),
        context=_s(row.get("context")),
        is_conversation_allowed=row.get("is_conversation_allowed"),
        created_at=_s(row.get("created_at")),
        updated_at=_s(row.get("updated_at")),
    )


def _conversation_summary(row: dict[str, Any]) -> ConversationSummary:
    return ConversationSummary(
        id=str(row["id"]),
        project_id=str(row.get("project_id")),
        title=_s(row.get("title")),
        participant_name=_s(row.get("participant_name")),
        summary=_s(row.get("summary")),
        source=_s(row.get("source")),
        duration=row.get("duration"),
        is_finished=row.get("is_finished"),
        is_all_chunks_transcribed=row.get("is_all_chunks_transcribed"),
        locked=bool(row.get("locked")),
        created_at=_s(row.get("created_at")),
        updated_at=_s(row.get("updated_at")),
    )


async def _tags_by_conversation(conversation_ids: list[str]) -> dict[str, list[str]]:
    if not conversation_ids:
        return {}
    rows = await async_directus.get_items(
        "conversation_project_tag",
        {
            "query": {
                "filter": {"conversation_id": {"_in": conversation_ids}},
                "fields": ["conversation_id", "project_tag_id.text"],
                "limit": -1,
            }
        },
    )
    out: dict[str, list[str]] = {}
    for row in _rows(rows):
        conv = row.get("conversation_id")
        cid = _s(conv.get("id") if isinstance(conv, dict) else conv)
        tag = row.get("project_tag_id")
        if cid and isinstance(tag, dict) and tag.get("text"):
            out.setdefault(cid, []).append(str(tag["text"]))
    return out


# ── identity and discovery ─────────────────────────────────────────────────


async def _workspaces_in(ctx: AgentContext, organisation_id: str) -> list[WorkspaceOut]:
    from dembrane.inheritance import resolve_workspace_access
    from dembrane.billing_account import nested_billing_fields, billing_from_workspace

    rows = await async_directus.get_items(
        "workspace",
        {
            "query": {
                "filter": {"org_id": {"_eq": organisation_id}, "deleted_at": {"_null": True}},
                "fields": ["*", *nested_billing_fields()],
                "limit": -1,
            }
        },
    )
    out: list[WorkspaceOut] = []
    for ws in _rows(rows):
        resolved = await resolve_workspace_access(ws, ctx.app_user_id)
        if resolved is None:
            continue
        role, _source, _membership = resolved
        out.append(
            WorkspaceOut(
                id=str(ws["id"]),
                name=str(ws.get("name") or ""),
                role=_s(role),
                tier=_s(billing_from_workspace(ws).get("tier")),
            )
        )
    return out


async def _organisations(ctx: AgentContext) -> list[OrganisationOut]:
    from dembrane.agent_access.context import guest_org_ids, org_agent_access_enabled

    if not ctx.org_ids:
        return []
    orgs = await async_directus.get_items(
        "org",
        {
            "query": {
                "filter": {"id": {"_in": ctx.org_ids}, "deleted_at": {"_null": True}},
                "fields": ["id", "name"],
                "limit": -1,
            }
        },
    )
    org_rows = _rows(orgs)
    if not org_rows:
        return []
    guest_orgs = set(await guest_org_ids(ctx.app_user_id))
    out: list[OrganisationOut] = []
    for org in org_rows:
        org_id = str(org["id"])
        role = await _org_role(org_id, ctx.app_user_id)
        if not role and org_id in guest_orgs:
            role = "guest"
        if not role:
            continue
        enabled = await org_agent_access_enabled(org_id)
        out.append(
            OrganisationOut(
                id=org_id,
                name=str(org.get("name") or ""),
                role=role,
                agent_access_enabled=enabled,
                workspaces=await _workspaces_in(ctx, org_id) if enabled else [],
            )
        )
    return out


async def whoami(ctx: AgentContext) -> Whoami:
    """The person the agent acts as and everything the grant can reach:
    organisations with their workspaces, roles and tiers. No charge: this
    is orientation, not a read of anyone's data."""
    user = await async_directus.get_item("app_user", ctx.app_user_id)
    row = user if isinstance(user, dict) else {}
    return Whoami(
        app_user_id=ctx.app_user_id,
        email=_s(row.get("email")),
        display_name=_s(row.get("display_name")),
        scopes=ctx.scopes,
        grant_id=ctx.grant_id,
        client_name=ctx.client_name,
        build_version=get_settings().build.build_version,
        organisations=await _organisations(ctx),
    )


async def find_projects(
    ctx: AgentContext,
    query: Optional[str] = None,
    workspace_id: Optional[str] = None,
    limit: int = 50,
) -> ProjectsFound:
    """Projects by name across the grant's organisations, optionally in one
    workspace. No charge: this is how an agent finds where to look before it
    spends a call. Organisations outside the grant, or switched off by their
    admin, are dropped rather than refused, so the answer never confirms
    what lies outside."""
    from dembrane.toolkit import projects as toolkit
    from dembrane.agent_access.context import org_agent_access_enabled

    hits = await toolkit.find_projects(
        query, limit=limit, session=ctx.session, workspace_id=workspace_id
    )
    enabled: dict[str, bool] = {}
    kept: list[toolkit.ProjectHit] = []
    for hit in hits:
        org_id = hit.org_id
        if not org_id or org_id not in ctx.org_ids:
            continue
        if org_id not in enabled:
            enabled[org_id] = await org_agent_access_enabled(org_id)
        if enabled[org_id]:
            kept.append(hit)

    org_names: dict[str, str] = {}
    if kept:
        orgs = await async_directus.get_items(
            "org",
            {
                "query": {
                    "filter": {"id": {"_in": sorted({str(h.org_id) for h in kept})}},
                    "fields": ["id", "name"],
                    "limit": -1,
                }
            },
        )
        org_names = {str(o["id"]): str(o.get("name") or "") for o in _rows(orgs)}
    return ProjectsFound(
        query=(query or "").strip() or None,
        workspace_id=workspace_id,
        projects=[
            ProjectFound(
                id=h.id,
                name=h.name,
                workspace_id=h.workspace_id,
                workspace_name=h.workspace_name,
                organisation_id=h.org_id,
                organisation_name=org_names.get(str(h.org_id)),
                updated_at=h.updated_at,
            )
            for h in kept
        ],
    )


# ── projects ───────────────────────────────────────────────────────────────


async def get_project(ctx: AgentContext, project_id: str) -> ProjectOut:
    access, org_id = await _project_access(ctx, project_id)
    return await _project_out(access.project, org_id)


async def update_project(ctx: AgentContext, project_id: str, body: ProjectUpdateIn) -> ProjectOut:
    ctx.require_write()
    access, org_id = await _project_access(ctx, project_id)
    access.require("project:update")
    payload = body.model_dump(exclude_unset=True)
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")
    updated = await async_directus.update_item("project", project_id, payload)
    row = updated.get("data") if isinstance(updated, dict) and "data" in updated else updated
    return await _project_out(
        row if isinstance(row, dict) else {**access.project, **payload}, org_id
    )


async def list_project_webhooks(ctx: AgentContext, project_id: str) -> WebhookList:
    from dembrane.api.project_webhook import _parse_webhook_events

    access, _org_id = await _project_access(ctx, project_id)
    access.require("workspace:webhooks")
    rows = await async_directus.get_items(
        "project_webhook",
        {
            "query": {
                "filter": {"project_id": {"_eq": project_id}, "deleted_at": {"_null": True}},
                "fields": ["id", "name", "url", "events", "status"],
                "sort": ["-date_created"],
                "limit": -1,
            }
        },
    )
    return WebhookList(
        project_id=project_id,
        webhooks=[
            WebhookOut(
                id=str(w["id"]),
                name=_s(w.get("name")),
                url=_s(w.get("url")),
                events=[str(e) for e in _parse_webhook_events(w.get("events"))],
                status=_s(w.get("status")),
            )
            for w in _rows(rows)
        ],
    )


# ── conversations ──────────────────────────────────────────────────────────


async def list_conversations(
    ctx: AgentContext,
    project_id: str,
    search: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    sort: ConversationSort = "-created_at",
    created_after: Optional[str] = None,
    created_before: Optional[str] = None,
    format: ResultFormat = "concise",
) -> ConversationList:
    """A page of a project's conversations. Concise carries what is needed
    to pick one; detailed adds the summary and tags. One charge per page,
    whatever the format."""
    from dembrane.toolkit import conversations as toolkit

    access, _org_id = await _project_access(ctx, project_id)
    page = await toolkit.list_conversations(
        project_id,
        search=search,
        limit=limit,
        offset=offset,
        sort=sort,
        created_after=created_after,
        created_before=created_before,
        session=ctx.session,
        access=access,
    )
    rows: list[ConversationDetailed | ConversationConcise]
    if format == "detailed":
        tags = await _tags_by_conversation([c.id for c in page.conversations])
        rows = [
            ConversationDetailed(
                id=c.id,
                participant_name=c.participant_name,
                title=c.title,
                created_at=c.created_at,
                duration=c.duration,
                status=c.status,
                locked=c.locked,
                summary=c.summary,
                tags=tags.get(c.id, []),
            )
            for c in page.conversations
        ]
    else:
        rows = [
            ConversationConcise(
                id=c.id,
                participant_name=c.participant_name,
                title=c.title,
                created_at=c.created_at,
                duration=c.duration,
                status=c.status,
            )
            for c in page.conversations
        ]
    return ConversationList(
        project_id=project_id,
        format=format,
        offset=page.offset,
        has_more=page.has_more,
        conversations=rows,
    )


async def search_transcripts(
    ctx: AgentContext, project_id: str, query: str, limit: int = 20, offset: int = 0
) -> SearchResult:
    """Conversations whose transcript contains the query's words, with snippets.
    One charge per call, whatever the page size."""
    from dembrane.toolkit import conversations as toolkit

    if not (query or "").strip():
        raise HTTPException(status_code=400, detail="query is required")
    access, _org_id = await _project_access(ctx, project_id)
    result = await toolkit.search_transcripts(
        project_id, query, limit=limit, offset=offset, session=ctx.session, access=access
    )
    if not result.tokens:
        raise HTTPException(
            status_code=400,
            detail=(
                f"query needs at least one word of {toolkit.MIN_TOKEN_LENGTH} letters or more; "
                "shorter words are ignored"
            ),
        )
    return result


async def grep_conversation(
    ctx: AgentContext, conversation_id: str, query: str, max_matches: int = 10
) -> GrepResult:
    from dembrane.toolkit import conversations as toolkit

    if not (query or "").strip():
        raise HTTPException(status_code=400, detail="query is required")
    tokens = normalize_query_tokens(query)
    if not tokens:
        raise HTTPException(
            status_code=400,
            detail=(
                f"query needs at least one word of {toolkit.MIN_TOKEN_LENGTH} letters or more; "
                "shorter words are ignored"
            ),
        )
    access, conv, _org_id = await _conversation_access(ctx, conversation_id)
    matches = await toolkit.grep_conversation(
        conversation_id,
        query,
        max_matches=max_matches,
        session=ctx.session,
        resolved=(access, conv),
    )
    return GrepResult(conversation_id=conversation_id, tokens=tokens, matches=matches)


async def read_transcript(
    ctx: AgentContext,
    conversation_id: str,
    offset: int = 0,
    limit: int = 50,
    format: ResultFormat = "concise",
) -> TranscriptPageOut:
    from dembrane.toolkit import conversations as toolkit

    access, conv, _org_id = await _conversation_access(ctx, conversation_id)
    page = await toolkit.read_transcript(
        conversation_id, offset=offset, limit=limit, session=ctx.session, resolved=(access, conv)
    )
    chunks: list[TranscriptChunkDetailed | TranscriptChunkConcise]
    if format == "detailed":
        chunks = [
            TranscriptChunkDetailed(id=c.id, timestamp=c.timestamp, transcript=c.transcript)
            for c in page.chunks
        ]
    else:
        chunks = [
            TranscriptChunkConcise(timestamp=c.timestamp, transcript=c.transcript)
            for c in page.chunks
        ]
    return TranscriptPageOut(
        conversation_id=conversation_id,
        format=format,
        offset=page.offset,
        limit=page.limit,
        total=page.total,
        has_more=page.has_more,
        transcript_locked=page.transcript_locked,
        chunks=chunks,
    )


async def get_conversation(ctx: AgentContext, conversation_id: str) -> ConversationOut:
    """One conversation's metadata: summary, tags, status, chunk count.
    Never the transcript; `read_transcript` pages that."""
    from dembrane.toolkit.conversations import _aggregate_count

    access, conv, _org_id = await _conversation_access(ctx, conversation_id)
    over_cap = await workspace_over_cap_active(access.workspace_id, access.tier)
    _enrich_conversation(conv, access.tier, over_cap)
    count_rows = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "aggregate": {"count": "id"},
                "filter": {"conversation_id": {"_eq": conversation_id}},
            }
        },
    )
    tags = await _tags_by_conversation([conversation_id])
    base = _conversation_summary(conv)
    return ConversationOut(
        **base.model_dump(exclude={"status"}),
        chunk_count=_aggregate_count(count_rows),
        tags=tags.get(conversation_id, []),
    )


# ── reporting back to dembrane ─────────────────────────────────────────────

MAX_TICKET_CHARS = 4000


def _clip(text: str, limit: int = MAX_TICKET_CHARS) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


async def report_issue(
    ctx: AgentContext,
    message: str,
    project_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
) -> TicketOut:
    """An agent reports something wrong with dembrane: a bad transcript, a
    tool that errored, data that looks off. Same table and forwarder as a
    host's report, source agent_mcp. Never transcript content."""
    from dembrane.support_requests import SOURCE_AGENT_MCP, file_support_request

    if not (message or "").strip():
        raise HTTPException(status_code=400, detail="message is required")
    workspace_id: Optional[str] = None
    org_id: Optional[str] = None
    if conversation_id and not project_id:
        access, _conv = await resolve_conversation_access(conversation_id, ctx.session)
        project_id = access.project_id
    if project_id:
        access, org_id = await _project_access(ctx, project_id)
        workspace_id = access.workspace_id
    body = f"[{ctx.client_name} via MCP] {_clip(message)}"
    if conversation_id:
        body += f"\nConversation: {conversation_id}"
    row = await file_support_request(
        source=SOURCE_AGENT_MCP,
        directus_user_id=ctx.directus_user_id,
        app_user_id=ctx.app_user_id,
        workspace_id=workspace_id,
        project_id=project_id,
        message=body,
        page_context={
            "source": SOURCE_AGENT_MCP,
            "kind": "issue",
            "client_name": ctx.client_name,
            "client_id": ctx.client_id,
            "grant_id": ctx.grant_id,
            "conversation_id": conversation_id,
            "org_id": org_id,
        },
    )
    return TicketOut(id=str(row.get("id") or ""), status="new", kind="issue")


async def request_tool(
    ctx: AgentContext,
    name: str,
    description: str,
    example: Optional[str] = None,
    project_id: Optional[str] = None,
) -> TicketOut:
    """An agent asks for a tool that does not exist. Filed as a capability
    gap in agent_insight, the same channel the in-app assistant uses for
    what a host could not do, so one review surface covers both."""
    from dembrane.agent_insights import SOURCE_AGENT_MCP, file_agent_insight

    if not (name or "").strip() or not (description or "").strip():
        raise HTTPException(status_code=400, detail="name and description are required")
    workspace_id: Optional[str] = None
    if project_id:
        access, _org = await _project_access(ctx, project_id)
        workspace_id = access.workspace_id
    content = f"[{ctx.client_name} via MCP] {_clip(description)}"
    if example:
        content += f"\nExample: {_clip(example, 1000)}"
    row = await file_agent_insight(
        source=SOURCE_AGENT_MCP,
        kind="capability_gap",
        content=content,
        suggested_capability=name.strip()[:120],
        workspace_id=workspace_id,
        project_id=project_id,
    )
    return TicketOut(id=str(row.get("id") or ""), status="new", kind="tool_request")


# ── documentation ──────────────────────────────────────────────────────────


class DocReadOut(BaseModel):
    path: str
    text: str


class DocHitOut(BaseModel):
    path: str
    title: str
    # Absent on the page index (no pattern), set on a grep hit.
    line: Optional[int] = None
    text: Optional[str] = None


class DocSearchOut(BaseModel):
    pattern: Optional[str] = None
    results: list[DocHitOut] = []


async def read_doc(ctx: AgentContext, path: str, offset: int = 1, limit: int = 400) -> DocReadOut:  # noqa: ARG001 — same signature as every tool
    from dembrane import knowledge

    return DocReadOut(path=path, text=await knowledge.read_doc(path, offset=offset, limit=limit))


async def search_docs(
    ctx: AgentContext,  # noqa: ARG001 — same signature as every tool
    pattern: Optional[str] = None,
    max_results: int = 50,
) -> DocSearchOut:
    """With a pattern, the matching lines with their page and line number.
    Without one, the page index: every path with its title."""
    from dembrane import knowledge

    pages = await knowledge.list_docs()
    if not (pattern or "").strip():
        return DocSearchOut(
            pattern=None,
            results=[DocHitOut(path=p["path"], title=p["title"]) for p in pages],
        )
    titles = {p["path"]: p["title"] for p in pages}
    hits = await knowledge.grep_docs(str(pattern), max_results=max_results)
    return DocSearchOut(
        pattern=pattern,
        results=[
            DocHitOut(
                path=str(h["path"]),
                title=titles.get(str(h["path"]), str(h["path"])),
                line=int(h["line"]),
                text=str(h["text"]),
            )
            for h in hits
        ],
    )
