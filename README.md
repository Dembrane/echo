# echo

dembrane's platform: the dashboard where hosts run projects, the portal where participants
record conversations, and the API and workers behind them.

## Layout

- `echo/platform`: the Bun API, worker, media service, migrations and web server (`apps/`), their packages (`packages/`), infrastructure (`infra/`) and the parity harness against the previous stack (`parity/`).
- `echo/frontend`: the dashboard and participant portal (React, Vite).
- `echo/brand`: logos and style assets.
- `echo/demos`: the example synthetic demos the accounts seed reads.
- `dembrane-go`: the iOS app.
- `skills`: operating guides for agents working on dembrane.

## Run the platform

```sh
cd echo/platform
bun run setup        # Postgres in docker, dependencies, migrations
bun run dev          # API on :8080
bun --env-file=.env.local apps/worker/src/main.ts   # worker
bun run check        # lint, types, tests
```

## Run the frontend

```sh
cd echo/frontend
pnpm install
pnpm dev             # dashboard on :5173, /api proxied to :8080
pnpm participant:dev # portal on :5174
```
