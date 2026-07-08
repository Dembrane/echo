# Wave 25 Report - Live Session Edits

## Summary

Implemented the live-session fixes from `wave25-live-session.md`.

- Agentic worker tool limits now use a fresh per-turn budget (`MAX_TOOL_CALLS_PER_TURN = 20`) and a 10x run-lifetime backstop. The per-turn safety message names the request and tells the host that resending retries with a fresh pass; the run backstop tells the host to start a new chat.
- Added direct canvas edit support for small presentation/wording changes. The agent gets `editCanvas`, resolves canvas names/ids, reads the latest generation HTML, and submits the rewritten fragment. The server validates access, sanitizes the edited HTML with the same canvas sanitizer, stores a newest `canvas_generation` with `tick_kind="edited"`, records an `agent_loop_run`, publishes the generation nudge, and appends the edit as a standing config constraint for future refreshes.
- Added visible-text hygiene in the worker sanitizer for the observed stray leading CJK token cluster and the banned host-visible word "successfully".

## Files Changed

- `echo/server/dembrane/agentic_worker.py`
- `echo/server/dembrane/canvas/service.py`
- `echo/server/dembrane/api/agentic.py`
- `echo/agent/echo_client.py`
- `echo/agent/agent.py`
- `echo/server/tests/test_agentic_worker.py`
- `echo/server/tests/test_canvas_service.py`
- `echo/server/tests/api/test_agentic_api.py`
- `echo/agent/tests/test_agent_graph.py`

## Verification

- `cd echo/server && uv run ruff check .`
- `cd echo/server && DIRECTUS_SECRET=test DIRECTUS_TOKEN=test DATABASE_URL=postgresql+psycopg://dembrane:dembrane@postgres:5432/dembrane REDIS_URL=redis://localhost:6379 STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 STORAGE_S3_KEY=test STORAGE_S3_SECRET=test uv run pytest -q tests/test_agentic_worker.py tests/test_canvas_service.py tests/api/test_agentic_api.py`
  - Result: 59 passed, 2 warnings.
- `cd echo/agent && uv run pytest -q`
  - Result: 89 passed, 4 warnings.

## Not Run

- Curl round trip QA was not run because no local server stack was started in this worker session.
- Frontend checks were not run because no frontend files or new card components were changed.
