"""The MCP server itself: one tool per function in `tools`, mounted inside
the FastAPI app so it shares the process, the settings and the access code.

Auth is the bearer access token from `oauth`. The SDK's middleware verifies
it and parks it in a context variable; each tool reads it back, builds the
AgentContext, runs, and records the audit row. Stateless HTTP with JSON
responses, so any API replica can answer any call.
"""

from __future__ import annotations

from typing import Any, Optional
from logging import getLogger
from contextlib import asynccontextmanager
from collections.abc import Callable, Awaitable, AsyncIterator

from fastapi import HTTPException
from pydantic import AnyHttpUrl
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
                "If you needed something else, call request_tool with what you wanted to do."
            )
        return await super().call_tool(name, arguments, context)


server = DembraneMCPServer(
    name="dembrane",
    instructions=(
        "You are connected to dembrane as one person, limited to the organisations "
        "they chose. Start with whoami. To find a project, call find_projects with "
        "part of its name; list_organisations, list_workspaces and list_projects walk "
        "the tree when you need it. To find what was said, call search_transcripts on "
        "the project, then read_transcript on the conversations that matter, paging "
        "with offset; grep_conversation finds exact wording in one conversation. "
        "Never call get_conversations for many conversations: transcripts are long. "
        "Ids are UUIDs; pass them between tools verbatim. If something looks wrong, "
        "call report_issue; if a tool you need does not exist, call request_tool. "
        "Questions about how dembrane works: search_docs, then read_doc."
    ),
    auth_server_provider=provider,
    auth=auth_settings(),
)


async def _ctx() -> AgentContext:
    token = get_access_token()
    if not isinstance(token, AgentAccessToken):
        raise HTTPException(status_code=401, detail="Not authenticated")
    return await context_from_access_token(token)


async def _run(
    tool: str,
    params: dict[str, Any],
    fn: Callable[[AgentContext], Awaitable[Any]],
    *,
    org_id: Optional[str] = None,
) -> Any:
    """Run one tool with audit. HTTP-style errors become tool errors the
    agent can read; the status is recorded either way."""
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
    return result


def _dump(model: Any) -> Any:
    if isinstance(model, list):
        return [m.model_dump() for m in model]
    return model.model_dump()


@server.tool(
    name="whoami", description="Who the agent is acting as, the granted scopes and organisations."
)
async def whoami() -> dict[str, Any]:
    return _dump(await _run("whoami", {}, T.whoami))


@server.tool(
    name="list_organisations",
    description="Organisations this grant can reach, with the user's role in each.",
)
async def list_organisations() -> list[dict[str, Any]]:
    return _dump(await _run("list_organisations", {}, T.list_organisations))


@server.tool(
    name="list_workspaces", description="Workspaces in one organisation that the user can see."
)
async def list_workspaces(organisation_id: str) -> list[dict[str, Any]]:
    return _dump(
        await _run(
            "list_workspaces",
            {"organisation_id": organisation_id},
            lambda c: T.list_workspaces(c, organisation_id),
            org_id=organisation_id,
        )
    )


@server.tool(name="list_projects", description="Projects in one workspace. Optional name search.")
async def list_projects(
    workspace_id: str, search: Optional[str] = None, limit: int = 50
) -> list[dict[str, Any]]:
    return _dump(
        await _run(
            "list_projects",
            {"workspace_id": workspace_id, "search": search, "limit": limit},
            lambda c: T.list_projects(c, workspace_id, search=search, limit=limit),
        )
    )


@server.tool(
    name="find_projects",
    description=(
        "Find projects by name across every organisation in the grant: id, name, "
        "workspace and organisation. Leave the query empty for the most recently "
        "updated ones. At most 200."
    ),
)
async def find_projects(query: Optional[str] = None, limit: int = 50) -> list[dict[str, Any]]:
    return _dump(
        await _run(
            "find_projects",
            {"query": (query or "")[:200], "limit": limit},
            lambda c: T.find_projects(c, query=query, limit=limit),
        )
    )


@server.tool(name="get_project", description="One project's settings.")
async def get_project(project_id: str) -> dict[str, Any]:
    return _dump(
        await _run(
            "get_project", {"project_id": project_id}, lambda c: T.get_project(c, project_id)
        )
    )


