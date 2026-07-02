---
title: Background jobs & scheduler
description: The Dramatiq queues, the no-asyncio-in-actors rule, every scheduled job, and the Redis keys that coordinate them.
audience: developer-internal
---

# Background jobs & scheduler

Anything slow or fan-out-shaped in dembrane runs as a background task, not inline in the API.
Tasks are *Dramatiq actors* (`echo/server/dembrane/tasks.py`) brokered by Redis; periodic
work is dispatched by *APScheduler* (`echo/server/dembrane/scheduler.py`). This page is the
operational reference: the queues, the rules for writing actors safely, and the full list of
scheduled jobs. It pairs with [the processing pipeline](./processing-pipeline.md), which walks
the transcription fan-out in detail.

## The two queues

| Queue | Runner | For |
|---|---|---|
| `network` | `dramatiq-gevent` (gevent, many threads) | I/O-bound work: transcription, correction, finalise, summarise, reports, webhooks, emails, all the scheduled jobs. The vast majority of actors. |
| `cpu` | `dramatiq` (single thread, single process) | Compute-bound work - currently `task_merge_conversation_chunks`. Kept off the gevent pool so it doesn't starve I/O greenlets. |

Locally (`mprocs.yaml`):

```
workers:      uv run dramatiq-gevent --queues network --processes 1 --threads 10 dembrane.tasks
workers-cpu:  uv run dramatiq --queues cpu --processes 1 --threads 1 dembrane.tasks
scheduler:    uv run python -m dembrane.scheduler
```

In production the equivalents are `prod-worker.sh`, `prod-worker-cpu.sh` and
`prod-scheduler.sh` in `echo/server/`.

Actors declare their queue and priority, e.g.
`@dramatiq.actor(queue_name="network", priority=0)`. Lower priority numbers run first;
transcription/correction sit at `priority=0`, finalise at `20`, summarise at `30`, reports at
`50`.

## The cardinal rule: NO asyncio inside actors

The `network` workers run under *gevent*. You *must not* run a bare asyncio event loop
inside an actor - it will conflict with gevent's monkey-patching and hang or crash. Instead use
the helpers in `echo/server/dembrane/async_helpers.py`:

- `run_async_in_new_loop(coro)` - run a coroutine to completion from sync actor code. This is the workhorse for calling the async Directus client / async I/O from inside a Dramatiq actor.
- `run_in_thread_pool(func, *args)` - offload blocking work onto a real thread-pool thread (escapes the gevent loop when you need a true OS thread).
- `safe_gather(...)` - gather coroutines on the worker's loop with optional `return_exceptions`.

The helpers detect whether gevent has monkey-patched the process (`_is_gevent_patched`) and
spin up a background loop on a real (un-patched) thread when needed (`_ensure_background_loop`,
`_real_thread_class`). You don't normally call those directly - call `run_async_in_new_loop` /
`run_in_thread_pool` and let them do the right thing.

> [!WARNING]
> If you write `asyncio.run(...)` or `asyncio.get_event_loop().run_until_complete(...)` inside
> an actor, expect breakage. This caused a production incident where summaries and merge broke
> under a shared background loop. Route async work through `async_helpers`. (See `echo/AGENTS.md`
> and `echo/server/AGENTS.md`.)

Note the API process itself uses a *custom asyncio uvicorn worker* and avoids `uvloop` for
`nest_asyncio` compatibility - the actor rule is specifically about the gevent *worker*
processes, not the API.

## The flag invariants

Several actors and catch-up jobs key off three flags. There is *one source of truth per flag*
 - fix the flag-setting logic, don't paper over it with catch-up workarounds:

- `is_finished` - the user/system marked the conversation done.
- `is_all_chunks_transcribed` - ready for summarisation (true for *audio and text*).
- `summary != null` - summarisation complete.

## The processing actors

These drive the [pipeline](./processing-pipeline.md):

| Actor | Queue / priority | Role |
|---|---|---|
| `task_transcribe_chunk` | network / 0 | Transcribe one chunk (AssemblyAI or LiteLLM). |
| `task_correct_transcript` | network / 0 | Gemini correction + PII redaction; decrements the pending-chunks counter. |
| `task_finalize_conversation` | network / 20 | Fan-in when the counter hits 0; idempotent via Redis lock. |
| `task_merge_conversation_chunks` | *cpu* / 10 | Stitch chunks into the full transcript (`store_results=True`). |
| `task_summarize_conversation` | network / 30 | Gemini summary. |
| `task_finish_conversation_hook` | network / 30 | Post-finish hook (webhooks, etc.). |
| `task_process_conversation_chunk` | cpu / 0 | Chunk processing. |
| `task_create_view` / `task_create_project_library` | network / 50 | Library & analysis generation. |
| `task_create_report` → `task_report_summarization_done` → `task_create_report_continue` | network / 50 | Two-phase report generation. |
| `task_dispatch_webhook` | network | Deliver a webhook with retries. |
| `task_send_invite_email` / `task_send_downgrade_email` | network | Transactional email (SendGrid HTTP, via `email.py`). |

