# Coordination locks with no TTL froze conversations in "already in progress"

**Rule: a Redis lock is one `SET key value NX EX ttl`, never `setnx` followed by
`expire`. Every lock in `dembrane/coordination.py` goes through `_acquire_lock`. An
actor that holds a lock releases it before re-raising a transient error, and only if
this invocation acquired it.**

## What happened

Redis DB 2 on production accumulated `coord:*` keys with `TTL -1`, meaning no expiry.
Among them were `coord:summarize_in_progress:<conversation_id>` keys for conversations
that were finished, transcribed and had no summary. Every five minutes
`task_catch_up_unsummarized_conversations` selected them, enqueued
`task_summarize_conversation`, and the actor logged
`summarization already in progress, skipping` and returned. Nothing ever summarized
them and nothing wrote an error.

## Mechanism

Each lock was acquired in two round trips:

```python
was_set = client.setnx(key, "1")
if was_set:
    client.expire(key, ttl)
```

A worker killed between the two calls (pod restart, OOM, the gevent loop reset
described in [dramatiq-actor-event-loops.md](dramatiq-actor-event-loops.md)) leaves
the key set with no expiry. Nothing ever revisits it: the actor that owns the lock is
gone, the next actor sees the key and yields, and the scheduler re-enqueues the same
conversation forever. The pending chunk counter had the same shape with `incrby` then
`expire`, and its negative-count clamp used a bare `set` that stripped any TTL.

A second, quieter problem sat next to it. Actors that failed with a retryable error
kept their lock so that "the TTL would handle it". Dramatiq's default backoff puts the
first retries at 15, 30 and 60 seconds, all inside the 300 or 600 second lock TTL, so
each retry found the lock held, logged the skip and acked. Retries did no work.

## Fix

`_acquire_lock(client, key, ttl)` issues one `SET NX EX`. If the key is already held
and has no TTL, the helper gives it one and logs a warning, so an old orphan heals the
next time anything asks for that lock. The counter increments and expires inside one
transaction, and the clamp sets the key with the standard TTL.

`task_summarize_conversation`, `task_finalize_conversation` and
`task_finish_conversation_hook` track whether they acquired the lock and release it
before re-raising. A failure before acquisition, such as a Directus lookup error on a
duplicate task, must not release a lock another worker is working under. The lock is
what serializes a retry against a scheduler catch-up: whichever acquires first does the
work, the other yields. The "already done" check each actor runs first makes the later
arrival a no-op once the work has landed.

## What the fix does not do

The self-heal only fires when a key is requested again. Summarize, finalize and finish
locks are requested by the scheduler catch-ups (L3, L2 and L1 in `server/AGENTS.md`),
so those orphans heal within a few scheduler ticks of the release. Keys that only
event-driven flows request, and keys for conversations the schedulers no longer
select, do not. A one-off sweep at deploy time covers them. Match each pattern to the
TTL the code uses and leave the pending-chunk counters alone: expiring a counter for a
conversation still receiving chunks would drop its count.

```
coord:summarize_in_progress:*   EXPIRE 600
coord:finalize_in_progress:*    EXPIRE 300
coord:finish_in_progress:*      EXPIRE 300
coord:processing_started:*      EXPIRE 86400
coord:pending_chunks:*          leave as is
```

Never `DEL`: anything genuinely in progress finishes inside the TTL.

The lock has no ownership token. A lock that expires mid-run and is reacquired by a
second worker can be released by the first, and two workers can then run the same
step. The TTLs are long relative to the work, so this is rare, but it is not
prevented. It is left for a follow-up.

## Applying it to the next lock

1. Acquire through `_acquire_lock`. Do not call `setnx` or `set(..., nx=True)` directly.
2. Track acquisition in a local flag and release only under that flag.
3. If the actor checks "already done" before acquiring, releasing on failure is safe.
   If it does not, add that check before adding the release.
