# Wave 13 Report - Prod Summaries sniffio AsyncLibraryNotFoundError

## Summary

Implemented a durable guard for the production summary failure where long-lived
network workers could get stuck failing every `task_summarize_conversation` with
`sniffio.AsyncLibraryNotFoundError`.

The existing code already had the main structural fix: Dramatiq/gevent sync
actors submit async work to a single real-thread background asyncio loop, and
`AsyncDirectusClient` caches `httpx.AsyncClient` instances per running event
loop. This wave completed the missing production hardening: the summary actor
now detects `sniffio.AsyncLibraryNotFoundError`, discards cached async Directus
clients, resets the shared background loop, and retries once before letting the
normal Dramatiq retry path handle persistent failures.

## Mechanism

`task_summarize_conversation` is a sync Dramatiq actor on the `network` queue. It
calls `run_async_in_new_loop(summarize_conversation(...))`; in the
Dramatiq/gevent worker this must not run asyncio directly in the actor greenlet.

The awaited `httpx.AsyncClient` request in the observed production traceback is
from `dembrane.directus_async.async_directus`, reached early in
`summarize_conversation` for the locked-conversation/tier gate:

1. `task_summarize_conversation`
2. `run_async_in_new_loop`
3. `summarize_conversation`
4. `async_directus.get_item("conversation", conversation_id)`
5. `httpx.AsyncClient.request`

The LiteLLM summary generation in this endpoint is not the awaited async-httpx
trace: it runs via `run_in_thread_pool(generate_summary, ...)`, and
`generate_summary` uses the sync LiteLLM router path.

The wrapper frame from the production traceback,
`rv = await real_send(self, request, **kwargs)`, is Sentry's httpx integration.
`sentry_sdk.integrations.httpx` patches `AsyncClient.send` and contains that
exact wrapper. It is instrumentation around the failing request, not the owner
of the poisoned connection pool.

The failure mode is consistent with an async HTTP client/connection pool being
kept past the async context it was bound to. When httpcore closes expired
keepalive connections, it enters `AsyncShieldCancellation`; sniffio then calls
`current_async_library()`. If that close happens from a corrupted/non-running
async context, sniffio cannot detect asyncio and raises
`AsyncLibraryNotFoundError`. Once a module-level async client keeps reusing that
poisoned pool, every subsequent summary can fail almost immediately until the
pod is recycled.

## Changes

- `echo/server/dembrane/async_helpers.py`
  - Tracks the real background-loop thread.
  - Treats a loop as reusable only if it is open, running, and backed by a live
    thread.
  - Adds `reset_background_loop(reason)` so poisoned workers can force the next
    async call onto a new loop.

- `echo/server/dembrane/directus_async.py`
  - Adds `AsyncDirectusClient.reset_clients()` to discard cached `httpx`
    clients synchronously during recovery.

- `echo/server/dembrane/tasks.py`
  - Detects `sniffio.AsyncLibraryNotFoundError` through exception chaining.
  - On that specific error in `task_summarize_conversation`, logs loudly,
    discards cached async Directus clients, resets the background loop, and
    retries the summary once.
  - Preserves existing behavior for tier-locked 402s and ordinary retriable
    failures.

- Tests
  - Background loop reset/recreation.
  - Async Directus cached-client discard.
  - Summary actor self-heal/retry for sniffio failure.

## Verification

Passed:

```bash
cd echo/server
uv run pytest tests/test_async_helpers.py tests/test_directus_retry.py tests/test_tasks_summarize_tier_lock.py
uv run pytest tests/api/test_conversation.py
uv run ruff check .
```

Results:

- `25 passed` for async helpers, Directus retry, and summary actor tests.
- `2 passed` for `tests/api/test_conversation.py`.
- `ruff check .` passed.

Notes:

- `tests/test_async_helpers.py::test_run_async_in_new_loop_same_thread_id_concurrent`
  still emits the pre-existing pytest unraisable warning caused by deliberately
  monkeypatching `threading.get_ident` to simulate gevent same-thread IDs.
- `tests/api/test_conversation.py::test_summarize_conversation` still emits
  LiteLLM async service-logging teardown warnings, but the test passes.

## Remaining Risk

The guard is intentionally scoped to the summary actor and the known awaited
async client on its path. If another long-lived module-level async HTTP client
is introduced into this actor path later, it should either follow the same
per-loop cache pattern or be explicitly reset by the same recovery hook.
