# @echo/canvas

Dynamic canvases: a living wall per canvas report that a background loop redraws from what
participants say. `/api/v2/bff/canvases` (12 routes) and the canvas tick.

## Shape

- `routes.ts`: the Hono sub-app, request validation in FastAPI's words.
- `service.ts`: the operations; `access.ts`: the access order the BFF used (reach the
  project, then the canvas flags, then the policy).
- `ledgers.ts`: the additive ledgers (quotes, concepts, crux, story, board, host items) and
  the tabbed HTML renderer. Only quotes found verbatim in a transcript enter a ledger, and
  the wall is rendered from the ledgers in code, so the model never writes visible HTML.
- `ticks.ts`: the tick in phases; `gather.ts`, `history.ts`, `sanitize.ts`: its reads and
  the checks before a generation is stored.
- `jobs.ts`: the tick workflow and its two schedules.

## The tick as a durable workflow

`canvas.tick` is a DBOS workflow (`queue.workflow`) of five steps: prepare, gather,
extract (the model calls), store, schedule-next. Each step has the 60-minute timeout the
Dramatiq actor had as its time limit. A worker that dies mid-tick is resumed by another at
the step it was in (see `test/tick.integration.test.ts`): the model calls of a finished
extract are not paid for again, and prepare's cadence window is not claimed twice.

How the Python mechanisms map:

| Python | Here | Why |
|---|---|---|
| `scheduled_task` row of type `canvas_tick`, claimed every minute by the generic runner, which sent a Dramatiq message | kept: the rows are the loop's visible, cancellable schedule (pause and stop cancel them). `canvas.scheduled-ticks` claims only `canvas_tick` rows (tenancy claims its own types) and enqueues one workflow per row with the row id as DBOS deduplication key | the row guards data (what is scheduled, cancelled, failed); the message only carried execution, which DBOS now owns |
| next tick inserted as a new `scheduled_task` row at the end of each tick | kept, in the `schedule-next` step, with an id derived from the workflow id | a replayed step inserts the same row, not a second tick |
| Redis `SET NX` per loop and cadence window (`canvas:tick:{loop}:{window}`) | a Postgres counter with capacity 1 through `RateLimiter` (`canvas_tick_window`), same window and TTL, failing open like the Redis call did | it guards data: two scheduled ticks in one window would store two generations |
| `task_reconcile_canvas_tick_tasks` every 5 minutes, rescuing stale `processing` rows | `canvas.reconcile-ticks` every 5 minutes, same rules | a loop that lost its next row still gets one |
| 60-minute actor time limit, no retries | step timeouts of 60 minutes, no step retries; a failed tick records an error generation and run, exactly as before | the loop's failure count and auto-pause depend on those rows |
| Redis `SET NX` for preview (10 s per project) and refresh (30 s per canvas) | `RateLimiter` over `platform_rate_limit`, capacity 1, 429 with the Python detail | Postgres is the only stateful dependency |
| Redis pub/sub nudge on `canvas:generation:{report}` | `pg_notify` through `@echo/realtime`; the stream reads the latest generation id when it forwards a nudge | same frames, one LISTEN connection per process |

Every row a tick writes (runs, generations, the next schedule row) has an id derived from
the workflow id and the phase, and is inserted with `on conflict do nothing`, so steps are
idempotent at their side effects.

## Deliberate differences

- The manual refresh starts the tick on the worker and answers `{"generation": "pending"}`
  at once; the Python ran the whole tick inside the request. Web services never do
  background work.
- The preview names the wall after the project. The Python read `body.name`, a field the
  preview body does not have, so every preview that reached the model answered 500.
- Migration `0005_canvas_ledgers` adds the eight `agent_loop.canvas_*` columns and
  `canvas_config_revision.tabs` that echo main's code reads and writes (its Directus
  migration `add_smart_loop_wave28_canvas_ledgers.py` was never applied). Without them
  Directus drops the tabs on write and returns no row for any read that names the
  columns, so the Python sees no loop and no config: config and loop read as null, loop
  routes answer 404 and host items 500. Parity marks exactly those scenarios.
- The unused full-document path of the tick (`skill.md`, taken only when no ledger state is
  passed) is not ported: every caller passes ledger state.
