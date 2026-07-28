# Wave 6e Fix Report

Branch: `sameer/smart-loop-hardening`

## Scope Read

- Read `echo/docs/plans/smart-loop-briefs/wave6e-fixes.md` fully.
- Read cited reports and evidence:
  - `echo/docs/plans/smart-loop-briefs/wave6d-REPORT.md`
  - `echo/docs/plans/smart-loop-briefs/wave6c-REPORT.md`
  - `echo/docs/plans/smart-loop-briefs/wave6d-shots/wave6d-evidence.json`
- Re-checked echo-next cited pause run `8a06e15d-e6d4-4dfb-a9b1-104d7d059f25` for chat `1c0c896c-8b88-47d7-b59a-c20d9de01453`: it is still `queued` with only the initial `user.message` event, so production evidence does not prove tool execution for that pause request.

## Fixes

### A. Setup Chat Accidental Stop

- Changed the chat Stop button so `handleStop` only calls `/stop` when the current run was armed by a pointer down or keyboard activation that originated on the Stop control.
- This preserves normal Stop behavior but ignores the Send-to-Stop morph race where a click started on Send and ended on the newly rendered Stop button.
- File: `echo/frontend/src/components/chat/AgenticChatPanel.tsx`

### B. Scheduled Canvas Tick Cancellation / Error Visibility

- Made `AsyncDirectusClient` keep a separate `httpx.AsyncClient` per running event loop instead of reusing one async client across FastAPI and Dramatiq/scheduler loops.
- Kept `_client` compatibility for existing tests that inject a client, while closing every loop-local client in `close()`.
- Made scheduled tick error handling create an `agent_loop_run` error row even when the failure happens before a generation id exists, and create an error generation only when a report id is available.
- Files:
  - `echo/server/dembrane/directus_async.py`
  - `echo/server/dembrane/canvas/ticks.py`

### C. Canvas Pause/Resume/Stop by Name

- Updated agent canvas lifecycle tool docs and system prompt to resolve named or shorthand canvas references before pause/resume/stop.
- Added `_resolve_canvas_id()` to accept exact ids, exact names, and unique substring name references; ambiguous or missing references now fail clearly.
- Preserved backwards compatibility by passing through the reference when the canvas list is unavailable in tests or degraded conditions.
- File: `echo/agent/agent.py`

### D. Methodology Modal Automation Stability

- New/edit methodology modals now render only while open, preventing hidden stale modal roots from matching test selectors.
- Added explicit form/cancel test ids and disabled modal focus traps for automation stability.
- File: `echo/frontend/src/components/methodology/WorkspaceMethodologiesSection.tsx`

## Tests Added / Updated

- Added server regression coverage for loop-local async Directus clients across event loops.
- Added server regression coverage for canvas tick error run rows when required ids are missing.
- Added agent regression coverage for resolving a unique canvas name reference before lifecycle updates.
- Updated the existing agent canvas lifecycle test to avoid counting list-client setup calls as update calls.

## Required Local Reproductions

### A. Full Local Stack Setup Wizard

Stack used:

- Server API: `uv run uvicorn dembrane.main:app --port 8123 --loop asyncio`
- Agent API: `uv run uvicorn main:app --host 0.0.0.0 --port 8001`
- Network worker: `uv run dramatiq-gevent --queues network --processes 1 --threads 10 dembrane.tasks`
- Scheduler: `uv run python -m dembrane.scheduler`
- Frontend: `corepack pnpm@10 run dev -- --host 127.0.0.1 --port 5175`

Browser reproduction:

- Logged in locally as `admin@dembrane.com`.
- Created project `Wave 6e Stop Repro 1783468817327`.
- Used the setup wizard path with "Help me figure it out", then waited on the setup chat.
- Observed run `b8915b8e-b6bf-41a3-a575-918833f171fb`.

Evidence:

