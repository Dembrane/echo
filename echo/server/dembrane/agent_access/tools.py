"""The tools an agent can call, as plain async functions over an AgentContext.

Both the REST router (`api/v2/agent.py`) and the MCP server call these. Each
one resolves access through the same helpers the dashboard uses, then narrows
to the organisations in the grant. Nothing here re-implements a permission.

Output shapes are deliberately small and stable: an agent should get the ids,
names and text it needs, not raw Directus rows.
"""

from __future__ import annotations

import json
from typing import Any, Literal, Optional

from fastapi import HTTPException
from pydantic import BaseModel

from dembrane.free_tier import workspace_over_cap_active
from dembrane.directus_async import async_directus
from dembrane.api.v2.bff._access import (
    resolve_project_access,
    resolve_conversation_access,
)
from dembrane.agent_access.context import AgentContext
from dembrane.api.v2.bff.conversations import (
    _enrich_conversation,
    _scrub_chunk_transcript,
)

BATCH_MAX = 50
ConversationSort = Literal["-created_at", "created_at", "-duration", "duration"]


# ── output models ──────────────────────────────────────────────────────────


class Whoami(BaseModel):
    app_user_id: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    scopes: list[str]
    organisation_ids: list[str]
    grant_id: str


class OrganisationOut(BaseModel):
    id: str
    name: str
    role: str
    agent_access_enabled: bool


class WorkspaceOut(BaseModel):
    id: str
    name: str
    organisation_id: str
    role: Optional[str] = None
    tier: Optional[str] = None


class ProjectOut(BaseModel):
    id: str
    name: str
    workspace_id: Optional[str] = None
    organisation_id: Optional[str] = None
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


class ConversationSummaryOut(BaseModel):
    id: str
    project_id: str
    title: Optional[str] = None
    participant_name: Optional[str] = None
    summary: Optional[str] = None
    source: Optional[str] = None
    duration: Optional[float] = None
    is_finished: Optional[bool] = None
    locked: bool = False
    created_at: Optional[str] = None


class ConversationOut(ConversationSummaryOut):
    transcript: Optional[str] = None
    transcript_locked: bool = False
    chunk_count: int = 0
    tags: list[str] = []


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


# ── helpers ────────────────────────────────────────────────────────────────


def _s(value: Any) -> Optional[str]:
    return None if value is None else str(value)


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


async def _project_access(ctx: AgentContext, project_id: str) -> Any:
    """Resolve project access as the user, then confirm its org is in the
    grant and switched on. 404 either way, so an agent cannot probe."""
    access = await resolve_project_access(project_id, ctx.session)
    org_id = access.org_id
    if not org_id and access.workspace_id:
        ws = await async_directus.get_item("workspace", access.workspace_id)
        org_id = ws.get("org_id") if isinstance(ws, dict) else None
    await ctx.require_org(org_id)
    await ctx.charge(str(org_id))
    return access, str(org_id)


def _project_out(row: dict[str, Any], org_id: Optional[str]) -> ProjectOut:
    return ProjectOut(
        id=str(row["id"]),
        name=str(row.get("name") or ""),
        workspace_id=_s(row.get("workspace_id")),
        organisation_id=org_id,
        language=_s(row.get("language")),
        context=_s(row.get("context")),
        is_conversation_allowed=row.get("is_conversation_allowed"),
        created_at=_s(row.get("created_at")),
        updated_at=_s(row.get("updated_at")),
    )


def _conversation_summary(row: dict[str, Any]) -> ConversationSummaryOut:
    return ConversationSummaryOut(
        id=str(row["id"]),
        project_id=str(row.get("project_id")),
        title=_s(row.get("title")),
        participant_name=_s(row.get("participant_name")),
        summary=_s(row.get("summary")),
        source=_s(row.get("source")),
        duration=row.get("duration"),
        is_finished=row.get("is_finished"),
        locked=bool(row.get("locked")),
        created_at=_s(row.get("created_at")),
    )


