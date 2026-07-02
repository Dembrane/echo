---
title: Architecture
description: The services that make up dembrane, the ports they run on, the v1/v2 API split, the BFF and service layers, and how authentication works.
audience: developer-internal
---

# Architecture

dembrane is event-driven and split into several long-running processes that talk to each
other through Postgres, Redis/Valkey and S3. This page is the map: what runs where, how the
API is layered, and how a request is authenticated. For the build-and-run mechanics see
[local development](./local-development.md); for how the model fans out into background work
see [the processing pipeline](./processing-pipeline.md).

## The services and their ports

| Service | Default port | Code | What it does |
|---|---|---|---|
| FastAPI backend | `:8000` | `echo/server/dembrane/` | The HTTP API (v1 + v2), the BFF, and the service layer. |
| Agent service | `:8001` | `echo/agent/` | Agentic chat (CopilotKit + LangGraph). Leased turns in Redis. |
| Directus | `:8055` | `echo/directus/` | Data layer, authentication, file storage. 49 collections. |
| Dramatiq `network` workers | - | `echo/server/dembrane/tasks.py` | gevent workers for async I/O: transcribe, merge, summarise, reports, emails. |
| Dramatiq `cpu` workers | - | `tasks.py` | CPU-bound work (e.g. chunk merge). Single-threaded. |
| APScheduler | - | `echo/server/dembrane/scheduler.py` | Blocking scheduler; fans periodic work out to Dramatiq. |
| Admin dashboard (dev) | `:5173` | `echo/frontend/` | Vite dev server for the host dashboard. |
| Participant portal (dev) | `:5174` | `echo/frontend/` | Vite dev server for the portal (same codebase). |

Backing stores:

- *PostgreSQL* with the *pgvector* extension - the system of record (managed through Directus) plus vector embeddings for retrieval.
- *Redis/Valkey* - the Dramatiq broker, idempotency locks and coordination counters, SSE pub/sub, the agent's turn leases, and caches.
- *S3* - audio chunks and generated files. MinIO locally, DigitalOcean Spaces in production (any S3-compatible endpoint works).

The `mprocs.yaml` at the repo root launches the host processes (`server`, `workers`,
`workers-cpu`, `scheduler`, `admin-dashboard`, `participant-portal`); the devcontainer's
compose file runs the infra (Postgres, Redis, Directus). See
[local development](./local-development.md).

## One frontend, two surfaces

`echo/frontend/` is a single React/TypeScript SPA that serves both the *host dashboard*
(`dashboard.dembrane.com`) and the *participant portal* (`portal.dembrane.com`). It chooses
which router to mount by hostname. The dashboard is the authenticated host experience; the
portal is the unauthenticated participant experience (no account needed). In dev they're two
Vite servers (`:5173` and `:5174`) so you can work on either in isolation.

## The API: v1 and v2

The backend exposes two generations of API under `echo/server/dembrane/api/`:

- *v1* - `/api/*`, the original routers (`api/api.py`, `conversation.py`, `project.py`, `chat.py`, `participant.py`, `project_webhook.py`, `search.py`, …). Still very much live: the participant upload API, webhooks, export and the legacy dashboard calls all sit here.
- *v2* - `/api/v2/*`, under `api/v2/`. This is where the modern, role-and-billing-aware surface lives: `auth.py`, `orgs.py`, `workspaces.py`, `projects.py`, `invites.py`, `billing.py`, `admin.py` (+ `admin_managed.py`, `admin_training.py`), `onboarding.py`, `notifications.py`, `workspace_settings.py`, and more.

