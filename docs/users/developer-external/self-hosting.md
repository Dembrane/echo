---
title: Self-hosting dembrane
description: What dembrane needs to run, how the local setup works, and what is not documented or supported for people who host it themselves.
audience: developer-external
---

# Self-hosting dembrane

There is no supported recipe yet for running the whole platform on your own infrastructure. The repository gives you the code, five Dockerfiles and a working local setup. This page says what the platform needs, how to run it on your machine, and where the gaps are.

Read [licensing](./licensing.md) before you run dembrane in production.

## What runs

Five Bun apps, built from `dembrane/platform`.

| App | What it does |
|---|---|
| `api` | The HTTP server for the dashboard, the portal and outside agents. |
| `worker` | Runs queued jobs and schedules: the audio pipeline, analysis, reports, emails. |
| `media` | An ffmpeg service. It has no database, no bucket credentials and no secrets. |
| `web` | Serves the built dashboard and portal, and forwards `/api` to the API. |
| `migrate` | A one-shot job that runs before every rollout. |

PostgreSQL is the only stateful service the platform itself needs. Jobs, schedules, live updates and rate limits all run on it. There is no Redis, no Directus service, no Python process and no separate agent service.

## Run it locally

You need Bun (the version in `dembrane/platform/.bun-version`), pnpm and Docker.

```sh
cd dembrane/platform
bun run setup        # Postgres in docker, dependencies, migrations
bun run dev          # API on :8080
bun --env-file=.env.local apps/worker/src/main.ts   # worker
bun run check        # lint, types, the layer rule, tests
```

```sh
cd dembrane/frontend
pnpm install
pnpm dev             # dashboard on :5173, /api proxied to :8080
pnpm participant:dev # portal on :5174
```

`bun run setup` copies `.env.example` to `.env.local` when it is missing and adds a generated `AUTH_SECRET` and `INVITE_HASH_SECRET`. Then it installs dependencies, starts Postgres 16 with pgvector on host port 5433, applies the migrations and adds the default verification topics.

Without Docker, run Postgres 16 with pgvector yourself on port 5432 and run `mprocs` from `dembrane/`. It starts the API, the worker, the dashboard and the portal. The one-time commands are in `dembrane/platform/README.md`.

### What local mode does differently

- Uploaded files and audio go to `.data/files` and `.data/audio` on disk, and the API serves them itself. This only exists when `APP_ENV` is `local` or `test`.
- With no `MEDIA_URL`, ffmpeg runs inside the API and the worker, so it must be on your `PATH`.
- With no `SENDGRID_API_KEY`, no email leaves the machine.
- Cookies are not marked secure.
- Webhooks may target private addresses.

## What a deployment needs

These requirements come from the code.

| Need | What the code expects |
|---|---|
| PostgreSQL with pgvector | Postgres 16 with pgvector is what the local setup uses. The login that migrates must be able to create the `vector` extension. Every process connects directly: a transaction-mode pooler breaks the job queue and the live streams. |
| Two database logins | `MIGRATION_DATABASE_URL` is the owner login for the migrate job. `DATABASE_URL` is the runtime login. Set `APP_DB_ROLE` and the migrate job grants that role its data rights. |
| Object storage | Two S3-compatible buckets: files (`FILES_S3_*`) and audio (`STORAGE_S3_*`). Outside `local` and `test`, the API and the worker refuse to start without both. |
| ffmpeg | Run the media app and set `MEDIA_URL`, with `MEDIA_AUTH=none` when it is reachable only inside your cluster. Or put ffmpeg and ffprobe on the `PATH` of the API and the worker. Their images do not contain ffmpeg. |
| Language models | A Google Cloud project with Vertex AI, and application default credentials. Set `LLM_VERTEX_PROJECT`. |
| Email | SendGrid: `SENDGRID_API_KEY`, `SENDGRID_REGION`, `EMAIL_FROM`, `EMAIL_FROM_NAME`. |
| Secrets | `AUTH_SECRET` (at least 32 characters) and `INVITE_HASH_SECRET` (at least 16). |
| Public addresses | `API_PUBLIC_URL`, `DASHBOARD_URL`, `PORTAL_URL`. |
| The frontend | The web app serves the built `dembrane/frontend`, once with `WEB_ROLE=dashboard` and once with `WEB_ROLE=portal`. Set `WEB_DIST_DIR` and `WEB_API_ORIGIN`. The web image does the build for you. |

Every setting is on the [configuration page](./configuration-and-llm-providers.md).

### Images and rollout

- The five images are built from `dembrane/platform/apps/*/Dockerfile`. `.github/scripts/build-images.sh --load` builds them into your local Docker daemon.
- Run the migrate job before the API and the worker start on a new version. It applies the schema migrations, installs the queue's schema, adds the default verification topics and grants the runtime role.
- You can run more than one worker. A schedule runs once across all of them, and the jobs of a worker that dies are resumed by another.
- The API answers `/health` (liveness, with the release), `/ready` (the database) and `/ready/worker` (a recent worker heartbeat).

## Not documented or not supported

Each of these is the state of the code today, not a plan.

- No recipe runs the whole platform. The compose file starts Postgres only. There is no compose file, Helm chart or installer for all five apps, and the Terraform in `dembrane/infra` is for dembrane's own cloud projects.
- There is no self-hosted environment. `APP_ENV` must be `local`, `test`, `preview`, `staging` or `prod`, and each loads dembrane's own values. You override them with environment variables. Which one to start from, and the full list of overrides, is not written down.
- Models run on Vertex AI only and email on SendGrid only. How to supply Vertex credentials outside Google Cloud is not written down.
- The first user is not described. Sign-up needs a verified email, and email needs SendGrid.
- The first staff member is not described. Staff rights are granted with `bun run staff:access grant <email> --by <staff-email>`, which needs an existing staff member, and a fresh database has none.
- The frontend expects the web app. Served by the web app, it gets its environment and URLs at run time. Served any other way, it falls back to dembrane's own URLs for a host it does not know.
- The frontend's product analytics target is fixed in code and is on for the environments named production and staging. There is no setting to point it elsewhere.
- Some links in the interface point at dembrane's own pages: privacy statements, legal pages, this documentation.
- The documentation tools of MCP read this site only on dembrane's own hosts. Elsewhere they need the repository's `docs/` folder beside an API that runs from source. An API image carries no docs.

## Related

- [Configuration & LLM providers](./configuration-and-llm-providers.md)
- [Licensing](./licensing.md)
- [Authentication](./authentication.md)
- [Local development](../developer-internal/local-development.md)
- [Architecture](../developer-internal/architecture.md)
