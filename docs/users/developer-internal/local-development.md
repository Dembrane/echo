---
title: Local development
description: Run dembrane on your machine. One setup command with Postgres in Docker, or mprocs with a native Postgres, the ports each process uses, what local mode does differently, and the commands you will use every day.
audience: developer-internal
---

# Local development

You need two things running: the platform (API and worker) on Postgres, and the frontend. One setup command gets you there.

The source of truth for these steps is `dembrane/platform/README.md`. If this page and the README disagree, the README is right.

## The quick way: Postgres in Docker

You need Bun (the version in `dembrane/platform/.bun-version`), pnpm and Docker. To process audio you also need ffmpeg on your `PATH`.

```sh
cd dembrane/platform
bun run setup        # Postgres in docker, dependencies, migrations
bun run dev          # API on :8080
bun --env-file=.env.local apps/worker/src/main.ts   # worker
```

```sh
cd dembrane/frontend
pnpm install
pnpm dev             # dashboard on :5173, /api proxied to :8080
pnpm participant:dev # portal on :5174
```

`bun run setup` does five things:

1. It copies `.env.example` to `.env.local` when that file is missing, and adds a generated `AUTH_SECRET` and `INVITE_HASH_SECRET`.
2. It runs `bun install`.
3. It starts Postgres with `docker compose up -d --wait db`.
4. It applies the migrations.
5. It seeds the default verification topics.

`compose.yml` has one service: Postgres 16 with pgvector, published on host port 5433. Set `ECHO_DB_PORT` to use another port. Postgres is the only service you need. There is nothing else to start.

## Without Docker: mprocs

Run Postgres natively and start everything with mprocs, from `dembrane/mprocs.yaml`.

You need Bun, pnpm, mprocs, ffmpeg on your `PATH`, and Postgres 16 with pgvector on port 5432.

The one-time setup is in the README under "Run it without docker": create the `echo` role and database, create `.env.local` from the example on port 5432 with its own secrets, then install, migrate and seed. The role is a superuser so that the migrations can create the `vector` extension.

Then run `mprocs` from `dembrane/`. It starts four processes:

| Process | Port | Note |
|---|---|---|
| `api` | 8080 | Restarts on change. |
| `worker` | | Does not restart on change. Select it and press `r`. |
| `dashboard` | 5173 | Proxies `/api` to the API. |
| `portal` | 5174 | Proxies `/api` to the API. |

A fifth process, `migrate`, does not start on its own. Select it and press `s` after you pull new migrations.

## What local mode does differently

`APP_ENV=local` loads `packages/config/environments/local.ts`. With it:

- Uploaded files go to `.data/files` and audio to `.data/audio` on disk. The API serves them itself in place of presigned bucket URLs. You need no object storage.
- With no `MEDIA_URL`, ffmpeg runs inside the API and the worker. That is why ffmpeg must be on your `PATH`.
- With no `SENDGRID_API_KEY`, the API keeps emails in memory and the worker logs "mail not sent". No email leaves your machine.
- Cookies are not marked secure, because local runs on plain `http`.
- Webhooks may target private addresses, so you can point one at a server on your machine.

Language model features (transcription, summaries, chat, reports) call Google Vertex AI with Google application default credentials. `LLM_VERTEX_PROJECT` names the Google Cloud project that is billed. See [configuration and language model providers](../developer-external/configuration-and-llm-providers.md).

## Commands you will use

From `dembrane/platform`:

| Command | What it does |
|---|---|
| `bun run check` | Lint, types, the layer rule and the tests. Run it before you push. |
| `bun run test` | The tests, in parallel. |
| `bun run format` | Fixes lint and formatting with Biome. |
| `bun run db:generate` | Writes a migration from a schema change. |
| `bun run db:migrate` | Applies migrations to your local database. |
| `bun run config show <env>` | Shows the effective config values and where each came from, with secrets hidden. `diff <env> <env>` and `check` also exist. |
| `bun run packages check` | Checks the layer rule. `bun run packages write` regenerates `PACKAGES.md`. |
| `bun run staff:access list` | Lists staff. `grant` and `revoke` change it. |

From `dembrane/frontend`:

| Command | What it does |
|---|---|
| `pnpm lint` | Biome lint. |
| `pnpm exec tsc` | Type check. |
| `pnpm test` | The frontend tests (vitest). |
| `pnpm build` | Type check and build into `dist`. |
| `pnpm messages:extract`, `pnpm messages:compile` | Update the translation catalogs after you change interface text. CI fails when they are out of date. |

## Config in one paragraph

Every setting is declared once in `packages/config/src/schema.ts`. A value comes from the schema default, then the environment file for your `APP_ENV`, then the process environment, in rising precedence. Secrets may only come from the process environment, which locally means `.env.local`. Config is validated at boot: all problems are shown in one error and the process does not start. To add a key, declare it in the schema, override it per environment if needed, and read it as `config.<section>.<key>`. `bun run config check` fails when a key is declared but never read.

## Related

- [Architecture](./architecture.md)
- [Background jobs and schedules](./background-jobs-and-scheduler.md)
- [Deployment and releases](./deployment-and-releases.md)
- [Self-hosting](../developer-external/self-hosting.md)
- [Configuration and language model providers](../developer-external/configuration-and-llm-providers.md)
- [Contributing](../developer-external/contributing.md)
