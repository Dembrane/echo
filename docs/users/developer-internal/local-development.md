---
title: Local development
description: Run the whole dembrane stack on your machine - the devcontainer, mprocs services and ports, env files, and the MinIO option for S3.
audience: developer-internal
---

# Local development

dembrane is several services with shared infrastructure, so the recommended way to develop is
the *devcontainer* plus `mprocs`: the container provides Postgres, Redis/Valkey and
Directus; `mprocs` runs the host processes (API, workers, scheduler, the two frontends). This
page gets you from a fresh checkout to a running stack. For what each service *is*, see
[architecture](./architecture.md); for how it ships, see
[deployment & releases](./deployment-and-releases.md). The operator-facing version of this - 
for people running dembrane outside our setup - is
[self-hosting](../developer-external/self-hosting.md).

## What you'll be running

| Process (`mprocs`) | Command | Port |
|---|---|---|
| `server` | `uv run uvicorn dembrane.main:app --port 8000 --reload --loop asyncio` | `:8000` |
| `workers` | `uv run dramatiq-gevent --queues network --processes 1 --threads 10 dembrane.tasks` | - |
| `workers-cpu` | `uv run dramatiq --queues cpu --processes 1 --threads 1 dembrane.tasks` | - |
| `scheduler` | `uv run python -m dembrane.scheduler` | - |
| `admin-dashboard` | `pnpm run dev` (in `frontend/`) | `:5173` |
| `participant-portal` | `pnpm run participant:dev` (in `frontend/`) | `:5174` |

Plus the infra from the devcontainer's compose file: *Postgres* (with pgvector), *Redis/Valkey*,
*Directus* (`:8055`), and optionally the *agent service* (`:8001`).

> [!NOTE]
> `:5173` is the host *dashboard* and `:5174` is the participant *portal* - both are the
> same `frontend/` codebase, served by two Vite dev servers so you can work on either in
> isolation. See [architecture](./architecture.md#one-frontend-two-surfaces).

## The devcontainer

Use the devcontainer for development - it configures and manages the services and their
dependencies for you. Everything lives in `echo/.devcontainer/`:

- `devcontainer.json` - the VS Code / Cursor "Dev Containers" definition.
- `docker-compose.yml` - Postgres, Redis/Valkey, Directus, agent.
- `docker-compose-s3.yml` - adds *MinIO* if you want local S3 instead of a cloud bucket.
- `setup.sh` - provisioning (installs `pnpm` + `uv`, syncs deps).

Prerequisites: VS Code or Cursor with the *Dev Containers* extension, Docker, and WSL on
Windows. (The `echo/readme.md` is the canonical, screenshot-level walkthrough - follow it for
the exact click-path; this page is the orientation.) The toolchain is `pnpm` for the
frontend and `uv` for the Python server - local entry points always go through `uv run` so
env and deps stay consistent.

> [!TIP]
> On this team's Macs the devcontainer runs on *Podman*, not Docker Desktop. If `docker`
> commands behave oddly, check which engine your editor is wired to.

## Env files

Two services each need their own env file, both copied from a checked-in sample:

- `echo/server/.env` - from `echo/server/.env.sample`. The backend, workers and scheduler all read it. Config is parsed by `dembrane/settings.py` into `AppSettings` - add new vars as fields there and read them via `get_settings()`. *Never read `os.environ` directly.*
- `echo/directus/.env` - from `echo/directus/.env.sample`. The Directus deployment's config (DB connection, admin creds, storage, its own email).

Key things to set in `server/.env`:

- *LLM model groups* - `LLM__<GROUP>__*` for `MULTI_MODAL_PRO`, `MULTI_MODAL_FAST`, `TEXT_FAST`, with numbered fallbacks `LLM__<GROUP>_1__*`. Full reference: `echo/docs/litellm_config.md` and [configuration & LLM providers](../developer-external/configuration-and-llm-providers.md).
- *Transcription* - `ASSEMBLYAI_*` (key, base URL, and the webhook URL/secret if you want webhook-mode transcription rather than polling).
- *S3* - your bucket creds, or the MinIO endpoint if you're using `docker-compose-s3.yml`.
- *Embeddings* - `EMBEDDING_*` (model, key, base URL, version) before anything calls `dembrane.embedding.embed_text`.
- *Email* - `SENDGRID_API_KEY` for the app's transactional email (`email.py`, the HTTP API). Directus's own email is a *separate* SMTP path keyed by `EMAIL_SMTP_PASSWORD` - don't conflate them.

> [!IMPORTANT]
> There are *two independent email senders*: the Python app (SendGrid HTTP API, `email.py`)
> and Directus itself (SendGrid SMTP). They use different keys and config. Setting one does not
> affect the other. EU residency (`SENDGRID_REGION=eu`) must be set on both, with EU regional
> subuser keys. See `echo/server/AGENTS.md`.

## S3: MinIO locally, or bring your own

You have two options for object storage:

- *MinIO* - bring up the stack with `docker-compose-s3.yml` to get a local S3-compatible bucket. Good for offline work; point the server's S3 env at it.
- *Bring your own* - any S3-compatible endpoint (a dev DigitalOcean Space, AWS, etc.). For EU residency, use an EU endpoint.

Audio chunks and generated files live here; the participant/iOS upload path writes to it via
presigned URLs (see [the processing pipeline](./processing-pipeline.md)).

## Running a subset

`mprocs` opens a TUI of all services (`j`/`k` select, `s` start, `x` stop, `r` restart,
`a`/`X` stop-all, `q` quit). To launch just part of the stack:

```bash
mprocs --names server,workers
```

Handy combos:

- *API + workers only* (`server,workers,workers-cpu`) - backend work without the frontends.
- *Just the dashboard* (`admin-dashboard`) against a remote backend - see `echo/docs/frontend_getting_started.md`.

## The agent service

The standalone agent (`echo/agent/`) runs on `:8001`. It's its own `uv` project:

```bash
cd echo/agent
cp .env.sample .env        # set GEMINI_API_KEY
uv sync
uv run uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

It comes up automatically in the devcontainer compose; run it by hand when you're iterating on
the agent. See [chat & the agent service](./chat-and-agent.md).

## Checking your code

Run `echo/check-code.sh` before pushing - it's the repo's lint/format/type gate. Tests live in
`echo/server/tests/` and `echo/agent/tests/`. New work should land with tests, style and docs
(see [contributing](../developer-external/contributing.md)).

## Common gotchas

- *gevent + asyncio.* Inside Dramatiq actors, never run a bare asyncio loop - use `async_helpers`. See [background jobs](./background-jobs-and-scheduler.md). This bites people who write a new actor and call `asyncio.run(...)`.
- *Directus schema drift.* If the dashboard 500s on data that "should" be there, your local Directus schema may be behind the snapshot. Push the snapshot (`echo/directus/sync/`) - and mind the `is_indexed` / drop-index ordering pitfall when syncing.
- *Misfired scheduler jobs.* The scheduler sets `misfire_grace_time=60` and `coalesce=True` so jobs run late rather than never on a loaded host - if a cron "didn't fire", check the worker logs, not just the scheduler.

---

*Related*

- [Architecture](./architecture.md)
- [Background jobs & scheduler](./background-jobs-and-scheduler.md)
- [Deployment & releases](./deployment-and-releases.md)
- [Self-hosting (external)](../developer-external/self-hosting.md)
- [Configuration & LLM providers (external)](../developer-external/configuration-and-llm-providers.md)
