# Brief: Wave 13 - prod incident: summaries fail with sniffio AsyncLibraryNotFoundError

LIVE PRODUCTION INCIDENT, currently mitigated by pod recycling. Root-cause and
fix it durably. Branch: sameer/prod-summaries-sniffio (off main c7936764).
Read echo/server/dembrane/async_helpers.py, tasks.py
(task_summarize_conversation and its call path), directus_async.py (the
per-event-loop client fix), and echo/server/AGENTS.md Dramatiq rules first.

## Observed facts (prod, 2026-07-08, image 1e0362e1 = 2026-06-24 build)

- Long-lived network-queue worker pods DEGRADE: after ~24h+ of uptime, EVERY
  task_summarize_conversation fails in ~0.003s with:
  sniffio._impl.AsyncLibraryNotFoundError: unknown async library, or not in
  async context
- Traceback tail: an AWAITED httpx async request ->
  httpcore/_async/connection_pool.py handle_async_request ->
  _close_connections -> AsyncShieldCancellation.__init__ ->
  sniffio.current_async_library() raises. Note the wrapper frame
  `rv = await real_send(self, request, **kwargs)` (monkeypatched
  AsyncClient.send - identify which instrumentation does this: sentry,
  posthog, langfuse, litellm?).
- One pod started failing at 01:05 UTC after ~21h healthy; another (20h old)
  was also failing (118 errors/15min). FRESH pods are 100% clean. Deleting the
  poisoned pods restored summaries (fleet clean at 0 errors after recycle).
- Two pods poisoned simultaneously-ish suggests a common trigger (deploy? a
  specific poison-pill task? memory pressure? HPA churn interaction?).
- The failure point (_close_connections of EXPIRED keepalive connections)
  suggests a long-lived shared httpx.AsyncClient whose pool holds connections
  created in an earlier context; the first request after some idle/expiry
  boundary tries to close them and dies. Compare with the
  AsyncDirectusClient fix in directus_async.py (_clients_by_loop keyed by
  running loop id) - the same disease may live in OTHER shared async clients
  used by the summarize path (litellm? runpod? the LLM router? embedding?).

## Task

1. REPRODUCE or at least pin the mechanism: trace task_summarize_conversation
   from Dramatiq (gevent network queue) through run_async_in_new_loop /
   any shared background loop to every httpx.AsyncClient it can touch. Find
   which client is shared across event loops or outlives its loop. Explain
   exactly why sniffio cannot detect asyncio there (e.g. connection created
   under loop A being closed while... show it, don't guess). Write the
   mechanism up in the report; a failing unit test that simulates two
   sequential loops sharing the client is the gold standard.
2. FIX durably, following the established pattern: per-running-loop clients
   (like directus_async) or per-call clients where cheap enough, and make any
   background-loop mechanism self-healing (if the loop/thread dies, recreate
   it instead of failing every subsequent task forever). NO asyncio in
   Dramatiq actors directly (AGENTS.md rule); respect gevent constraints.
3. Guard: a task-level catch that detects AsyncLibraryNotFoundError and
   recreates the loop/clients once before failing, so one poisoned context can
   never poison a pod permanently. Log loudly when this self-heal triggers.
4. Tests: unit tests for the mechanism + self-heal. Run the summarize-adjacent
   test files and the whole-tree ruff.

## Constraints

- Production deploys ONLY on release tags; this fix rides the next release or
  a hotfix. Do not touch gitops. Keep the diff surgical: this goes to prod.
- Do not refactor unrelated async plumbing. Fix the disease, not the house.
- Known pre-existing test failures on this host: test_initialize_chat_mode
  _supports_agentic, test_summarize_conversation (env), test_delete_
  conversation_endpoint, test_tier_capacities_pricing_shape_per_kind.

No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave13-REPORT.md.
