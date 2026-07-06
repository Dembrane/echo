---
title: Internal developer overview
description: Orientation for dembrane engineers - repo layout, where things live, and a map of the internal developer guides.
audience: developer-internal
---

# Internal developer overview

These pages are for engineers working *on* the dembrane codebase - not self-hosters or API
integrators (those are the [external developer guides](../developer-external/index.md)). The
goal here is to get you oriented fast: where each service lives, how the data flows, and how
a change reaches production.

> [!NOTE]
> This is internal reference. It assumes you have the `echo` monorepo checked out and access
> to the team's tooling. If you're self-hosting or building against the public API, start with
> [self-hosting](../developer-external/self-hosting.md) and
> [the participant API](../developer-external/participant-api.md) instead.

## What dembrane is, in one paragraph

People speak - in a workshop, a town hall, a citizen panel, a research interview - and
dembrane records, transcribes securely in dozens of languages, and turns hours of dialogue
into summaries, themes, reports, and a chat you can interrogate. The platform is event-driven:
audio arrives in chunks, work fans out to background workers, and the dashboard streams
progress back over SSE. We treat language models as tools, not oracles - the human stays in
the room and in charge.

## The repo at a glance

Everything lives in one monorepo, `echo/`. The pieces you'll touch most:

| Path | What it is |
|---|---|
| `echo/server/` | The FastAPI backend, Dramatiq workers, and the APScheduler. The heart of the system. |
| `echo/server/dembrane/` | The Python package: API routers, service layer, tasks, settings, policies. |
| `echo/frontend/` | The React/TypeScript SPA. One codebase serves both the *dashboard* and the *participant portal* - it picks the router by hostname. |
| `echo/agent/` | The standalone agent service (CopilotKit + LangGraph) for agentic chat. Runs on its own port. |
| `echo/directus/` | The Directus deployment: data layer, auth, file storage, and the schema snapshot (`sync/snapshot/`). |
| `echo/docs/` | Engineering docs - ADRs, plans, issues, migration notes, the LiteLLM config reference. |
| `dembrane-go/` | The native SwiftUI iOS recording app. Separate build; talks to the same backend. |
| `echo/tools/` | Operational tooling (e.g. usage tracker). |

## The services

dembrane is several processes, not one. Each guide below goes deeper, but the shape is:

- *FastAPI backend* on `:8000` - the v1 (`/api/*`) and v2 (`/api/v2/*`) APIs, the BFF layer, and the service layer.
- *Agent service* on `:8001` - agentic chat, leased turns in Redis.
- *Directus* on `:8055` - the data and auth layer.
- *Dramatiq workers* - a `network` queue (gevent, for async I/O) and a `cpu` queue.
- *APScheduler* - a blocking scheduler that fans periodic work out to Dramatiq.
- Backing stores: *PostgreSQL* (with pgvector), *Redis/Valkey*, *S3* (MinIO or DigitalOcean Spaces).

See [architecture](./architecture.md) for the full picture, including ports, the BFF, and auth.

## Where to read next

Start with [architecture](./architecture.md), then dip into whichever area you're working on:

- *[Architecture](./architecture.md)* - services, ports, the v1/v2 split, the BFF and service layers, and how authentication works (Directus JWT, the `admin_access` claim).
- *[The data model](./data-model.md)* - the 49 Directus collections and how org → workspace → project → conversation hang together.
- *[The processing pipeline](./processing-pipeline.md)* - what happens between an uploaded chunk and a finished summary; transcription, correction, merge, summarise, reports.
- *[Chat & the agent service](./chat-and-agent.md)* - standard RAG chat versus agentic chat, the LangGraph tools, and the lease-based runtime.
- *[Roles & policies in code](./roles-and-policies.md)* - `policies.py`, seats, inheritance, and how to add a capability or a role arm.
- *[Background jobs & scheduler](./background-jobs-and-scheduler.md)* - Dramatiq queues, the no-asyncio-in-actors rule, and every scheduled job.
- *[Local development](./local-development.md)* - the devcontainer, `mprocs`, env files, and running everything on your machine.
- *[Deployment & releases](./deployment-and-releases.md)* - how `main` and tags ship, the GitOps repo, and database migrations.
- *[Developing & maintaining the docs](./maintaining-docs.md)* - the two-way docs/code sync, the code-to-docs process, and the review gate.

## Two files you should read before you change anything

- `echo/AGENTS.md` (and the per-area `echo/server/AGENTS.md`, etc.) - the cross-cutting rules that aren't obvious from one read of a file: the Dramatiq/gevent gotchas, the two independent email senders, the settings pattern, brand and UI copy rules. Read it first; fix stale paths when you spot them.
- `echo/docs/adr/` - the architecture decision records. These explain *why* the system looks the way it does. The ones you'll meet most:
  - [ADR 0001](./background-jobs-and-scheduler.md) - over-cap conversation model (Free-tier hour limit).
  - ADR 0002 - billing-period toggle (monthly premium).
  - ADR 0003 - external as a stored role (see [roles & policies](./roles-and-policies.md)).
  - ADR 0004 - unified invite modal and org-only membership.
  - ADR 0005 - the per-seat tier overhaul (supersedes parts of 0001/0002).

## House conventions worth knowing early

- *Config goes through `settings.py`.* Add env vars as fields on `AppSettings`; fetch with `settings = get_settings()`. Never read `os.environ` directly. (`echo/server/AGENTS.md`.)
- *Prefer Directus queries over raw SQLAlchemy* in API handlers reading project/conversation data - it keeps behaviour aligned with the admin console.
- *No asyncio inside Dramatiq actors.* The `network` workers run under gevent; use `run_async_in_new_loop` / `run_in_thread_pool`. See [background jobs](./background-jobs-and-scheduler.md).
- *Local entry points go through `uv run` so env and deps stay consistent.