# ── tools ──────────────────────────────────────────────────────────────────


async def whoami(ctx: AgentContext) -> Whoami:
    user = await async_directus.get_item("app_user", ctx.app_user_id)
    row = user if isinstance(user, dict) else {}
    return Whoami(
        app_user_id=ctx.app_user_id,
        email=_s(row.get("email")),
        display_name=_s(row.get("display_name")),
        scopes=ctx.scopes,
        organisation_ids=ctx.org_ids,
        grant_id=ctx.grant_id,
    )


async def list_organisations(ctx: AgentContext) -> list[OrganisationOut]:
    from dembrane.agent_access.context import org_agent_access_enabled

    if not ctx.org_ids:
        return []
    orgs = await async_directus.get_items(
        "org",
        {
            "query": {
                "filter": {"id": {"_in": ctx.org_ids}, "deleted_at": {"_null": True}},
                "fields": ["id", "name", "agent_access_enabled"],
                "limit": -1,
            }
        },
    )
    from dembrane.agent_access.context import guest_org_ids

    guest_orgs = set(await guest_org_ids(ctx.app_user_id))
    out: list[OrganisationOut] = []
    for org in orgs if isinstance(orgs, list) else []:
        role = await _org_role(str(org["id"]), ctx.app_user_id)
        if not role and str(org["id"]) in guest_orgs:
            role = "guest"
        if not role:
            continue
        out.append(
            OrganisationOut(
                id=str(org["id"]),
                name=str(org.get("name") or ""),
                role=role,
                agent_access_enabled=await org_agent_access_enabled(str(org["id"])),
            )
        )
    return out


async def list_workspaces(ctx: AgentContext, organisation_id: str) -> list[WorkspaceOut]:
    from dembrane.inheritance import resolve_workspace_access
    from dembrane.billing_account import nested_billing_fields, billing_from_workspace

    await ctx.require_org(organisation_id)
    await ctx.charge(organisation_id)
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
    for ws in rows if isinstance(rows, list) else []:
        resolved = await resolve_workspace_access(ws, ctx.app_user_id)
        if resolved is None:
            continue
        role, _source, _membership = resolved
        out.append(
            WorkspaceOut(
                id=str(ws["id"]),
                name=str(ws.get("name") or ""),
                organisation_id=organisation_id,
                role=_s(role),
                tier=_s(billing_from_workspace(ws).get("tier")),
            )
        )
    return out


async def list_projects(
    ctx: AgentContext, workspace_id: str, search: Optional[str] = None, limit: int = 50
) -> list[ProjectOut]:
    from dembrane.api.v2.middleware import get_workspace_context
    from dembrane.api.v2.workspace_projects import (
        _shared_private_project_ids,
        _visibility_filter_for_caller,
    )

    wctx = await get_workspace_context(workspace_id, ctx.session)
    org_id = await ctx.require_org(_s(wctx.workspace.get("org_id")))
    await ctx.charge(org_id)
    wctx.require_policy("project:read")

    shared_ids = await _shared_private_project_ids(ctx.app_user_id)
    visibility = _visibility_filter_for_caller(
        caller_role=wctx.role, shared_ids=shared_ids, creator_directus_id=ctx.directus_user_id
    )
    flt: dict[str, Any] = {"workspace_id": {"_eq": workspace_id}, "deleted_at": {"_null": True}}
    if visibility is not None:
        flt = {**flt, **visibility}
    if search and search.strip():
        flt = {"_and": [flt, {"name": {"_icontains": search.strip()}}]}
    rows = await async_directus.get_items(
        "project",
        {
            "query": {
                "filter": flt,
                "fields": [
                    "id",
                    "name",
                    "workspace_id",
                    "language",
                    "context",
                    "is_conversation_allowed",
                    "created_at",
                    "updated_at",
                ],
                "sort": ["-updated_at"],
                "limit": max(1, min(limit, 200)),
            }
        },
    )
    return [_project_out(r, org_id) for r in (rows if isinstance(rows, list) else [])]


