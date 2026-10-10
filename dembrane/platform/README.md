# dembrane platform

The Bun backend for dembrane: five programs that deploy, built from the libraries in `packages/`.

## Run it

```sh
bun run setup        # Postgres in docker, dependencies, migrations
bun run dev          # API on :8080
bun --env-file=.env.local apps/worker/src/main.ts   # worker
bun run check        # lint, types, the layer rule, tests
```

## Run it without docker

`bun run setup` above runs Postgres in docker. To go without docker, run Postgres natively and start everything with [mprocs](https://github.com/pvolok/mprocs) from `dembrane/mprocs.yaml`.

You need bun (the version in `.bun-version`), pnpm, mprocs, ffmpeg on your `PATH` (with no `MEDIA_URL` the API and worker run it in-process), and Postgres 16 with pgvector on port 5432. [Postgres.app](https://postgresapp.com) ships pgvector.

One-time setup, from `dembrane/platform`:

1. Create the `echo` role and database. The role is a superuser, as it is in `compose.yml`, so migrations can create the `vector` extension.

   ```sh
   createuser --superuser echo
   psql postgres -c "alter role echo password 'echo'"
   createdb --owner=echo echo
   ```

2. Create `.env.local` from the example, on port 5432 instead of compose's 5433, with its own secrets:

   ```sh
   sed 's/:5433/:5432/' .env.example > .env.local
   echo "AUTH_SECRET=$(head -c 32 /dev/urandom | base64)" >> .env.local
   echo "INVITE_HASH_SECRET=$(head -c 32 /dev/urandom | base64)" >> .env.local
   ```

3. Install dependencies, migrate and seed:

   ```sh
   bun install
   bun run db:migrate && bun run seed:verification-topics
   (cd ../frontend && pnpm install)
   ```

Then run `mprocs` from `dembrane/`. It starts:

- **api** on http://localhost:8080, restarting on change
- **worker**, which does not restart on change; select it and press `r` to restart it
- **dashboard** on http://localhost:5173
- **portal** on http://localhost:5174

The dashboard and portal proxy `/api` to the API on 8080. **migrate** does not start on its own: select it and press `s` after pulling new migrations. Uploaded files go to `.data/files` on disk.

## Apps and packages

`apps/` holds the programs that deploy and run. Each has a `src/main.ts` that reads config, wires the packages together and starts.

- **api**: the HTTP server. Every namespace's routes are mounted in `apps/api/src/app.ts`.
- **worker**: runs queued jobs and schedules (the audio pipeline, analysis, reports, emails, billing timers).
- **media**: the ffmpeg service (below).
- **web**: serves the built dashboard and participant portal, and proxies `/api` to the API.
- **migrate**: runs before every rollout: schema migrations, the queue schema, database grants.

`packages/` holds libraries. A package never runs on its own; an app composes it.

## What media is, and why it is its own app

media is an ffmpeg service. It probes, converts, splits and merges audio and does nothing else: it has no database, no bucket credentials and no secrets, because callers hand it presigned URLs to read from and write to. It runs apart from the API and the worker because audio conversion is CPU-heavy native work. Cloud Run scales it from 0 to 10 instances, each running one conversion at a time, and a crash or an out-of-memory kills that one conversion, not the API or the worker. The worker's audio pipeline calls it over HTTP, and so does the API for an upload's duration and for merged audio downloads. The ffmpeg code itself lives in `packages/audio`; `apps/media` is only its HTTP shell. Locally, with no `MEDIA_URL`, the same code runs ffmpeg inside the calling process.

## The layers

Three layers, top to bottom. A dependency points down only.

1. **Apps** may import anything.
2. **Namespaces** are product areas: projects, conversations, chats, account, popcorn and so on. Each owns its routes, jobs, storage and business rules. A namespace imports capabilities. It imports another namespace only when its `package.json` lists that namespace under `dembrane.allow` with a reason; the list is at the end of this file and shows where the lines are still blurred.
3. **Capabilities** are building blocks with no business rules: config, db, core, auth, access, queue, storage, llm, mail and so on. A capability never imports a namespace or an app.

`bun run packages check` enforces this in CI (it is part of `bun run check`). Each package states its layer and a one-line description in its `package.json`; the list in [PACKAGES.md](PACKAGES.md) is generated from those and from the imports.

```mermaid
flowchart TB
  subgraph apps [Apps: what deploys]
    api
    worker
    media
    web
    migrate
  end
  subgraph ns [Namespaces: product areas]
    present --> popcorn & map
    popcorn & map --> analysis
    agentic --> chats & projects
    conversations & reports --> projects
    account & tenancy & staff & training --> billing
    rest["and 9 more, such as canvas, webhooks, pricing, feedback"]
  end
  subgraph cap [Capabilities: no business rules]
    http --> access --> db --> core
    tools["queue, llm, storage, mail, realtime, auth, ratelimit, audio, config, observability ..."]
  end
  api & worker --> ns
  ns --> cap
  media --> tools
  web & migrate --> cap
```

The diagram draws the main arrows between namespaces; the full list of allowed ones is in [PACKAGES.md](PACKAGES.md). Every namespace uses the capabilities.

## Where to start reading

- **Add a route.** Open a small namespace such as `packages/webhooks/src`: `routes.ts` returns a Hono router, its handlers call `service.ts`, which calls `storage.ts`. Check the caller with `projectFor` from `@dembrane/http`. The API mounts the router in `apps/api/src/app.ts`.
- **Add a background job.** Define it with `defineJob` in the namespace's `jobs.ts` (see `packages/webhooks/src/jobs.ts`). Add it to the list the API starts in `apps/api/src/main.ts` so it can be enqueued, and register its handler in `registrations` in `apps/worker/src/jobs.ts`. Services enqueue through a `JobSink` from `@dembrane/queue`.
- **Add a config key.** Declare it in `packages/config/src/schema.ts` with `key(ENV_NAME, schema, { description })`, override it per environment in `packages/config/environments/*.ts`, and read it as `config.<section>.<key>`. `bun run config check` fails when a key is declared but never read.

A new package needs `description` and `dembrane.layer` in its `package.json`; then run `bun run packages write` to refresh [PACKAGES.md](PACKAGES.md).

## Packages

Every app and package with its one-line description, what uses it and the imports allowed between namespaces: [PACKAGES.md](PACKAGES.md).