- `echo/docs/plans/smart-loop-briefs/wave6e-shots/A-network.json`
- `echo/docs/plans/smart-loop-briefs/wave6e-shots/A-setup-chat.png`

Result:

- Stream requests: 4.
- Stop requests: 0.
- No accidental `/stop` call was emitted during setup chat creation/stream reattachment.

### B. Real Worker-Driven Scheduled Tick

Using the same local stack and project `f30f1283-cd47-4dcf-9225-c31f686c15d5`:

- Created canvas `5` named `Wave 6e Scheduled Tick 1783468882573` through the real BFF canvas API.
- Cadence was set to 2 minutes.
- The running scheduler and network Dramatiq worker produced scheduled generation `b2af9b26-61c6-4f8c-96e1-ac9bc191d689`.

Evidence:

- `echo/docs/plans/smart-loop-briefs/wave6e-shots/B-scheduled-tick.json`

Result:

- Latest generation status: `ok`.
- Tick kind: `scheduled`.
- Detail: `null`.
- No `Attempted to exit cancel scope in a different task than it was entered in` error occurred.

## Verification

Passed:

- `cd echo/server && uv run pytest tests/test_canvas_ticks.py tests/test_directus_retry.py -q`
  - `14 passed`
- `cd echo/agent && uv run pytest tests/test_agent_tools.py -q`
  - `32 passed, 1 warning`
- `cd echo/frontend && ./node_modules/.bin/biome lint src/components/chat/AgenticChatPanel.tsx src/components/methodology/WorkspaceMethodologiesSection.tsx --diagnostic-level=error && ./node_modules/.bin/tsc --noEmit`
- `cd echo/frontend && npm run lint && ./node_modules/.bin/tsc --noEmit && npm run messages:compile`
- `cd echo/agent && uv run pytest -q`
  - `68 passed, 4 warnings`
- `cd echo/server && uv run ruff check .`
  - `All checks passed!`

Formatting:

- `cd echo/frontend && ./node_modules/.bin/biome format --write src/components/chat/AgenticChatPanel.tsx src/components/methodology/WorkspaceMethodologiesSection.tsx`
- `cd echo/server && uv run ruff format dembrane/directus_async.py dembrane/canvas/ticks.py tests/test_directus_retry.py tests/test_canvas_ticks.py`
- `cd echo/agent && uv run ruff format agent.py tests/test_agent_tools.py`
  - Could not run because the agent environment failed to spawn `ruff`; agent files were manually inspected after edits.

Full server suite:

- `cd echo/server && uv run ruff check . && uv run pytest -q`
- Ruff passed.
- Full pytest did not pass: `59 failed, 1059 passed, 4 skipped, 14 warnings, 2 errors`.
- Failures were in broad unrelated areas including agentic API integration cases, billing/price tests, audio/S3 fixture paths such as `big.m4a`, AssemblyAI/transcription, and seat/access tests. The targeted Wave 6e server tests passed.

## Files Modified

- `echo/frontend/src/components/chat/AgenticChatPanel.tsx`
- `echo/frontend/src/components/methodology/WorkspaceMethodologiesSection.tsx`
- `echo/server/dembrane/directus_async.py`
- `echo/server/dembrane/canvas/ticks.py`
- `echo/server/tests/test_directus_retry.py`
- `echo/server/tests/test_canvas_ticks.py`
- `echo/agent/agent.py`
- `echo/agent/tests/test_agent_tools.py`
- `echo/docs/plans/smart-loop-briefs/wave6e-REPORT.md`
- `echo/docs/plans/smart-loop-briefs/wave6e-shots/A-network.json`
- `echo/docs/plans/smart-loop-briefs/wave6e-shots/A-setup-chat.png`
- `echo/docs/plans/smart-loop-briefs/wave6e-shots/B-scheduled-tick.json`

## Remaining Work

- Deploy/post-deploy verification on echo-next is still needed because the current echo-next cited pause run never executed beyond the initial queued event.
- The unrelated full server pytest failures remain for their owning areas.