async def get_project(ctx: AgentContext, project_id: str) -> ProjectOut:
    access, org_id = await _project_access(ctx, project_id)
    return _project_out(access.project, org_id)


async def update_project(ctx: AgentContext, project_id: str, body: ProjectUpdateIn) -> ProjectOut:
    ctx.require_write()
    access, org_id = await _project_access(ctx, project_id)
    access.require("project:update")
    payload = body.model_dump(exclude_unset=True)
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")
    updated = await async_directus.update_item("project", project_id, payload)
    row = updated.get("data") if isinstance(updated, dict) and "data" in updated else updated
    return _project_out(row if isinstance(row, dict) else {**access.project, **payload}, org_id)


async def list_conversations(
    ctx: AgentContext,
    project_id: str,
    search: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    sort: ConversationSort = "-created_at",
) -> list[ConversationSummaryOut]:
    from dembrane.search_filters import merge_search_filter
    from dembrane.api.v2.bff.conversations import _CONVERSATION_SEARCH_FIELDS

    access, _org_id = await _project_access(ctx, project_id)
    access.require("conversation:read")
    over_cap = await workspace_over_cap_active(access.workspace_id, access.tier)
    flt: dict[str, Any] = {"project_id": {"_eq": project_id}, "deleted_at": {"_null": True}}
    if search and search.strip():
        flt = merge_search_filter(flt, search.strip(), _CONVERSATION_SEARCH_FIELDS)
    rows = await async_directus.get_items(
        "conversation",
        {
            "query": {
                "filter": flt,
                "fields": [
                    "id",
                    "project_id",
                    "title",
                    "participant_name",
                    "summary",
                    "source",
                    "duration",
                    "is_finished",
                    "is_over_cap",
                    "created_at",
                ],
                "sort": [sort],
                "limit": max(1, min(limit, 500)),
                "offset": max(0, offset),
            }
        },
    )
    out: list[ConversationSummaryOut] = []
    for row in rows if isinstance(rows, list) else []:
        _enrich_conversation(row, access.tier, over_cap)
        out.append(_conversation_summary(row))
    return out


async def _conversation_detail(
    ctx: AgentContext, conversation_id: str
) -> tuple[ConversationOut, str]:
    access, conv = await resolve_conversation_access(conversation_id, ctx.session)
    org_id = access.org_id
    if not org_id and access.workspace_id:
        ws = await async_directus.get_item("workspace", access.workspace_id)
        org_id = ws.get("org_id") if isinstance(ws, dict) else None
    org = await ctx.require_org(org_id)
    over_cap = await workspace_over_cap_active(access.workspace_id, access.tier)
    _enrich_conversation(conv, access.tier, over_cap)
    locked = bool(conv.get("locked"))

    chunks = await async_directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "fields": ["id", "transcript", "timestamp"],
                "sort": ["timestamp"],
                "limit": -1,
            }
        },
    )
    chunk_list = chunks if isinstance(chunks, list) else []
    if locked:
        for ch in chunk_list:
            _scrub_chunk_transcript(ch)
    texts = [str(c.get("transcript")) for c in chunk_list if c.get("transcript")]

    tag_rows = await async_directus.get_items(
        "conversation_project_tag",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "fields": ["project_tag_id.text"],
                "limit": -1,
            }
        },
    )
    tags: list[str] = []
    for t in tag_rows if isinstance(tag_rows, list) else []:
        pt = t.get("project_tag_id")
        if isinstance(pt, dict) and pt.get("text"):
            tags.append(str(pt["text"]))

    base = _conversation_summary(conv)
    detail = ConversationOut(
        **base.model_dump(),
        transcript=None if locked else ("\n".join(texts) or None),
        transcript_locked=locked,
        chunk_count=len(chunk_list),
        tags=tags,
    )
    return detail, org


async def get_conversation(ctx: AgentContext, conversation_id: str) -> ConversationOut:
    detail, org_id = await _conversation_detail(ctx, conversation_id)
    await ctx.charge(org_id)
    return detail


