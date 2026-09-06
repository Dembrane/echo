"""The MCP server itself: one tool per function in `tools`, mounted inside
the FastAPI app so it shares the process, the settings and the access code.

Auth is the bearer access token from `oauth`. The SDK's middleware verifies
it and parks it in a context variable; each tool reads it back, builds the
AgentContext, runs, and records the audit row. Stateless HTTP with JSON
responses, so any API replica can answer any call.

Every tool is named `dembrane_<verb>_<noun>` so it stays recognisable next
to other servers' tools, answers with one JSON object, and carries MCP
annotations. Answers are capped at MAX_RESULT_CHARS: a long list is cut to
the prefix that fits and the answer says so, never silently.
"""

from __future__ import annotations

import json
from typing import Any, Optional
from logging import getLogger
from contextlib import asynccontextmanager
from collections.abc import Callable, Awaitable, AsyncIterator

from fastapi import HTTPException
from pydantic import AnyHttpUrl
from mcp.types import ToolAnnotations
from starlette.routing import Route
from mcp.server.mcpserver import MCPServer
from mcp.server.auth.routes import (
    create_auth_routes,
    create_protected_resource_routes,
)
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.streamable_http_manager import StreamableHTTPASGIApp, StreamableHTTPSessionManager
from starlette.middleware.authentication import AuthenticationMiddleware
from mcp.server.auth.middleware.bearer_auth import (
    BearerAuthBackend,
    RequireAuthMiddleware,
)
from mcp.server.auth.middleware.auth_context import (
    AuthContextMiddleware,
    get_access_token,
)

from dembrane.settings import get_settings
from dembrane.agent_access import SCOPE_READ, USER_SERVER, tools as T
from dembrane.agent_access.oauth import (
    MCP_PATH,
    AgentAccessToken,
    AgentOAuthProvider,
    issuer_url,
    resource_url,
    auth_settings,
)
from dembrane.agent_access.context import AgentContext, context_from_access_token

logger = getLogger("agent_access.mcp")

provider = AgentOAuthProvider()

# About 15k tokens. Above this an answer is cut, with a note, never dropped.
MAX_RESULT_CHARS = 60_000

# Every tool touches dembrane data only, hence open_world False throughout.
READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
WRITE = ToolAnnotations(
    read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False
)


class DembraneMCPServer(MCPServer):
    """Records the tools agents reach for and do not find. The SDK rejects an
    unknown name before any tool code runs, so this is the only place to see
    it; the audit row is the signal behind the tool roadmap."""

    async def call_tool(self, name: str, arguments: dict[str, Any], context: Any = None) -> Any:
        known = sorted(t.name for t in self._tool_manager.list_tools())
        if name not in known:
            try:
                ctx = await _ctx()
                await ctx.record(
                    "unknown_tool",
                    {"requested": name, "arguments": sorted(arguments or {})},
                    org_id=None,
                    status="denied",
                )
            except Exception:  # noqa: BLE001 — logging must not change the answer
                logger.warning("unknown tool %s requested, audit skipped", name)
            raise ToolError(
                f"Unknown tool: {name}. Available: {', '.join(known)}. "
                "Call dembrane_list_tools for what each one does, or "
                "dembrane_request_tool if none of them fits what you needed."
            )
        return await super().call_tool(name, arguments, context)


server = DembraneMCPServer(
    name="dembrane",
    instructions=(
        "You are connected to dembrane as one person, limited to the organisations they "
        "chose: you see what they see and nothing more. Start with dembrane_whoami; it names "
        "the person, the scopes, and every organisation and workspace you can reach. Then "
        "dembrane_find_projects with part of a project's name to get a project_id. To learn "
        "what was said, call dembrane_search_transcripts on the project, then "
        "dembrane_read_transcript on the conversations that matter, paging with offset; "
        "dembrane_grep_conversation finds exact wording in one conversation. "
        "dembrane_list_conversations is the roster of a project (who, when, how long) and "
        "dembrane_get_conversation the metadata of one; neither returns transcript text. "
        "Every id is a UUID; pass ids between tools verbatim. Answers are capped at about "
        "15k tokens: a truncated answer says so and how to page or narrow. For how dembrane "
        "itself works, dembrane_search_docs then dembrane_read_doc. If something looks "
        "wrong, dembrane_report_issue; if you need a tool that does not exist, "
        "dembrane_request_tool; if a name you remember is rejected, dembrane_list_tools."
    ),
    auth_server_provider=provider,
    auth=auth_settings(),
)


