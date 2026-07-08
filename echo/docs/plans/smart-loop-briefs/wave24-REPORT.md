# Wave 24 Report

## Summary

Implemented the shared async self-heal in `dembrane.async_helpers.run_async_in_new_loop`.
The helper now accepts either an awaitable or a zero-arg coroutine factory. Factory
inputs retry once when `sniffio.AsyncLibraryNotFoundError` appears anywhere in the
exception chain, after discarding cached async Directus clients and resetting the
shared background loop. Non-sniffio errors do not retry.

Migrated the task async boundaries in `dembrane.tasks` to pass coroutine factories,
including summarization, merge, scheduled canvas ticks, canvas tick reconciliation,
scheduled staff support revocation, billing/tier reconcilers, notification fan-out,
report creator resolution, and chat insight capture. Removed the summarize-only
sniffio guard so `task_summarize_conversation` delegates to the shared helper and
does not double-retry.

Updated the agent system prompt so remembered facts are actively applied when they
bear on an answer, especially corrections, names, spellings, and preferences. Added
prompt assertion coverage for this instruction.

## Files Changed

- `echo/server/dembrane/async_helpers.py`
- `echo/server/dembrane/tasks.py`
- `echo/server/tests/test_async_helpers.py`
- `echo/server/tests/test_tasks_summarize_tier_lock.py`
- `echo/agent/agent.py`
- `echo/agent/tests/test_agent_tools.py`

## Verification

Passed:

```bash
cd echo/server
uv run ruff check .
```

Passed:

```bash
cd echo/server
DIRECTUS_SECRET=test DIRECTUS_TOKEN=test \
DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/db \
REDIS_URL=redis://localhost:6379/0 \
STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 \
STORAGE_S3_KEY=test STORAGE_S3_SECRET=test \
uv run pytest -q tests/test_async_helpers.py tests/test_agentic_worker.py tests/test_tasks_summarize_tier_lock.py
```

Result: 41 passed, 4 warnings. The first run without the dummy env bundle failed
during collection because `DIRECTUS_SECRET` and `DIRECTUS_TOKEN` were missing.

Passed:

```bash
cd echo/agent
uv run pytest -q
```

Result: 88 passed, 4 warnings.

Note: `cd echo/agent && uv run ruff format agent.py tests/test_agent_tools.py`
could not run because `ruff` is not installed in the agent environment.
