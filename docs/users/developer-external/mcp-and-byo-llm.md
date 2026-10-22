---
title: MCP & bring-your-own-LLM
description: Connect an assistant to dembrane over MCP. The address, the OAuth flow and consent page, the organisation switch, the fifteen tools and their limits.
audience: developer-external
---

# MCP & bring-your-own-LLM

dembrane has an MCP server. An assistant such as Claude, ChatGPT or Le Chat connects to it and reads the conversations, transcripts and projects that one person can already see. The product labels it Beta.

On the hosted service the address is:

```text
https://api.dembrane.com/api/mcp
```

On any other install it is `<API origin>/api/mcp`.

This is what "bring your own LLM" means in dembrane: your assistant brings its own model and reads dembrane through tools. It does not change the model behind dembrane's own features. See [configuration](./configuration-and-llm-providers.md).

## Before anyone can connect

MCP access is off for every organisation until an organisation admin or owner turns it on.

1. Open the organisation's settings and choose "MCP access".
2. Turn on the switch and confirm "Turn on MCP access?".

Turning it off stops every connected agent in that organisation on its next call. Members keep their connections, and they work again when the switch is back on.

## Connect an assistant

1. Open "Connect your agent" on the dashboard, at `/connect-agent`. On your first visit you accept the notice "Your data will leave dembrane". Copy the "MCP URL". Organisation admins also find a link to this page under "MCP access".
2. Add that URL to your assistant as an MCP server.
3. The assistant opens dembrane in your browser. You see "{agent} wants MCP access to dembrane".
4. Choose under "In which organisations". An organisation where the switch is off reads "Not enabled by an admin of {organisation}" and cannot be chosen.
5. If the agent asks to write, you see "Also allow it to change project settings". Tick it only if the agent needs it.
6. Choose "Access expires after": 30, 90 or 365 days. The default is 90.
7. Tick "I understand that {agent} and its provider will receive this data", then "Allow".

The agent acts as you. It sees what you see in the organisations you chose and nothing more, and it is never staff.

## For client builders: the OAuth flow

The server is an OAuth 2.1 authorisation server and an MCP server on one address.

| Item | Value |
|---|---|
| Issuer and MCP endpoint | `<API origin>/api/mcp` |
| Authorisation | `/api/mcp/authorize`, with PKCE. `S256` is the only method. |
| Token | `/api/mcp/token`. Grant types `authorization_code` and `refresh_token`. |
| Registration | `/api/mcp/register`. Dynamic client registration (RFC 7591), open, limited to 20 per hour per address. |
| Revocation | `/api/mcp/revoke` |
| Client authentication | `client_secret_post` or `client_secret_basic` |
| Discovery | `/.well-known/oauth-authorization-server/api/mcp`, `/api/mcp/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/api/mcp` |
| Transport | Stateless streamable HTTP with JSON responses |

1. Your client registers itself.
2. It sends the browser to the authorisation endpoint. The server holds the request for 10 minutes and redirects the browser to the consent page on the dashboard.
3. The person allows or denies. Allowing returns a single-use code, valid 5 minutes, to your redirect address. Denying returns an error.
4. Your client exchanges the code for a token pair.

| Token | Prefix | Lifetime |
|---|---|---|
| Access token | `dbr_at_` | 1 hour |
| Refresh token | `dbr_rt_` | 30 days |

Refreshing replaces both tokens. Revoking either one ends both.

The scopes are `read` and `write`. Every grant includes `read`, and the MCP endpoint needs it. Without a valid token the endpoint answers `401` with a `WWW-Authenticate` header that points at the protected resource document.

## The tools

Each tool is also a plain REST call under `/api/v2/agent`, with the same bearer token.

| Tool | What it does | REST |
|---|---|---|
| `dembrane_whoami` | Who the agent acts as: the person, the scopes, the build version, and every organisation and workspace in the grant. | `GET /whoami` |
| `dembrane_find_projects` | Finds projects by name across every workspace the grant can reach. At most 200 results. | `GET /projects/find` |
| `dembrane_get_project` | One project's settings: name, language, context, whether new conversations are allowed. | `GET /projects/:id` |
| `dembrane_update_project` | Changes project settings. Needs the `write` scope and the person's right to edit the project. | `PATCH /projects/:id` |
| `dembrane_list_project_webhooks` | The webhooks on a project, never the secret. Needs the right to manage webhooks. | `GET /projects/:id/webhooks` |
| `dembrane_list_conversations` | A page of a project's conversations, without transcripts. At most 500 per page. | `GET /projects/:id/conversations` |
| `dembrane_search_transcripts` | Conversations in a project whose transcript contains the query words, with up to 3 snippets each. | `GET /projects/:id/search` |
| `dembrane_grep_conversation` | Snippets from one conversation's transcript around the query words. At most 50 matches. | `GET /conversations/:id/grep` |
| `dembrane_read_transcript` | One conversation's transcript as a page of chunks. At most 200 per page. | `GET /conversations/:id/transcript` |
| `dembrane_get_conversation` | One conversation's metadata: participant, title, summary, tags, status, duration. Never the transcript. | `GET /conversations/:id` |
| `dembrane_report_issue` | Files a support ticket in the person's name. | `POST /issues` |
| `dembrane_request_tool` | Asks the dembrane team for a tool that does not exist yet. | `POST /tool-requests` |
| `dembrane_read_doc` | Reads one page of this documentation by path, with line numbers. Up to 400 lines per call. | `GET /docs/read` |
| `dembrane_search_docs` | Searches this documentation with a regular expression (at most 50 results), or lists every page when no pattern is given. | `GET /docs/search` |
| `dembrane_list_tools` | Every tool with a one-line description and whether it is read-only. | `GET /tools` |

## Limits

- An MCP answer is capped at about 60,000 characters. A longer answer is cut, marked `truncated`, and says how to page.
- An organisation on the free plan gets 1,000 tool calls per calendar month (UTC). An organisation with any workspace on a paid plan is not counted. `dembrane_whoami` and `dembrane_find_projects` never count.
- Each tool follows the person's own permissions. No plan hides transcript text.

## Control and audit

- You revoke your own connections under "Connected agents" on "Connect your agent".
- An organisation admin revokes any connection that names their organisation, under "MCP access".
- Every tool call is recorded: the person, the client, the organisation, the tool, its parameters, the status and the duration. Message bodies are not recorded. Organisation admins read their organisation's trail under "Activity".
- A connection stops when it is revoked or expires, or when the person's account is suspended or archived.

## What bring-your-own-LLM does not mean

You cannot point dembrane's built-in features (transcription, summaries, Ask, reports) at another model provider. They run on Google Vertex AI, and no setting changes the provider. See [configuration & LLM providers](./configuration-and-llm-providers.md).

## Related

- [MCP & bring-your-own-LLM (feature)](../../features/mcp-and-bring-your-own-llm.md)
- [Authentication](./authentication.md)
- [Webhooks](./webhooks.md)
- [Export & integrations](./export-and-integrations.md)
- [Configuration & LLM providers](./configuration-and-llm-providers.md)