async def _ctx() -> AgentContext:
    token = get_access_token()
    if not isinstance(token, AgentAccessToken):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return await context_from_access_token(token)


def _size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, default=str))


def fit(result: dict[str, Any]) -> dict[str, Any]:
    """Keep one answer under MAX_RESULT_CHARS.

    The bulk of every answer is one list (chunks, conversations, projects,
    results). When the whole is over the cap, that list is cut to the prefix
    that fits, `truncated` is set, `has_more` is set where the tool pages,
    and `note` says how to continue. At least one item is always kept, and an
    answer with no list to cut goes out whole: over budget beats silently
    short.
    """
    if _size(result) <= MAX_RESULT_CHARS:
        return result
    lists = {k: v for k, v in result.items() if isinstance(v, list) and v}
    if not lists:
        return result
    key = max(lists, key=lambda k: _size(lists[k]))
    items = lists[key]
    shell = {**result, key: [], "truncated": True, "has_more": True, "note": " " * 300}
    room = MAX_RESULT_CHARS - _size(shell)
    kept: list[Any] = []
    used = 0
    for item in items:
        size = _size(item) + 2
        if kept and used + size > room:
            break
        kept.append(item)
        used += size
    note = (
        f"Truncated: {len(kept)} of {len(items)} {key} shown because the full answer was "
        f"over the {MAX_RESULT_CHARS:,}-character cap. "
    )
    if "offset" in result:
        note += (
            f"Call again with offset={int(result.get('offset') or 0) + len(kept)} for the "
            "rest, or pass a smaller limit."
        )
    else:
        note += "Pass a smaller limit or a narrower query."
    out = {**result, key: kept, "truncated": True, "note": note}
    if "has_more" in result:
        out["has_more"] = True
    return out


async def _run(
    tool: str,
    params: dict[str, Any],
    fn: Callable[[AgentContext], Awaitable[Any]],
    *,
    org_id: Optional[str] = None,
) -> dict[str, Any]:
    """Run one tool with audit. HTTP-style errors become tool errors the
    agent can read; the status is recorded either way. The result is
    serialised and fitted under the cap here, so no tool has to."""
    ctx = await _ctx()
    status = "ok"
    try:
        result = await fn(ctx)
    except HTTPException as exc:
        status = (
            "limited"
            if exc.status_code == 429
            else "denied"
            if exc.status_code in (401, 403, 404)
            else "error"
        )
        await ctx.record(tool, params, org_id=org_id, status=status)
        raise ToolError(f"{exc.status_code}: {exc.detail}") from None
    except Exception:
        await ctx.record(tool, params, org_id=org_id, status="error")
        raise
    await ctx.record(tool, params, org_id=org_id, status=status)
    return fit(result.model_dump())


# ── identity and discovery ─────────────────────────────────────────────────


@server.tool(
    name="dembrane_whoami",
    description=(
        "Who you are acting as and everywhere this grant can reach. Returns the person's "
        "name and email, the granted scopes, the server build version, and every "
        "organisation in the grant with your role there and its workspaces (id, name, "
        "role, tier). Call this first in a session. An organisation with "
        "agent_access_enabled false is named but its workspaces are hidden and every call "
        "into it fails until an admin switches access back on. Costs nothing against the "
        "free-tier budget."
    ),
    annotations=READ,
)
async def dembrane_whoami() -> dict[str, Any]:
    return await _run("dembrane_whoami", {}, T.whoami)