@server.tool(
    name="update_project",
    description="Change project settings. Needs the write scope. Only the fields you pass are changed.",
)
async def update_project(
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
    return _dump(
        await _run(
            "update_project",
            {"project_id": project_id, "fields": sorted(fields)},
            lambda c: T.update_project(c, project_id, body),
        )
    )


@server.tool(
    name="list_conversations",
    description=(
        "Conversations in a project: id, title, participant, summary, duration, status. "
        "No transcripts here. search matches participant, title and summary; "
        "created_after and created_before are ISO 8601 bounds. At most 500 per page."
    ),
)
async def list_conversations(
    project_id: str,
    search: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    sort: T.ConversationSort = "-created_at",
    created_after: Optional[str] = None,
    created_before: Optional[str] = None,
) -> list[dict[str, Any]]:
    return _dump(
        await _run(
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
            lambda c: T.list_conversations(
                c,
                project_id,
                search=search,
                limit=limit,
                offset=offset,
                sort=sort,
                created_after=created_after,
                created_before=created_before,
            ),
        )
    )


@server.tool(
    name="search_transcripts",
    description=(
        "Find the conversations in a project whose transcript contains the words in "
        "the query: two to four words of four letters or more work best, shorter words "
        "are dropped. Each hit carries up to 3 snippets with the chunk id. At most 100 "
        "per page; has_more says whether to page with offset. A locked conversation "
        "comes back without snippets."
    ),
)
async def search_transcripts(
    project_id: str, query: str, limit: int = 20, offset: int = 0
) -> dict[str, Any]:
    return _dump(
        await _run(
            "search_transcripts",
            {"project_id": project_id, "query": query[:200], "limit": limit, "offset": offset},
            lambda c: T.search_transcripts(c, project_id, query, limit=limit, offset=offset),
        )
    )


@server.tool(
    name="grep_conversation",
    description=(
        "Snippets from one conversation's transcript around the words in the query, "
        "in speaking order, each with its chunk id and timestamp. At most 50 matches. "
        "Nothing from a locked conversation."
    ),
)
async def grep_conversation(
    conversation_id: str, query: str, max_matches: int = 10
) -> list[dict[str, Any]]:
    return _dump(
        await _run(
            "grep_conversation",
            {"conversation_id": conversation_id, "query": query[:200], "max_matches": max_matches},
            lambda c: T.grep_conversation(c, conversation_id, query, max_matches=max_matches),
        )
    )


@server.tool(
    name="read_transcript",
    description=(
        "One conversation's transcript as a page of chunks in speaking order, each with "
        "id, timestamp and text. offset and limit count chunks; limit is at most 200. "
        "total and has_more say when to page. A locked conversation returns its chunks "
        "without text."
    ),
)
async def read_transcript(conversation_id: str, offset: int = 0, limit: int = 50) -> dict[str, Any]:
    return _dump(
        await _run(
            "read_transcript",
            {"conversation_id": conversation_id, "offset": offset, "limit": limit},
            lambda c: T.read_transcript(c, conversation_id, offset=offset, limit=limit),
        )
    )


@server.tool(
    name="get_conversation",
    description=(
        "One conversation with its tags and the whole transcript as one string. For "
        "anything long, or for several conversations, use read_transcript instead."
    ),
)
async def get_conversation(conversation_id: str) -> dict[str, Any]:
    return _dump(
        await _run(
            "get_conversation",
            {"conversation_id": conversation_id},
            lambda c: T.get_conversation(c, conversation_id),
        )
    )


@server.tool(
    name="get_conversations",
    description=f"Up to {T.BATCH_MAX} conversations with transcripts in one call. Unknown ids are skipped.",
)
async def get_conversations(conversation_ids: list[str]) -> list[dict[str, Any]]:
    return _dump(
        await _run(
            "get_conversations",
            {"conversation_ids": conversation_ids[: T.BATCH_MAX], "count": len(conversation_ids)},
            lambda c: T.get_conversations(c, conversation_ids),
        )
    )


@server.tool(
    name="report_issue",
    description=(
        "Report something wrong with dembrane to its team: a broken transcript, a tool "
        "that errored, data that looks off. Name the project or conversation when you can."
    ),
)
async def report_issue(
    message: str, project_id: Optional[str] = None, conversation_id: Optional[str] = None
) -> dict[str, Any]:
    return _dump(
        await _run(
            "report_issue",
            {
                "project_id": project_id,
                "conversation_id": conversation_id,
                "chars": len(message or ""),
            },
            lambda c: T.report_issue(
                c, message, project_id=project_id, conversation_id=conversation_id
            ),
        )
    )


@server.tool(
    name="request_tool",
    description=(
        "Ask dembrane for a tool that does not exist yet. Say what you wanted to do, in your "
        "own words, and give one example call you wish had worked."
    ),
)
async def request_tool(
    name: str, description: str, example: Optional[str] = None
) -> dict[str, Any]:
    return _dump(
        await _run(
            "request_tool",
            {"name": name, "chars": len(description or "")},
            lambda c: T.request_tool(c, name, description, example=example),
        )
    )


@server.tool(
    name="list_docs",
    description="The dembrane user documentation: every page with its path and title. Public content.",
)
async def list_docs() -> list[dict[str, Any]]:
    return _dump(await _run("list_docs", {}, T.list_docs))


@server.tool(
    name="read_doc",
    description="Read one documentation page by path, line-numbered. Use offset to continue a long page.",
)
async def read_doc(path: str, offset: int = 1, limit: int = 400) -> dict[str, Any]:
    return _dump(
        await _run(
            "read_doc",
            {"path": path, "offset": offset, "limit": limit},
            lambda c: T.read_doc(c, path, offset=offset, limit=limit),
        )
    )


@server.tool(
    name="search_docs",
    description="Grep the documentation: a regular expression, case-insensitive, matching lines with their page and line number.",
)
async def search_docs(pattern: str, max_results: int = 50) -> list[dict[str, Any]]:
    return _dump(
        await _run(
            "search_docs",
            {"pattern": pattern[:200], "max_results": max_results},
            lambda c: T.search_docs(c, pattern, max_results=max_results),
        )
    )


@server.tool(
    name="list_project_webhooks",
    description="Webhooks on a project: name, URL, events, status. Never the secret.",
)
async def list_project_webhooks(project_id: str) -> list[dict[str, Any]]:
    return _dump(
        await _run(
            "list_project_webhooks",
            {"project_id": project_id},
            lambda c: T.list_project_webhooks(c, project_id),
        )
    )


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
