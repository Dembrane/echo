---
title: Authentication
description: The three credentials dembrane accepts (a signed-in session, an OAuth token for agents, the participant token) and what none of them is, an API key.
audience: developer-external
---

# Authentication

dembrane accepts three credentials. None of them is an API key: there are no API keys, personal access tokens or static tokens.

| You are building | Credential | Where it comes from |
|---|---|---|
| Something an assistant or agent uses | An OAuth access token | The person approves your client on a consent page. See [MCP](./mcp-and-byo-llm.md). |
| A recorder for participants | The participant token | The response to the call that starts a conversation. See [the participant API](./participant-api.md). |
| A receiver for events | None. dembrane calls you. | You check the signature. See [webhooks](./webhooks.md). |
| A call as a signed-in person | A session | The person signs in to the dashboard. |

## Sessions

Sign-in and sessions are Better Auth, served by the API under `/api/auth/*`.

| Topic | How it works |
|---|---|
| Ways to sign in | Email and password, a one-time code by email (6 digits, valid 10 minutes), Google, and a second factor with TOTP. |
| Passwords | 8 to 256 characters. A new account must verify its email before it can sign in with a password. |
| Lifetime | A session lasts 7 days and is extended once it is older than 1 day. |
| Cookie | `<prefix>.session_token`. The default prefix is `dembrane`. Outside local development the cookie is secure and its name starts with `__Secure-`. |
| Bearer | The API reads the session from the cookie or from an `Authorization: Bearer` header. Either way it is the same session of a person who signed in. |
| One browser at a time | A dashboard sign-in while the account is signed in on another browser signs nobody in until the person chooses to replace the other sessions. |
| Ending | A password reset ends the person's sessions. A suspended or archived account gets no session. |

A route that needs a person answers `401` with the code `auth.session_expired` when there is no valid session.

> [!IMPORTANT]
> dembrane has no supported way to issue a long-lived credential for a script. Do not build an unattended integration on a person's session. Use [webhooks](./webhooks.md) to receive data and [MCP](./mcp-and-byo-llm.md) to read it.

## Who may do what

A session says who someone is. What they may do comes from their role in the organisation and the workspace, and from the workspace's plan. See [roles & permissions](../../features/roles-and-permissions.md).

Routes under `/api/v2/admin/*` are for dembrane staff and are internal. No route can make someone staff.

## OAuth tokens for agents

An agent that connects through MCP gets a token pair bound to one person's grant.

| Token | Prefix | Lifetime |
|---|---|---|
| Access token | `dbr_at_` | 1 hour |
| Refresh token | `dbr_rt_` | 30 days |

The scopes are `read` and `write`. The agent sends the access token as `Authorization: Bearer`. It sees what the person sees in the organisations they chose, and it is never staff. The full flow is on the [MCP page](./mcp-and-byo-llm.md).

## The participant token

A participant has no account and no session. The call that starts a conversation returns a token in the response header `x-participant-token`. Its format is `p1.<body>.<signature>`.

Store it and send it back in the `x-participant-token` request header on every call that touches that conversation. A call with a wrong token is refused with `403` and the code `participant.token_invalid`.

## Errors

Every error from the API is one JSON body with four fields: `detail`, `code`, `params` and `action`. Match on `code` (for example `auth.session_expired`), not on the text in `detail`.

## If you run dembrane yourself

| Setting | What it does |
|---|---|
| `AUTH_SECRET` | Signs sessions and tokens. At least 32 characters. Changing it signs everyone out. |
| `AUTH_COOKIE_DOMAIN` | A parent domain shared by the dashboard, the portal and the API, so one sign-in covers all three. |
| `AUTH_COOKIE_PREFIX` | The first part of the cookie names. Changing it signs everyone out. |
| `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` | Google sign-in. Unset hides the option. |

The rest is on the [configuration page](./configuration-and-llm-providers.md).

## Related

- [MCP & bring-your-own-LLM](./mcp-and-byo-llm.md)
- [The participant API](./participant-api.md)
- [Webhooks](./webhooks.md)
- [Account & security](../../features/account-and-security.md)
- [Roles & permissions](../../features/roles-and-permissions.md)