@server.tool(
    name="dembrane_find_projects",
    description=(
        "Find projects by name across every workspace this grant can reach. Returns each "
        "project's id and name with its workspace and organisation names, most recently "
        "updated first. Leave query empty for the most recent projects; pass workspace_id "
        "to look in one workspace only. Use this to get a project_id before any project "
        "tool: there is no separate workspace or project listing. Matching is "
        "case-insensitive on the name and every word must match. At most 200 results; "
        "costs nothing against the free-tier budget."
    ),
    annotations=READ,
)
async def dembrane_find_projects(
    query: Optional[str] = None, workspace_id: Optional[str] = None, limit: int = 50
) -> dict[str, Any]:
    return await _run(
        "dembrane_find_projects",
        {"query": (query or "")[:200], "workspace_id": workspace_id, "limit": limit},
        lambda c: T.find_projects(c, query=query, workspace_id=workspace_id, limit=limit),
    )


# ── projects ───────────────────────────────────────────────────────────────


@server.tool(
    name="dembrane_get_project",
    description=(
        "One project's settings: name, language, context, whether new conversations are "
        "allowed, and its workspace and organisation names. Use it when you need the "
        "project's configuration. For its conversations call dembrane_list_conversations; "
        "for what was said in them call dembrane_search_transcripts."
    ),
    annotations=READ,
)
async def dembrane_get_project(project_id: str) -> dict[str, Any]:
    return await _run(
        "dembrane_get_project",
        {"project_id": project_id},
        lambda c: T.get_project(c, project_id),
    )


@server.tool(
    name="dembrane_update_project",
    description=(
        "Change a project's settings. Needs the write scope, and the person you act as "
        "must be allowed to edit the project. Only the fields you pass are changed; pass "
        "at least one. Fields: name, context (the description hosts and participants "
        "see), language, is_conversation_allowed, default_conversation_title, "
        "default_conversation_description, default_conversation_finish_text. Returns the "
        "project as dembrane_get_project would."
    ),
    annotations=WRITE,
)
async def dembrane_update_project(
    project_id: str,
    name: Optional[str] = None,
    context: Optional[str] = None,
    language: Optional[str] = None,
    is_conversation_allowed: Optional[bool] = None,
    default_conversation_title: Optional[str] = None,
    default_conversation_description: Optional[str] = None,
    default_conversation_finish_text: Optional[str] = None,
) -> dict[str, Any]:
    fields = {
        k: v
        for k, v in {
            "name": name,
            "context": context,
            "language": language,
            "is_conversation_allowed": is_conversation_allowed,
            "default_conversation_title": default_conversation_title,
            "default_conversation_description": default_conversation_description,
            "default_conversation_finish_text": default_conversation_finish_text,
        }.items()
        if v is not None
    }
    body = T.ProjectUpdateIn.model_validate(fields)
    return await _run(
        "dembrane_update_project",
        {"project_id": project_id, "fields": sorted(fields)},
        lambda c: T.update_project(c, project_id, body),
    )


@server.tool(
    name="dembrane_list_project_webhooks",
    description=(
        "The webhooks configured on a project: id, name, URL, events and status, never "
        "the secret. Needs the workspace:webhooks permission, which most people do not "
        "have, so expect 404 unless you act as a workspace admin on a plan with webhooks."
    ),
    annotations=READ,
)
async def dembrane_list_project_webhooks(project_id: str) -> dict[str, Any]:
    return await _run(
        "dembrane_list_project_webhooks",
        {"project_id": project_id},
        lambda c: T.list_project_webhooks(c, project_id),
    )


# ── conversations ──────────────────────────────────────────────────────────