## The scheduled jobs

APScheduler is a `BlockingScheduler` pinned to *UTC* with a `MemoryJobStore`. Each job's
`func` is a `*.send` reference, so the scheduler doesn't *run* the work - it *enqueues* the
Dramatiq actor onto the broker and returns immediately. Defaults: `misfire_grace_time=60`,
`coalesce=True` (so a job that wakes late still runs once, rather than being silently skipped - 
this matters on loaded hosts/WSL2).

| Cron | Actor enqueued | What it does |
|---|---|---|
| `*/2 min` | `task_collect_and_finish_unfinished_conversations` | Catch-up: finish conversations the fan-in missed. |
| `*/3 min` | `task_reconcile_transcribed_flag` | Reconcile `is_all_chunks_transcribed`. |
| `*/5 min` | `task_catch_up_unsummarized_conversations` | Summarise anything finished-but-unsummarised. |
| `*/5 min` | `task_check_scheduled_reports` | Dispatch due scheduled report generation. |
| `:00 (hourly)` | `task_expire_workspace_tiers` | Downgrade workspaces whose `tier_expires_at` elapsed back to Free. |
| `:00 (hourly)` | `task_send_tier_expiry_prewarning` | Send 3-day pre-warning emails for expiring tiers. |
| `*/5 min` | `task_reconcile_pending_billing` | Activate billing accounts whose first payment cleared (missed Mollie webhook/return). |
| `*/15 min` | `task_reconcile_subscription_seats` | Re-price active subscriptions to match live seat counts. |
| `09:00 UTC daily` | `task_flush_email_digests` | Flush batched email-notification digests. |

> [!NOTE]
> The catch-up/reconcile jobs are a *safety net* for the pipeline's Redis coordination - not
> the mechanism. If conversations routinely need catching up, the root cause is in the actor
> flow (a missed counter decrement, a dropped webhook), not the cron. Fix it there. See
> [the processing pipeline](./processing-pipeline.md#coordination-idempotency-redis).

### Billing / tier / seat reconciliation

The hourly tier jobs implement the Free-tier downgrade machinery (ADR 0005, building on
ADR 0001's over-cap model): `task_expire_workspace_tiers` reverts elapsed tiers and notifies;
`task_send_tier_expiry_prewarning` warns 3 days out. Reverse trials granted by staff
(Changemaker, 1 month) auto-revert through this path. `task_reconcile_pending_billing` and
`task_reconcile_subscription_seats` keep Mollie state and seat pricing honest between webhooks.
See [tiers & billing](../../features/tiers-and-billing.md) and
[managed & offline billing](../staff/managed-and-offline-billing.md).

### Email digest batching

Notifications are individual for the first few per day, then batched: the first 5 in 24 h go out
individually, after which they're rolled into a daily digest flushed at *09:00 UTC* by
`task_flush_email_digests`. The throttle logic is `email_throttle.py`; transactional sending is
`email.py` (SendGrid HTTP API - note Directus's own emails use a *separate* SMTP path; don't
conflate them, see `echo/server/AGENTS.md`).

## Coordination keys (recap)

The actors coordinate through Redis keys under the `coord:` prefix
(`echo/server/dembrane/coordination.py`): `pending_chunks`, `processing_started`,
`finalize_in_progress`, `finish_in_progress`, `chunk_decremented`. The agent service uses its
own `agentic:run:*` lease/cancel keys (see [chat & the agent service](./chat-and-agent.md)). The
full table is in [the processing pipeline](./processing-pipeline.md#coordination-idempotency-redis).

> [!IMPORTANT]
> The broker is Redis/Valkey. In production, watch for idle-timeout / eviction on the Valkey
> cluster - an evicted broker loses queued messages, which is exactly what the catch-up jobs
> exist to recover from. Treat broker memory and eviction policy as an operational concern.

## Adding a new job

1. Write the actor in `tasks.py` with an explicit `queue_name` (almost always `network`) and a sensible `priority`. Keep it idempotent - it may be retried or double-dispatched.
2. Use `run_async_in_new_loop` / `run_in_thread_pool` for any async or blocking work - never bare asyncio.
3. If it's periodic, add an `add_job` entry in `scheduler.py` referencing `dembrane.tasks:your_actor.send` with a `CronTrigger` and a stable `id`.
4. If it touches shared state across workers, add a Redis lock/counter in `coordination.py` and document it.

---

*Related*

- [The processing pipeline](./processing-pipeline.md)
- [Chat & the agent service](./chat-and-agent.md)
- [Architecture](./architecture.md)
- [Local development](./local-development.md)
