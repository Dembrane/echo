# Brief: Wave 24 - generalize the async self-heal + memory actually applied

You are in the solve-queue-issues worktree. Start:
`git fetch origin && git checkout -b sameer/selfheal-general origin/main`.

## Item 1: the sniffio self-heal belongs in run_async_in_new_loop (server)

Evidence (echo-next, 2026-07-08 ~15:1x-15:2x UTC, worker logs + scheduled_task
rows): canvas ticks and task_reconcile_canvas_tick_tasks failed with the SAME
poisoned-loop disease #816 fixed for summaries: "unknown async library, or not
in async context" out of run_async_in_new_loop -> async_directus -> httpx.
A manual canvas tick (scheduled_task 4d7f437b-9336-4bba-aab8-ecaef5355c67,
loop 7477bf2e-c107-4cd5-9d76-bddc426f01cc) died this way, which is why an
applied canvas update produced no redraw in the wave-23 verify. #816's guard
lives ONLY in task_summarize_conversation.

Fix: move the self-heal into the shared boundary. In
echo/server/dembrane/async_helpers.py, run_async_in_new_loop (or a thin
wrapper it always applies) detects sniffio.AsyncLibraryNotFoundError through
the exception chain (reuse _is_async_library_not_found from tasks.py - move
it here), logs loudly, calls reset_background_loop + discards
AsyncDirectusClient cached clients (import locally to avoid cycles), and
retries the coroutine ONCE. IMPORTANT: the caller passes a coroutine object
which is consumed on first await - the API must accept a zero-arg coroutine
FACTORY for the retry (change run_async_in_new_loop to also accept a callable
returning the coroutine, or add run_async_in_new_loop_with_retry and migrate
the task call sites: summarize, canvas tick dispatch, reconcile, and any
other scheduled-task dispatchers). Keep task_summarize_conversation's
existing behavior working (its bespoke guard can now delegate or be
simplified - do not double-retry). Tests: simulate a first-call
AsyncLibraryNotFoundError then success; assert one reset + one retry, and
that non-sniffio errors do not retry.

This is prod-bound: keep the diff surgical.

## Item 2: remembered facts must shape answers (agent)

Evidence (wave-23 beat 4): the memory "The participant's name is spelled
Akshita, not Akshata" was saved AND present in chat B's system context under
"## What you remember", yet "who have we heard from so far?" answered "an
unnamed participant" without applying the name. Fix in the agent prompt
(echo/agent/agent.py): what you remember is not decoration - actively apply
remembered corrections, names, spellings, and preferences when they bear on
the answer; when a remembered fact names or corrects something the data
leaves unnamed or misspelled, use the remembered version and cite it
naturally ("Akshita (you told me the spelling earlier)"). Add a prompt
assertion test. Keep it short; no new machinery.

## QA

Gates: server whole-tree ruff + pytest tests/test_async_helpers.py
tests/test_agentic_worker.py tests/test_tasks_summarize_tier_lock.py (env
bundle from prior reports if needed); agent uv run pytest -q. No frontend.
No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave24-REPORT.md (this worktree).
