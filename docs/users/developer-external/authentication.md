---
title: Authentication
description: How dembrane authenticates API requests - Directus JWTs, static integration tokens, and the staff admin_access claim.
audience: developer-external
---

# Authentication

dembrane's data, authentication, and file storage all live in *Directus*. The FastAPI
backend doesn't run its own user database; it trusts tokens issued by Directus and reads the
claims inside them. So "authenticating against dembrane" almost always means "presenting a
valid Directus token". This page explains the three ways to do that and how the backend
interprets what it receives.

> [!NOTE]
> This page is about the *authenticated* API (the dashboard and integrations). The
> [participant API](./participant-api.md) is deliberately unauthenticated - that's how someone
> can record via a link with no account.

## How the backend reads a request

The backend's auth dependency (`dependency_auth.py`) looks for a Directus session token in one
of two places, in this order:

1. A cookie named `directus_session_token` (this is how the browser-based dashboard and
   portal authenticate - Directus sets the cookie on login).
2. An `Authorization: Bearer <token>` header (this is how server-to-server integrations
   authenticate).

Either way, the token is validated as a Directus JWT and its claims are used to identify the
user and their permissions. There's no separate dembrane login: a valid Directus token is a
valid dembrane request.

## Obtaining a token via Directus

For an integration, log in against your Directus instance and use the access token it returns:

```bash
curl -X POST https://YOUR-DIRECTUS-HOST:8055/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.org","password":"••••••••"}'
```

Directus replies with an `access_token` (a short-lived JWT) and a `refresh_token`. Send the
access token as a bearer token on subsequent calls to the dembrane backend:

```bash
curl https://YOUR-API-HOST:8000/api/v2/... \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

When the access token expires, exchange the refresh token at Directus's `/auth/refresh`
endpoint for a fresh pair. (Directus is the authority here; its
[authentication documentation](https://directus.io/docs) covers refresh, logout, and 2FA in
full. dembrane's dashboard supports two-factor authentication on login.)

> [!TIP]
> For local development with [self-hosting](./self-hosting.md), your Directus admin
> credentials come from `directus/.env`. Logging in with them gives you a token whose claims
> include `admin_access` (see below).

## Static tokens for integrations

For a long-lived, non-interactive integration - a backend job, a sync script - a per-session
login is awkward. Directus supports *static access tokens*: assign one to a dedicated
service user in Directus, and send it as the bearer token. dembrane reads it from the
environment as `DIRECTUS_TOKEN` for its own server-to-server calls, and you can mint
equivalent tokens for your integrations.

> [!IMPORTANT]
> A static token carries the full permissions of the user it's attached to and doesn't
> expire on its own. Treat it like a password: scope its user to exactly what the integration
> needs, store it as a secret, and rotate it if it leaks. Prefer a narrowly-permissioned
> service user over reusing an admin token.

## The `admin_access` claim (staff)

dembrane has a notion of *staff* - dembrane employees who operate the
[admin panel](../developer-internal/roles-and-policies.md). Staff status is *not* a dembrane
role in the [roles & permissions](../../features/roles-and-permissions.md) sense; it's a JWT
claim, `admin_access`, that Directus sets when the user has the Directus admin role.

The backend gates the staff-only endpoints (everything under `/api/v2/admin/*`, plus actions
like setting a tier or transferring a workspace) on `admin_access == true`. If you self-host,
your own Directus admins will carry this claim - which means they can reach the admin/billing
surface. Grant the Directus admin role deliberately.

The everyday [org and workspace roles](../../features/roles-and-permissions.md) (owner, admin,
member, billing, external, observer) are evaluated separately, per organisation and per
workspace, against the policies in `policies.py`. `admin_access` sits above all of that and is
for dembrane-operations use.

## Which token for which job

| You're building… | Use |
|---|---|
| A browser app on top of the dashboard | The `directus_session_token` cookie (set by Directus login). |
| A server-to-server integration | A bearer token - a static `DIRECTUS_TOKEN`-style token on a scoped service user. |
| A short-lived script | `POST /auth/login` → use the `access_token` as a bearer token; refresh as needed. |
| Recording from a public link | Nothing - use the unauthenticated [participant API](./participant-api.md). |

## Related

- [The participant API](./participant-api.md) - the unauthenticated endpoints.
- [Webhooks](./webhooks.md) - outbound events (signed, not bearer-authenticated).
- [Export & integrations](./export-and-integrations.md) - authenticated export endpoints.
- [Roles & permissions](../../features/roles-and-permissions.md) - the org/workspace role model.
- [Self-hosting](./self-hosting.md) - where Directus fits in the stack.
