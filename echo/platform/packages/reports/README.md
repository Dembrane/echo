# @echo/reports

The dashboard's report reads and metric writes under `/api/v2/bff` (list, detail, timeline
bundle, metric list, metric insert) and report generation: the handler of the
`reports.generate` job that `@echo/projects` enqueues inside the transaction that creates
the report, plus the runner that fires scheduled reports.

## Generation: Python to DBOS

Python generated a report in two Dramatiq actors glued by Redis:

| Python | Here |
|---|---|
| `task_create_report` (phase 1): draft guard, scheduled to draft, fan summaries out | step `guard`: the same guard, the conversation checks and the `summarizing` progress event |
| `dramatiq.group` of `task_summarize_conversation` with a `GroupCallbacks` completion callback | one step `summarize:<conversation id>` per missing summary, run in order inside the workflow; each is retried three times with backoff and checkpointed, so a resumed workflow never asks the model for a summary it already wrote |
| Redis key `report:<id>:params` carrying language and instructions to phase 2 (one hour TTL) | the workflow's own payload; nothing expires |
| `task_report_summarization_done` reading the key and sending phase 2 | the next step, reached when the summary steps return |
| `task_create_report_continue` (phase 2): draft guard, prompt, model call, save | step `generate` (guard, prompt building, model call with three tries on rate limits and outages) and step `save` (re-checks draft, then `archived`, content, `date_created`) |
| notification, webhook and PostHog calls after the save | steps `notify` and `webhook`; the PostHog capture is a structured log line (`signal: analytics`) because the platform has no analytics capability yet |
| Redis pub/sub `report:<id>:progress` | `pg_notify` on `REPORT_PROGRESS_CHANNEL`, which `@echo/projects` streams to the report page |
| `ProcessingStatusContext` rows `task_create_report.*`, `task_create_report_continue.*` | the same rows, written when each phase ends |
| dramatiq `time_limit` and `REPORT_GENERATION_TIMEOUT` | step timeouts: 2 minutes for the guard, 10 minutes per summary, 20 minutes for generate (a model call itself is capped at 5 minutes) |

A crash resumes at the first unfinished step on any worker (see
`test/recovery.test.ts`, which kills a worker inside `generate` and checks the summary is
not produced twice). Each step is idempotent at its side effects: the status guards make a
repeated `save` or `failed` a no-op, and a repeated summary step finds the summary written.

Error handling matches Python's: a `ReportGenerationError` (no conversations, no content,
the model's refusals) sets `status = error`, `error_code = GENERATION_FAILED` with the same
message, publishes `failed` and notifies the creator; anything else sets
`UNEXPECTED_ERROR` and fails the workflow, which queue health counts.

Deliberate difference: a summary that still fails after its retries no longer stalls the
report. Python's group callback fired only when every summary task succeeded, so one
broken conversation left the report a draft forever; here the report is made from the
conversations that have a summary.

## Summaries

`summarizeConversation` ports `task_summarize_conversation` and `summarize_conversation`
(summary, AI title, draft tags, the tier-lock skip, the `[No transcript available]`
marker, the `conversation.summarized` webhook) because the conversations namespace has not
moved yet. It is injected as a `Summarizer`, so that namespace replaces it without touching
the workflow. Not ported: the Redis in-progress lock, which only stopped two Dramatiq
triggers from paying twice; the workflow's step checkpoint does that for reports.

## Scheduled reports

`reports.scheduled` claims due `generate_report` rows of `scheduled_task` every minute (as
`packages/tenancy` claims its own types), moves a still-scheduled report to draft and
enqueues its generation in the same transaction. `reports.backfill-scheduled` is
`task_check_scheduled_reports`: every five minutes a scheduled report without a live task
row gets one.

## Routes

`fields` on `GET /reports` is hole M-7: only the report's own columns (or `*`) are served;
a relational path is a 400. `POST /report-metrics` keeps needing only `report:view` (L-5).

The metric insert records a row now. The old route handed Directus a uuid for the bigint
metric id and answered 500, so no metric was ever written through it; the parity
scenarios mark that difference.