@server.tool(
    name="dembrane_list_conversations",
    description=(
        "A page of a project's conversations, newest first by default, without "
        "transcripts. Concise (the default) returns id, participant_name, title, "
        "created_at, duration in seconds and status (live, processing or done); "
        "format=detailed adds the summary, tags and whether the conversation is locked. "
        "search matches participant name, email, title and summary; created_after and "
        "created_before are ISO 8601 bounds; sort is one of -created_at, created_at, "
        "-updated_at, updated_at, -duration, duration. Page with offset while has_more is "
        "true; limit is at most 500. To find conversations by what was said inside them "
        "use dembrane_search_transcripts instead."
    ),
    annotations=READ,
)
async def dembrane_list_conversations(
    project_id: str,
    search: Optional[str] = None,
    created_after: Optional[str] = None,
    created_before: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    sort: T.ConversationSort = "-created_at",
    format: T.ResultFormat = "concise",
) -> dict[str, Any]:
    return await _run(
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
        lambda c: T.list_conversations(
            c,
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


@server.tool(
    name="dembrane_search_transcripts",
    description=(
        "Find the conversations in a project whose transcript contains the words in "
        "query, with up to 3 snippets each. Returns the words actually searched (tokens), "
        "the matching conversations with the most recent speech first, and has_more for "
        "paging with offset. Words shorter than 4 letters are dropped and at most 4 "
        "distinct words are used, any one of them matching; two to four specific words "
        "work best. Use this to locate where a topic came up, then "
        "dembrane_read_transcript on the conversations that matter. A locked conversation "
        "appears without snippets. At most 100 per page."
    ),
    annotations=READ,
)
async def dembrane_search_transcripts(
    project_id: str, query: str, limit: int = 20, offset: int = 0
) -> dict[str, Any]:
    return await _run(
        "dembrane_search_transcripts",
        {"project_id": project_id, "query": query[:200], "limit": limit, "offset": offset},
        lambda c: T.search_transcripts(c, project_id, query, limit=limit, offset=offset),
    )


@server.tool(
    name="dembrane_grep_conversation",
    description=(
        "Snippets from one conversation's transcript around the words in query, in "
        "speaking order, each with its chunk id and timestamp. Use it to check exact "
        "wording or to find where in a long conversation something was said; to search a "
        "whole project use dembrane_search_transcripts. Words shorter than 4 letters are "
        "dropped. At most 50 matches. A locked conversation returns no matches."
    ),
    annotations=READ,
)
async def dembrane_grep_conversation(
    conversation_id: str, query: str, max_matches: int = 10
) -> dict[str, Any]:
    return await _run(
        "dembrane_grep_conversation",
        {"conversation_id": conversation_id, "query": query[:200], "max_matches": max_matches},
        lambda c: T.grep_conversation(c, conversation_id, query, max_matches=max_matches),
    )


@server.tool(
    name="dembrane_read_transcript",
    description=(
        "One conversation's transcript as a page of chunks in speaking order. Each chunk "
        "has a timestamp and its text; format=detailed adds the chunk id. offset and "
        "limit count chunks, limit at most 200; total and has_more say when to page. This "
        "is the only way to read what was said: take one page at a time and page while "
        "has_more is true rather than asking for everything at once. A locked "
        "conversation returns its chunks without text and transcript_locked true; that is "
        "the workspace's plan cap, not an error. For metadata only, "
        "dembrane_get_conversation."
    ),
    annotations=READ,
)
async def dembrane_read_transcript(
    conversation_id: str,
    offset: int = 0,
    limit: int = 50,
    format: T.ResultFormat = "concise",
) -> dict[str, Any]:
    return await _run(
        "dembrane_read_transcript",
        {"conversation_id": conversation_id, "offset": offset, "limit": limit, "format": format},
        lambda c: T.read_transcript(c, conversation_id, offset=offset, limit=limit, format=format),
    )


@server.tool(
    name="dembrane_get_conversation",
    description=(
        "One conversation's metadata: participant, title, summary, tags, status, "
        "duration, chunk count and whether it is locked. Never the transcript: call "
        "dembrane_read_transcript for the text. Use this to check what a conversation is "
        "about before reading it, or to fetch its summary and tags."
    ),
    annotations=READ,
)
async def dembrane_get_conversation(conversation_id: str) -> dict[str, Any]:
    return await _run(
        "dembrane_get_conversation",
        {"conversation_id": conversation_id},
        lambda c: T.get_conversation(c, conversation_id),
    )


# ── reporting back to dembrane ─────────────────────────────────────────────


@server.tool(
    name="dembrane_report_issue",
    description=(
        "Tell the dembrane team something is wrong: a transcript that looks broken, a "
        "tool that errored, data that does not add up. Files a support ticket in the "
        "person's name and returns its id. Name the project_id or conversation_id when "
        "you have one so the team can look. Not for missing features: that is "
        "dembrane_request_tool."
    ),
    annotations=WRITE,
)
async def dembrane_report_issue(
    message: str, project_id: Optional[str] = None, conversation_id: Optional[str] = None
) -> dict[str, Any]:
    return await _run(
        "dembrane_report_issue",
        {
            "project_id": project_id,
            "conversation_id": conversation_id,
            "chars": len(message or ""),
        },
        lambda c: T.report_issue(
            c, message, project_id=project_id, conversation_id=conversation_id
        ),
    )


@server.tool(
    name="dembrane_request_tool",
    description=(
        "Ask the dembrane team for a tool that does not exist yet. Give it a short name, "
        "describe in plain words what you were trying to do, and give one example call "
        "you wish had worked. Files the request and returns its id. Use it when no listed "
        "tool fits; for something broken use dembrane_report_issue."
    ),
    annotations=WRITE,
)
async def dembrane_request_tool(
    name: str, description: str, example: Optional[str] = None
) -> dict[str, Any]:
    return await _run(
        "dembrane_request_tool",
        {"name": name, "chars": len(description or "")},
        lambda c: T.request_tool(c, name, description, example=example),
    )


# ── documentation ──────────────────────────────────────────────────────────


@server.tool(
    name="dembrane_read_doc",
    description=(
        "Read one page of the dembrane user documentation by path, line-numbered. Returns "
        "up to 400 lines from offset (1-based); the text ends with the next offset when "
        "there is more. Get paths from dembrane_search_docs. Public content about how "
        "dembrane works for hosts and participants, not about the person's data."
    ),
    annotations=READ,
)
async def dembrane_read_doc(path: str, offset: int = 1, limit: int = 400) -> dict[str, Any]:
    return await _run(
        "dembrane_read_doc",
        {"path": path, "offset": offset, "limit": limit},
        lambda c: T.read_doc(c, path, offset=offset, limit=limit),
    )


@server.tool(
    name="dembrane_search_docs",
    description=(
        "Search the dembrane user documentation, or list it. With pattern (a "
        "case-insensitive regular expression) returns the matching lines with their page "
        "path, title and line number, at most 50. Without pattern returns the page index: "
        "every path with its title. Use it for questions about how dembrane works "
        "(projects, conversations, participant links, plans), then dembrane_read_doc on "
        "a page. It does not search the person's conversations: that is "
        "dembrane_search_transcripts."
    ),
    annotations=READ,
)
async def dembrane_search_docs(
    pattern: Optional[str] = None, max_results: int = 50
) -> dict[str, Any]:
    return await _run(
        "dembrane_search_docs",
        {"pattern": (pattern or "")[:200], "max_results": max_results},
        lambda c: T.search_docs(c, pattern, max_results=max_results),
    )


# ── the catalogue ──────────────────────────────────────────────────────────


def _one_line(description: Optional[str]) -> str:
    text = " ".join((description or "").split())
    head, sep, _rest = text.partition(". ")
    return head + ("." if sep else "")


async def catalogue(ctx: AgentContext) -> T.ToolCatalogue:  # noqa: ARG001 — same signature as every tool
    """Every registered tool with its one-line description and read-only
    flag, plus the build version, for an agent that connected before the
    set changed. Shared with the REST face."""
    return T.ToolCatalogue(
        build_version=get_settings().build.build_version,
        tools=[
            T.ToolInfo(
                name=t.name,
                description=_one_line(t.description),
                read_only=bool(t.annotations and t.annotations.read_only_hint),
            )
            for t in sorted(server._tool_manager.list_tools(), key=lambda t: t.name)
        ],
    )


@server.tool(
    name="dembrane_list_tools",
    description=(
        "Every tool on this server with a one-line description, whether it is read-only, "
        "and the server build version. Call it when a tool name you remember is rejected "
        "or when you reconnect after a long session: the set changes between builds. "
        "Same names as tools/list."
    ),
    annotations=READ,
)
async def dembrane_list_tools() -> dict[str, Any]:
    return await _run("dembrane_list_tools", {}, catalogue)


# ── mounting into FastAPI ──────────────────────────────────────────────────

_session_manager: Optional[StreamableHTTPSessionManager] = None


def _manager() -> StreamableHTTPSessionManager:
    global _session_manager
    if _session_manager is None:
        _session_manager = StreamableHTTPSessionManager(
            app=server._lowlevel_server,
            json_response=True,
            stateless=True,
            security_settings=None,
        )
    return _session_manager


@asynccontextmanager
async def lifespan() -> AsyncIterator[None]:
    """Run inside the FastAPI lifespan so the session manager's task group
    lives as long as the app."""
    async with _manager().run():
        yield


def routes() -> list[Route]:
    """Everything the MCP surface needs, ready for `app.router.routes.extend`.

    Issuer is `<api>/api/mcp`, so the OAuth endpoints sit under it
    (/api/mcp/authorize, /token, /register, /revoke) and the two metadata
    documents are served at the host root paths RFC 8414 and RFC 9728
    prescribe for a path-bearing issuer, plus the path-relative form for
    clients that look there first.
    """
    settings = auth_settings()
    auth_routes = create_auth_routes(
        provider=provider,
        issuer_url=settings.issuer_url,
        client_registration_options=settings.client_registration_options,
        revocation_options=settings.revocation_options,
    )
    metadata_route = next(r for r in auth_routes if r.path.startswith("/.well-known/"))
    endpoint_routes = [r for r in auth_routes if not r.path.startswith("/.well-known/")]

    asgi = RequireAuthMiddleware(
        StreamableHTTPASGIApp(_manager()),
        required_scopes=[SCOPE_READ],
        resource_metadata_url=AnyHttpUrl(
            str(settings.resource_server_url).rstrip("/").replace(MCP_PATH, "")
            + "/.well-known/oauth-protected-resource"
            + MCP_PATH
        ),
    )
    protected = AuthContextMiddleware(asgi)
    authenticated = AuthenticationMiddleware(protected, backend=BearerAuthBackend(provider))

    prefixed = [
        Route(MCP_PATH + r.path, endpoint=r.endpoint, methods=list(r.methods or []))
        for r in endpoint_routes
    ]
    return [
        # The MCP endpoint itself. A flat route, not a Mount, so `/api/mcp`
        # answers directly and no client is bounced through a slash redirect.
        Route(MCP_PATH, endpoint=authenticated, methods=["GET", "POST", "DELETE"]),
        # RFC 8414 root form for a path-bearing issuer, plus the path-relative
        # form some clients try first.
        Route(
            "/.well-known/oauth-authorization-server" + MCP_PATH,
            endpoint=metadata_route.endpoint,
            methods=["GET", "OPTIONS"],
        ),
        Route(
            MCP_PATH + "/.well-known/oauth-authorization-server",
            endpoint=metadata_route.endpoint,
            methods=["GET", "OPTIONS"],
        ),
        *create_protected_resource_routes(
            resource_url=AnyHttpUrl(resource_url()),
            authorization_servers=[AnyHttpUrl(issuer_url())],
            scopes_supported=[SCOPE_READ, "write"],
            resource_name=USER_SERVER.name,
        ),
        *prefixed,
    ]
