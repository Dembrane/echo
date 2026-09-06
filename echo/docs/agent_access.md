# Agent access (MCP + OAuth 2.1)

An AI agent connects to dembrane as one person and sees exactly what that person sees, in the organisations they picked. Code lives in `server/dembrane/agent_access/`; the two routers are `api/v2/agent.py` (token-authed REST) and `api/v2/agent_access.py` (session-authed management). The MCP transport is mounted in `main.py`.

## Endpoints

| Path | Auth | Purpose |
| --- | --- | --- |
| `/api/mcp` | OAuth access token | MCP Streamable HTTP, stateless, JSON responses |
| `/api/mcp/authorize`, `/token`, `/register`, `/revoke` | OAuth | Authorisation server (MCP SDK handlers over `agent_access/oauth.py`) |
| `/.well-known/oauth-authorization-server/api/mcp`, `/.well-known/oauth-protected-resource/api/mcp` | none | Discovery (RFC 8414, RFC 9728). The path-relative form is served too. |
| `/api/v2/agent/*` | OAuth access token | Same tools as REST |
| `/api/v2/agent-access/*` | cookie session | Consent step, grants, org switch, audit |

Tools: `whoami`, `list_organisations`, `list_workspaces`, `list_projects`, `find_projects`, `get_project`, `update_project` (write scope), `list_conversations` (optional `created_after` / `created_before`), `search_transcripts`, `grep_conversation`, `read_transcript`, `get_conversation`, `get_conversations` (max 50), `list_project_webhooks`, `report_issue`, `request_tool`, `list_docs`, `read_doc`, `search_docs`.

The read tools are thin adapters over `server/dembrane/toolkit/` (`conversations.py`, `projects.py`): one implementation per primitive, the same one the in-app assistant's routes in `api/agentic.py` call, so the two front doors cannot drift on access checks or on the locked scrub. `search_transcripts` matches chunk transcripts case-insensitively (words of four letters or more, at most four) and returns up to three snippets per conversation; `read_transcript` pages chunks (at most 200 per call) with a total and `has_more`; `find_projects` searches by name across every workspace the person can reach, filtered to the grant's organisations, and charges nothing.

The three docs tools read the product documentation through `dembrane/knowledge.py`: the published site (docs.dembrane.com, one markdown twin per page) in deployed environments, the repository's `docs/` folder locally, cached for an hour. Same list, line-numbered read and regex grep the in-app assistant has; public content, so no organisation and no budget charge.

`report_issue` files a `support_request` through `dembrane/support_requests.py`, the one writer the dashboard's report form and the assistant's `reachOutToDembraneSupport` also use, with `source = agent_mcp`; the forwarder carries it into the same triage thread as a host's report. `request_tool` files an `agent_insight` of kind `capability_gap` through `dembrane/agent_insights.py`, the channel the assistant's `noteInsight` already uses, with `source = agent_mcp` and the wanted tool name in `suggested_capability`. A call to a tool that does not exist is recorded as an `unknown_tool` audit row with the requested name, and the error message points the agent at `request_tool`. Those three rows are the signal for which tools to add next.

## Flow

1. The agent registers a client (dynamic registration, public client with PKCE, or a secret we store Fernet-encrypted).
2. `/api/mcp/authorize` parks the request in Redis (10 min) and redirects the browser to `<dashboard>/settings/agents/authorize?request=<id>`.
3. The consent page (session) shows client, scopes, redirect host, the user's organisations and the risk notice. Approve creates an `agent_grant` and a single-use code (Redis, 5 min). Deny sends `error=access_denied` back.
4. `/token` exchanges the code for an access token (1 h) and a refresh token (30 d). Refresh rotates the pair; the old pair dies. Only SHA-256 hashes are stored (`agent_token`).
5. Every call: token → grant (live, not revoked) → `AgentContext`. The org must be in the grant and have `org.agent_access_enabled`. Then the normal resolvers (`resolve_project_access`, `resolve_conversation_access`, `get_workspace_context`) run as the user, inside the toolkit for the read tools. Then one `agent_audit_event` row.

## Rules that are not obvious from the code

- **Org switch is off by default.** An admin turns it on per org. Turning it off blocks every grant naming that org on its next call. The check is cached in Redis for 60 s.
- **Free budget.** An org with no workspace above `free` gets `FREE_TIER_MONTHLY_CALLS` (1000) calls per calendar month, counted in Redis per org. A batch counts once per org. Paid orgs are not counted.
- **Scopes.** `read` always. `write` only reaches `update_project` and the same whitelist of fields the dashboard exposes.
- **Locked conversations** (over-cap, tier) come back with `transcript_locked: true` and no text, same as the dashboard.
- **Webhooks** inherit the `workspace:webhooks` gate (admin, changemaker tier), so most agents get 403 there.
- **404 not 403** for anything outside the grant, so an agent cannot probe for ids.

## Schema

`org.agent_access_enabled`, `org.agent_access_updated_at`, `org.agent_access_updated_by`; collections `agent_client`, `agent_grant`, `agent_token`, `agent_audit_event`. All in the Directus snapshot; push it before the release tag like any schema change.

## Local check

`tests/test_agent_access.py` covers the provider and the context rules with an in-memory store. For the real flow against a running stack, register a client, hit `/api/mcp/authorize`, approve through `/api/v2/agent-access/authorize-requests/{id}/approve` with a Directus JWT as bearer, exchange at `/api/mcp/token`, then call `/api/v2/agent/whoami` and POST JSON-RPC to `/api/mcp`.
