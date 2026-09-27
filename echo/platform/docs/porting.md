# Porting a namespace

How a group of Python routes, jobs and schedules moves into a namespace package with
proven parity. Read ARCHITECTURE.md, docs/decisions/, docs/access-model-current.md
(sections 2, 5, 6, 7 for your routes) and packages/account (the reference port) first.

## Scope

Your routes are listed in `~/server/data/echo-migration/endpoints.txt` under the routers
you were given. For each one, read the Python handler and everything it calls, and port
the behaviour exactly: path, method, query and body validation, status codes, response
fields and their order-independent values, error `detail` texts, and side effects (rows
written, jobs enqueued, emails, webhooks). Port the Dramatiq actors and APScheduler jobs
your routes trigger or own (`dembrane/tasks.py`, `dembrane/scheduler.py`) as queue jobs in
the same package.

## Package shape

```
packages/<ns>/src/routes.ts    Hono sub-app. Parse and validate input, call the service, shape output. No SQL, no access rules.
packages/<ns>/src/service.ts   Operations. Take the caller (Signed from @echo/http) first. Pure where possible.
packages/<ns>/src/storage.ts   Drizzle queries only.
packages/<ns>/src/jobs.ts      Jobs (defineJob + queue.work) and durable workflows (workflow + step from @echo/queue).
packages/<ns>/test/            Unit tests for rules and services.
parity/scenarios/<ns>.ts       Parity scenarios for every route.
```

Register routes with one line in `apps/api/src/app.ts`, jobs with one registration in
`apps/worker/src/jobs.ts`, and add the package to the root `tsconfig.json` references.
Those three edits, plus config keys in their own section of `packages/config/src/schema.ts`,
are the only shared files you touch.

## Rules

- Access only through `@echo/access` (`deps.access.project/workspace(who, id, policy)`).
  Never check roles by hand. If the Python's effective check differs from the preset
  intent (a hole in spec section 7), implement the intent and mark that scenario
  `differs: "<hole id>: <one line>"`.
- Errors: throw `@echo/core` errors with the exact `detail` the Python raises
  (`new ForbiddenError("...")`, structured details via the second argument).
- Directus semantics the Python relied on must be reproduced explicitly: default sort is
  by primary key; `limit: -1` means all rows; soft-deleted rows are filtered by the query,
  not by Directus; fields with Directus `special` values (see
  `echo/directus/sync/snapshot/fields/<collection>/<field>.json`: `date-created`,
  `date-updated`, `user-created`, `user-updated`, `uuid`) were filled by Directus and must
  now be set in code with the same values.
- New ids: `newId()` from `@echo/core` (the runner maps minted ids, so v7 vs v4 is fine).
- Money, time and randomness come in as arguments or dependencies so tests control them.
- External systems (language models, Mollie, email, object storage, PostHog) go through a
  capability package with an interface and a fake. Create the capability package if it
  does not exist yet, in `packages/<capability>`, with the fake used by tests.
- Comments say why and what the impact is, never how we got here. No em dashes anywhere.
  Match the existing style: small files, explicit types at boundaries, no `any`.

## Background work

Plain jobs: `defineJob` and `queue.work`, enqueued with `queue.enqueue(def, payload, { tx })`
inside the transaction that causes them. Multi-step flows that Python repairs with crons
(sagas, runs with phases): one `workflow` whose side effects happen in `step`s, started with
an id that makes a second start a no-op. Steps must be idempotent. Read
docs/decisions/0007-durable-workflows-with-dbos.md before writing a workflow.

## Proving parity

1. Start your API from your worktree on your own port:
   `APP_ENV=local PORT=<yours> DATABASE_URL=postgres://dembrane:dembrane@localhost:5440/dembrane AUTH_SECRET=parity-secret-parity-secret-parity-secret-00 bun apps/api/src/main.ts`
2. The old API is shared on :8100 (`parity/run-old-api.sh` if it is down). Never restart
   Directus or rebuild the parity stack.
3. If you add migrations, rebuild the template with `parity/prepare-platform-template.sh`
   while holding the lock: `flock /tmp/echo-parity.lock parity/prepare-platform-template.sh`.
4. Run `PARITY_NEW_URL=http://127.0.0.1:<yours> parity/run.sh <filter>`. It queues behind
   other runners. Failures leave both captures in `parity/.parity-out/`.
5. A route is done when its scenarios pass: success for each role that matters, the
   denials (anonymous, other tenant, too-low role), validation failures, and every side
   effect. Seeded users, orgs, workspaces and projects are in `parity/fixtures.ts`.

Routes that call a language model: compare structure, and list the generated fields in
`ignoreFields`. Routes needing audio in object storage: the parity stack has none; prove
them with integration tests against the filesystem storage and say so in your report.

## Before you report

`bun run check` (lint, types, tests) passes, `bun run config check` passes, commits are on
your branch with messages that say why. Report: each route with parity status (pass,
differs on purpose with the hole id, or not provable with the reason), jobs and schedules
ported, capability packages added, and anything you could not finish.
