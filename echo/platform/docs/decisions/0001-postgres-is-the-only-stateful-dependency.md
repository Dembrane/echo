# 0001 Postgres is the only stateful dependency

**Decision.** Jobs, schedules, locks, rate limits and realtime fan-out live in Postgres:
pg-boss for jobs and cron, advisory locks, LISTEN/NOTIFY for server-sent events. Redis,
Dramatiq and APScheduler go.

**Why.** Redis connection drops caused the June P0s (scheduler could not enqueue, billing
jobs skipped). A job enqueued in the same transaction as the write that causes it cannot
be lost. One stateful service means one backup, one failover story, one thing to watch.

**Best practice followed.** Transactional outbox (swe_guidelines "The Work Queue"): pg-boss
stores jobs as rows claimed with `FOR UPDATE SKIP LOCKED`, with retries, expiry and
singleton keys. Handlers are idempotent on a key the producer sets.

**Against.** LISTEN/NOTIFY payloads cap at 8 KB and every listener holds a connection. We
send ids, not data, and one listener per API instance fans out in process. If job volume
ever outgrows Postgres (far beyond today's thousands per day), the queue package is the
seam to swap.
