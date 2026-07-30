# Event-loop corruption in Dramatiq actors

**Rule: never create and close an asyncio event loop inside a worker, and never call
`asyncio.run` from an actor. Go through `run_async_in_new_loop` in
`dembrane.async_helpers`, which owns one long-lived loop on a real OS thread. For
concurrency without async, use `gevent.pool.Pool` plus `dramatiq.group()`, on the
`network` queue only.**

The standing rules are in [`../../AGENTS.md`](../../AGENTS.md), "Dramatiq & Async
Rules". This page exists to record why they are worded the way they are, because the
short version ("no asyncio in actors") reads as superstition until you know what broke.

## What happened

`task_summarize_conversation` was failing at close to 100% in production: conversations
reached `is_finished` and `is_all_chunks_transcribed` but their `summary` stayed
`NULL`. `task_merge_conversation_chunks` failed alongside it. Two different exceptions:

- merge raised `RuntimeError: Event loop is closed`
- summarize raised `sniffio.AsyncLibraryNotFoundError`

## Mechanism

`run_async_in_new_loop` originally did what its name says: it created a fresh asyncio
loop per call, ran the coroutine, and closed the loop. Two consequences, one per
symptom.

**Closed loops orphan pooled clients.** The process-global async httpx client
(`async_directus`) binds its connection pool to whichever loop first used it. Once that
loop is closed, the pool's transports are dead, and the next call through the same
client raises `Event loop is closed`.

**Ephemeral loops under gevent corrupt sniffio's detection.** asyncio's notion of "the
running loop" is thread-local, and under `dramatiq-gevent` all greenlets in a worker
share one OS thread. Greenlets interleaving across short-lived loops left that
thread-local state inconsistent, so `sniffio` could not identify which async library
was running and raised `AsyncLibraryNotFoundError` inside library code that had no
reason to care.

## Fix

`fix(workers): repair summary/merge (asyncio-in-gevent), scheduler Redis drops, NUL
transcript writes` (10b9d25b, PR #712) replaced the per-call loop with a single
loop that runs for the lifetime of the process on a dedicated real OS thread; work is
submitted with `asyncio.run_coroutine_threadsafe`. Because the loop never closes, httpx
pools correctly and sniffio always sees a genuinely running loop, so `nest_asyncio` is
not needed on that path. The thread must be a real OS thread, obtained via
`gevent.monkey.get_original`, so its selector blocks only that thread and never the
gevent hub; gevent (>= 25) yields cooperatively while a greenlet waits on the
cross-thread `Future`. See `_ensure_background_loop` and `_run_async_once` in
`server/dembrane/async_helpers.py`.

`fix(workers): don't take nest_asyncio fallback under gevent` (12650b0a, PR #718)
closed a follow-on trap that the first fix introduced. PR #712 added a fallback: if
`asyncio.get_running_loop()` reports a loop, run nested on it via `nest_asyncio`, which
is right for the FastAPI server. Under `dramatiq-gevent` it misfires for exactly the
reason above, because one greenlet sees a loop that a different greenlet is driving,
drives it too, and the actor hangs until `TimeLimitExceeded`. The fallback is now gated
on `not _is_gevent_patched()`. The general lesson: `get_running_loop()` is not a
reliable answer to "am I inside async code" under gevent.

Later work (acf32619 PR #816, da0e7f16 PR #825) added self-healing: an
`AsyncLibraryNotFoundError` crossing `run_async_in_new_loop` resets the async clients
and the background loop and retries once, provided the caller passed a zero-argument
coroutine *factory* rather than a coroutine object. Coroutine objects are consumed by
their first await and cannot be retried. Prefer passing a factory.

## What the rules mean now

The function is still called `run_async_in_new_loop`, which is now a misnomer: it runs
on the shared loop, not a new one. Do not read the name as permission to make your own.

- **"No `asyncio` in Dramatiq actors"** means no bare `asyncio.run`, no
  `new_event_loop()`, no per-call loop lifecycle. It does not mean async code is banned
  from workers; `run_async_in_new_loop` is the supported route and is widely used.
- **`gevent.pool.Pool` is safe on the `network` queue only.** That queue runs under
  `dramatiq-gevent`; the CPU queue runs standard dramatiq with no monkey-patching, so a
  gevent pool there blocks a real thread instead of yielding. `report_generation.py`
  fetches transcripts through a pool and its actor is declared
  `queue_name="network"` for precisely this reason.
- **`gevent.sleep()`, not `time.sleep()`, in network-queue actors.** Monkey-patched
  `time.sleep` usually yields, but relying on the patch being in place makes the actor
  silently blocking wherever it is not.
- **Never reuse a loop-bound client across loops.** This is what turned a small loop
  bug into a total outage rather than a slow path.

## Validating a change here

gevent behaviour depends on monkey-patching happening before imports, so it cannot be
asserted from a normal test process. Run gevent paths in a subprocess that patches
first. Deploy to Echo Next and watch a real queue drain before cutting a release: PR
#718's hang was caught that way and not by any unit test.

## See also

- [`../../AGENTS.md`](../../AGENTS.md), "Dramatiq & Async Rules"
- [`../../server/AGENTS.md`](../../server/AGENTS.md), "Background task design"
- [validate-execution-not-construction.md](validate-execution-not-construction.md)
