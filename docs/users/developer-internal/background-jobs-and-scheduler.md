---
title: Background jobs and schedules
description: How dembrane runs background work on the Postgres queue. Defining and enqueuing a job, single-step jobs and durable workflows, recovery after a crash, cron schedules, and how to add a job.
audience: developer-internal
---

# Background jobs and schedules

Anything slow runs as a job in the `worker` app. Jobs and schedules run on DBOS, which keeps its state in Postgres, so there is no broker to run. The API enqueues. The worker executes.

The queue code is `dembrane/platform/packages/queue/src`. Every job the worker runs is registered in `registrations` in `dembrane/platform/apps/worker/src/jobs.ts`. That list is the source of truth.

## A job, start to finish

1. Define it in the namespace that owns it: `defineJob(name, schema, options)`. The schema is checked on enqueue and on receipt.
2. Enqueue it from a service through a `JobSink`. Pass your database transaction and the job exists only if the transaction commits.
3. The worker registers a handler for it, then calls `queue.run()`.

Defaults for a job: 5 retries, 10 seconds delay, doubling backoff, 15 minutes per attempt. Pass options to `defineJob` to change them.

Useful enqueue options, from `EnqueueOptions` in `packages/queue/src/queue.ts`:

| Option | Effect |
|---|---|
| `tx` | Enqueue inside the caller's transaction. |
| `singletonKey` | At most one queued or running job per key. |
| `startAfter` | Run later. |
| `workflowId` | A second enqueue with the same id returns the first run, so a repeated trigger does nothing. |

The API holds an enqueue-only client. It never executes jobs.

## Two kinds of handler

| Registered with | What it is | Retries |
|---|---|---|
| `queue.work` | One step. | The whole handler is retried as the job definition says. |
| `queue.workflow` | A durable multi-step flow. The handler calls `step()` for each side effect and each result is checkpointed in Postgres. | Retries belong to the steps. The job's `expireInSeconds` bounds the whole run. |

Rules for workflows:

- A step can run twice if a crash lands in the middle of it. Make each step idempotent at its side effects.
- After a crash a workflow resumes at its first unfinished step, on any worker. Checkpointed steps are not run again.
- Changing the order or number of steps in a workflow needs a bump of `WORKFLOW_VERSION` in `packages/queue/src/queue.ts`. A crashed workflow resumes only under the version that started it.

[The processing pipeline](./processing-pipeline.md) is the best worked example: `packages/conversations/src/pipeline/workflows.ts`.

## Recovery and concurrency

Each worker writes a heartbeat every 10 seconds. A worker that is silent for 60 seconds is presumed dead, and its unfinished workflows are resumed on their queues, where any live worker picks them up. So you can run more than one worker safely.

Each handler is registered with a concurrency: how many jobs of that kind one worker instance runs at once. Webhook deliveries run 20 at once because they wait on other people's servers. The pipeline's values are on the pipeline page.

## Schedules

A schedule is a cron expression registered with `queue.schedule`.

- Each tick runs once across all worker instances.
- The default timezone is `Europe/Amsterdam`. Billing and the forwarding jobs use UTC.
- Missed ticks are not replayed.

The worker registers 23 schedules in release 3.1.0. The main ones, by area:

| Area | Job names | How often |
|---|---|---|
| System | `system.heartbeat` | Every minute. It logs one line. Its absence is the signal that the worker pool or the queue is down. |
| Conversations | `conversations.finish-idle`, `conversations.summary-catch-up` | Every 2 and every 5 minutes. |
| Reports | `reports.scheduled`, `reports.backfill-scheduled` | Every minute and every 5 minutes. They start the scheduled reports whose time came. |
| Billing | `billing.reconcile-pending`, `billing.reconcile-seats`, `billing.expire-tiers`, `billing.tier-prewarning`, `billing.overage-close` | From every 2 minutes to hourly. They keep each subscription's amount on its seat count, downgrade accounts whose tier expired, warn admins three days before a paid tier lapses, and close overage episodes. |
| Workspaces | `tenancy.scheduled-tasks`, `tenancy.expire-staff-support` | Every minute and every 15 minutes. They run the staff support access timers. |
| popcorn | `popcorn.scheduled-ticks`, `popcorn.reconcile-ticks` | Every minute. |
| Canvas | `canvas.scheduled-ticks`, `canvas.reconcile-ticks` | Every minute and every 5 minutes. |
| Analysis | `analysis.sweep` | Every minute. It picks up analysis work that no commit enqueued. |

The others include jobs that forward items to the dembrane team and jobs that keep customer account tasks and legal texts current. Read `registrations` for all of them.

`BILLING_CUSTOMER_JOBS` is on in production only. Outside production the scheduled billing jobs may not email customers or change their tier.

### One-shot timers

A cron schedule cannot say "run this once, at that time". For that there is the `scheduled_task` table: a namespace books a row for a time, and a schedule that runs every minute claims the rows that are due. Scheduled reports, staff support timers, and popcorn and canvas ticks work this way. The shared SQL is in `packages/queue/src/scheduled-tasks.ts`.

## Jobs that are not schedules

The jobs you will meet most:

| Job | Namespace | What it does |
|---|---|---|
| `conversations.chunk`, `conversations.finish`, `conversations.finalize`, `conversations.summarize` | `conversations` | The audio pipeline. |
| `reports.generate`, `reports.notify-subscribers` | `reports` | Writes a report, and emails the participants who asked to be told. |
| `webhooks.dispatch` | `webhooks` | Delivers one webhook. |
| `account.send-email`, `tenancy.email` | `account`, `tenancy` | Sends email. |
| `agentic.turn` | `agentic` | Starts one assistant turn. |
| `analysis.run`, `analysis.outbox`, `map.group`, `map.fact_check`, `popcorn.tick`, `canvas.tick` | `analysis`, `map`, `popcorn`, `canvas` | Analysis runs, maps, and the ticks of popcorn and canvases. |

To find every job, search for `defineJob` under `packages/*/src`.

## Add a job

1. Define it with `defineJob` in the namespace's `jobs.ts`. `packages/webhooks/src/jobs.ts` is a small example.
2. Add it to the list the API starts in `apps/api/src/main.ts`, so the API can enqueue it.
3. Register its handler in `registrations` in `apps/worker/src/jobs.ts`.

A job name is lowercase and starts with a letter. Existing names follow `<area>.<what-it-does>`, such as `webhooks.dispatch`.

## Watching the queue

- `system.heartbeat` logs one line a minute from exactly one worker.
- The worker logs queue depth every minute.
- `/ready/worker` on the API answers whether a worker heartbeat is recent.

## Related

- [The processing pipeline](./processing-pipeline.md)
- [Architecture](./architecture.md)
- [Chat and the assistant](./chat-and-agent.md)
- [The data model](./data-model.md)
- [Local development](./local-development.md)
- [Webhooks](../developer-external/webhooks.md)
