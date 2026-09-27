# 0001 Postgres is the only stateful dependency

**Decision.** Jobs, durable workflows, schedules, locks, rate limits and realtime fan-out
live in Postgres: DBOS for jobs, workflows and cron (its tables in the `dbos` schema),
advisory locks, and LISTEN/NOTIFY for server-sent events. Redis, Dramatiq and APScheduler
go.

**Why.** Redis connection drops caused the June P0s (the scheduler could not enqueue, and
billing jobs were skipped). A job enqueued in the same transaction as the write that
causes it cannot be lost. One stateful service means one backup, one failover story, one
thing to watch.

**Best practice followed.** A transactional outbox (swe_guidelines, "The Work Queue"):
DBOS enqueues inside the caller's transaction (`enqueueInTransaction`), claims work across
workers through Postgres, retries steps with backoff, and deduplicates on a producer key.

**Against.** LISTEN/NOTIFY payloads cap at 8 KB and every listener holds a connection. We
send ids, not data, and one listener per API instance fans out in process. Very frequent
counters cost Postgres writes; the recording meter is measured before cutover, and a
`cache` package can put Memorystore behind the same interface if one path needs it.