New work generally lands in v2. v1 endpoints are kept where clients (the portal, webhooks,
the iOS app's upload path) still depend on them.

### The BFF layer - `api/v2/bff/`

The *backend-for-frontend* layer (`api/v2/bff/`) exists to give the dashboard and the iOS
app exactly the shapes they need, composed server-side, rather than making them stitch
together several primitive calls. It currently covers:

- `bff/conversations.py` - conversation list/detail views shaped for the UI.
- `bff/chats.py` - chat sessions and messages.
- `bff/reports.py` - report views.
- `bff/tags.py` - project tags.
- `bff/_access.py` - the shared access-check helper the BFF endpoints lean on.

> [!NOTE]
> dembrane Go (iOS) calls the same `v2/bff/*` endpoints as the web dashboard, plus the v1
> `participant/*` upload API. Keep BFF responses stable - two clients depend on them. See
> [dembrane Go (the mobile app)](../../features/mobile-app-dembrane-go.md).

### The service layer - `service/`

Business logic that's shared across routers lives in `echo/server/dembrane/service/`
(`agentic.py`, `chat.py`, `conversation.py`, `file.py`, `project.py`, `webhook.py`). Routers
stay thin; the service layer holds the rules so v1, v2 and BFF endpoints behave consistently.
Above that sit module-level helpers - `policies.py`, `seat_capacity.py`, `inheritance.py`,
`billing_account.py`, `coordination.py`, `summary_utils.py`, and so on.

## Authentication

Auth is delegated to *Directus*. The backend validates the Directus JWT on each request via
`echo/server/dembrane/api/dependency_auth.py`:

- `require_directus_session(request)` reads the token from either the `directus_session_token` cookie* (browser sessions) or an `Authorization: Bearer <jwt>` header (the iOS app, API clients). It decodes the JWT into a `DirectusSession`.
- The decoded token carries an `admin_access` claim. When `true`, the caller is dembrane *staff* (a Directus administrator) - this is the gate for the admin panel and the staff-only endpoints in `admin.py` / `admin_managed.py` / `admin_training.py`. See [the staff guides](../staff/admin-panel-overview.md).
- `require_directus_client(...)` hands a router an authenticated Directus client when it needs to read or write the data layer as the caller.

Authorisation *beyond* "is this a valid user / is this staff" is policy-based, not
role-based: enforcement code calls `has_policy(...)`, never checks the role string directly.
That whole system - org/workspace role presets, tier gates, seats, inheritance - is covered
in [roles & policies in code](./roles-and-policies.md). For the conceptual model see
[roles & permissions](../../features/roles-and-permissions.md).

> [!IMPORTANT]
> The cookie name is configurable (`settings.directus.session_cookie_name`). Don't hard-code
> `directus_session_token`; read it from settings.

## How a request flows

A typical authenticated dashboard request:

1. The SPA calls a `v2/bff/*` endpoint with the session cookie.
2. `dependency_auth` validates the JWT and resolves the caller (and whether they're staff).
3. The router calls the service layer, which checks `has_policy(...)` for the action and reads/writes through Directus (or, for hot reads, pgvector/SQL).
4. Anything slow or fan-out-shaped (transcription, summaries, reports, emails) is *not* done inline - the router enqueues a Dramatiq actor and returns. Progress streams back to the client over SSE, backed by Redis pub/sub. See [the processing pipeline](./processing-pipeline.md) and [background jobs](./background-jobs-and-scheduler.md).

## The standalone agent service

Agentic chat does *not* run inside the FastAPI process. It's a separate service in
`echo/agent/` (port `:8001`) built on CopilotKit + LangGraph, with its own settings and an
`echo_client.py` that calls back into the backend for data. It coordinates turns with
*leases in Redis* so a run isn't processed twice. Standard (non-agentic) chat *is* served by
the main backend. The split, the tools, and the lease runtime are covered in
[chat & the agent service](./chat-and-agent.md).

## Production note

The production API runs under a *custom asyncio uvicorn worker*
(`dembrane.asyncio_uvicorn_worker.AsyncioUvicornWorker`) - we avoid `uvloop` for
`nest_asyncio` compatibility. Locally, `mprocs` runs uvicorn with `--loop asyncio --reload`.

---

*Related*

- [The data model](./data-model.md)
- [The processing pipeline](./processing-pipeline.md)
- [Background jobs & scheduler](./background-jobs-and-scheduler.md)
- [Roles & policies in code](./roles-and-policies.md)
- [Authentication (external)](../developer-external/authentication.md)
