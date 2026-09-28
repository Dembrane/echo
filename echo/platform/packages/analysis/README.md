# @dembrane/analysis

Typed, revisioned analysis objects produced by recipes, ported from
`dembrane/analysis`: the store, revisions, planner, registry, executor, snapshots, the
map view, the outbox and the built-in recipes (arguments, deduplicated_arguments,
tensions, stakeholders, popcorn, the integration fixture and the fact-check assessment),
plus the 15 routes of `dembrane.api.v2.bff.analysis`.

## What runs where

| Python | Here |
|---|---|
| `request_run` in the API | `requestRun` in the API (unchanged: validate, plan, pin, create under the scope lock) |
| dramatiq `task_analysis_run` | DBOS workflow `analysis.run` (`jobs.ts`) |
| dramatiq `task_analysis_outbox_dispatch(event_id)` | DBOS workflow `analysis.outbox`, enqueued in the publishing transaction |
| APScheduler minute sweep (`task_analysis_outbox_dispatch()`) | DBOS schedule `analysis.sweep`, every minute on one worker |
| `execute_inline` (a worker running a run in-process) | `executeInline` (fact-check assessments) |

## How the Python's guards map to DBOS

**Leases stay.** A lease is not about which process runs a run; it decides whether a
writer may still touch a run's rows. A host cancels a run, a newer request publishes
first, a retry moves the run to a new attempt, or a legacy writer takes over the scope
(writer fence): every checkpoint rechecks the lease under the scope lock and refuses
once any of that happened. DBOS knows none of these, so the lease is kept in
`analysis_run` exactly as before. What changed is who holds it: the lease is derived
from the DBOS workflow id (`leaseFor`), so a workflow resumed after a crash re-enters
with the same lease and continues its own run, while a new workflow for a retried run
gets a new one.

**Crash recovery moved to DBOS.** Python recovered a dead worker's run by letting its
lease expire (20 minutes), failing it in the sweep, and waiting for a host to retry.
Now the workflow's `execute` step is resumed by another worker within about a minute
(dead-executor detection in `@dembrane/queue`), with the same lease, and the recipe's own
completed steps (`analysis_step` rows, keyed by cache key) are reused instead of
recomputed: no model call is paid twice. `test/recovery.test.ts` kills a worker with
`kill -9` inside an extraction and proves it.

**Recipe steps stay in `analysis_step`.** They are the domain's checkpoints and also a
cross-run cache: a later run reuses a completed step with the same cache key anywhere
in the project. DBOS step checkpoints cannot serve other runs, and recipes run their
steps concurrently, which DBOS steps must not. So a run is two kinds of DBOS step:
`execute-<n>` (the recipe under the lease, 60-minute timeout, the old tick limit) and a
durable sleep when the recipe is at its running limit (`max_running`), replacing
dramatiq's delayed redelivery.

**The outbox stays as the record, dispatch became a workflow.** `analysis_outbox` rows
are written in the transaction that publishes (runs, authored revisions, snapshots),
exactly as before: they order publications per scope and record which consumer ran.
Python enqueued the dispatch after commit, best effort, and relied on the minute sweep
for anything lost. Now `AnalysisStore.afterPublication` enqueues `analysis.outbox`
inside that same transaction, so a committed publication always has its dispatch. The
dispatch claims the event, runs each consumer (`live_event`, `wake_waiting`,
`view_snapshots`) as its own DBOS step and marks it on the row, then settles it. A
failed consumer still puts the event back with the persisted attempt count and backoff,
and still goes `dead` after 12 attempts; the sweep picks those up.

**Request keys stay.** `analysis_request_key` is the HTTP idempotency contract (the same
client key, or the same automatic dependency key, always answers with the same run),
resolved under the scope lock with the request order. DBOS deduplication only covers
enqueueing: `analysis.run` is enqueued with the run id as its dedup key, so a second
dispatch of a queued or running run joins the existing workflow instead of starting one.

## Hashes and the Python rows

Rows are shared with the Python stack until cutover, and content hashes decide reuse,
so `hashing.ts` reproduces c14n-v1 byte for byte (checked against Python output in
`test/hashing.test.ts`). JSON cannot tell `1.0` from `1`; schema fields Python holds as
floats are normalised into `PyFloat` so they hash as Python did. Payload validation
(`schema.ts`) returns pydantic's error texts in pydantic's order, since hosts read them in
422 details. Recipe definitions are checked against the Python registry's metadata
(`test/registry.test.ts`).

## Known limits

- A value that is an integral float inside a free-form dict (`coverage`) read back from
  the database hashes as an integer; only a re-hash of such a row can differ from Python's.
- The popcorn bundle's view hook (Python `dembrane.popcorn.bundle`) belongs to the popcorn
  port; `analysisRuntime` takes extra `snapshotHooks` for it.