async def get_conversations(
    ctx: AgentContext, conversation_ids: list[str]
) -> list[ConversationOut]:
    ids = [str(i) for i in conversation_ids if i]
    if not ids:
        return []
    if len(ids) > BATCH_MAX:
        raise HTTPException(status_code=400, detail=f"Too many conversation ids (max {BATCH_MAX})")
    out: list[ConversationOut] = []
    charged: set[str] = set()
    for cid in ids:
        try:
            detail, org_id = await _conversation_detail(ctx, cid)
        except HTTPException as exc:
            if exc.status_code == 404:
                continue
            raise
        out.append(detail)
        # One charge per organisation per batch, not per conversation.
        if org_id not in charged:
            charged.add(org_id)
            await ctx.charge(org_id)
    return out


async def list_project_webhooks(ctx: AgentContext, project_id: str) -> list[WebhookOut]:
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
    return [
        WebhookOut(
            id=str(w["id"]),
            name=_s(w.get("name")),
            url=_s(w.get("url")),
            events=[str(e) for e in _parse_webhook_events(w.get("events"))],
            status=_s(w.get("status")),
        )
        for w in (rows if isinstance(rows, list) else [])
    ]


# ── reporting back to dembrane ─────────────────────────────────────────────

SUPPORT_SOURCE = "agent_mcp"
MAX_TICKET_CHARS = 4000


def _clip(text: str, limit: int = MAX_TICKET_CHARS) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[: limit - 1] + "…"


async def _file_support_request(
    ctx: AgentContext,
    *,
    kind: Literal["issue", "tool_request"],
    message: str,
    project_id: Optional[str] = None,
    workspace_id: Optional[str] = None,
    context: Optional[dict[str, Any]] = None,
) -> TicketOut:
    """One support_request row, source agent_mcp. The existing forwarder
    picks it up like any other row, so an agent's report lands in the same
    triage thread as a host's. Never transcript content."""
    page_context = {
        "source": SUPPORT_SOURCE,
        "kind": kind,
        "client_name": ctx.client_name,
        "client_id": ctx.client_id,
        "grant_id": ctx.grant_id,
        **(context or {}),
    }
    created = await async_directus.create_item(
        "support_request",
        {
            "directus_user_id": ctx.directus_user_id,
            "app_user_id": ctx.app_user_id,
            "workspace_id": workspace_id,
            "project_id": project_id,
            "message": message,
            "page_context": json.dumps(page_context),
            "status": "new",
            "source": SUPPORT_SOURCE,
        },
    )
    row = created.get("data") if isinstance(created, dict) and "data" in created else created
    return TicketOut(id=str((row or {}).get("id") or ""), status="new", kind=kind)


async def report_issue(
    ctx: AgentContext,
    message: str,
    project_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
) -> TicketOut:
    """An agent reports something wrong with dembrane: a bad transcript, a
    tool that errored, data that looks off. Scoped to a project when the
    agent can name one, so the team lands in the right place."""
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
    return await _file_support_request(
        ctx,
        kind="issue",
        message=body,
        project_id=project_id,
        workspace_id=workspace_id,
        context={"conversation_id": conversation_id, "org_id": org_id},
    )


async def request_tool(
    ctx: AgentContext,
    name: str,
    description: str,
    example: Optional[str] = None,
) -> TicketOut:
    """An agent asks for a tool that does not exist yet. The description is
    what it wanted to do, in its own words; that is the signal we mine."""
    if not (name or "").strip() or not (description or "").strip():
        raise HTTPException(status_code=400, detail="name and description are required")
    body = f"[{ctx.client_name} via MCP] Tool request: {_clip(name, 120)}\n{_clip(description)}"
    if example:
        body += f"\nExample: {_clip(example, 1000)}"
    return await _file_support_request(
        ctx,
        kind="tool_request",
        message=body,
        context={"tool_name": name.strip()},
    )
