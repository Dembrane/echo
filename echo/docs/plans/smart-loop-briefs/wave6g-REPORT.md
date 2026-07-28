# Wave 6g Report

## Scope

Read `echo/docs/plans/smart-loop-briefs/wave6g-fixes.md` fully and verified the orchestrator diagnosis against the Wave 6f artifacts. The key evidence matched the brief: the final Wave 6f target evidence showed `/stream` followed by `/stop` about 50 ms later (`2026-07-08T00:37:21.936Z` then `2026-07-08T00:37:21.986Z`), consistent with the Send-to-Stop morph race.

No git write commands were run.

## Implemented

- Kept the composer Send button as Send during active runs and added a separate small Stop icon button with the existing armed activation behavior.
- Allowed `/runs/{run_id}/messages` to append user turns while a run is `running`, and prevented `/stream` from claiming an appended turn until the active worker finishes.
- Updated the worker to leave a run `queued` when a newer user turn arrives during the current turn, so the next stream can process the appended turn.
- Added canvas tick recovery for active loops missing a scheduled/processing `canvas_tick` task.
- Added visible-copy detection for banned canvas phrases (`real-time`, standalone `AI`, `successfully`, and em dash) without mutating generated content.
- Hardened methodology settings against malformed/null rows and fixed the reproduced create/edit crash by capturing input values before React state updater execution.
- Strengthened the setup interview prompt so `proposeGoal` is the closing move before settings/context suggestions when no project goal exists.

## Required Local Reproductions

1. Mid-run click/send must not stop the run.
   - Covered by server tests proving append-during-running persists a new user turn, `/stream` does not claim it concurrently while the run is still `running`, and the worker leaves the run `queued` when it detects a newer user turn.
   - Command: `cd echo/server && uv run pytest tests/api/test_agentic_api.py tests/test_agentic_worker.py tests/test_canvas_ticks.py -q`
   - Result: `55 passed, 2 warnings in 68.47s`

2. Crashed canvas tick/sweep.
   - Covered by canvas tests for missing-id tick failure handling, final-slot scheduling, banned visible copy detail, and orphaned active-loop tick backfill.
   - Command: `cd echo/server && uv run pytest tests/api/test_agentic_api.py tests/test_agentic_worker.py tests/test_canvas_ticks.py -q`
   - Result: `55 passed, 2 warnings in 68.47s`

3. Methodology create/edit.
   - Reproduced locally with a Playwright harness rendering the real `WorkspaceMethodologiesSection` against stubbed BFF routes, including a malformed/null methodology row; initial harness run hit the actual `Cannot read properties of null (reading 'value')` crash, and the fixed run passed.
   - Command: `cd echo/frontend && E2E_BASE_URL=http://localhost:5175 ./node_modules/.bin/playwright test e2e/methodology-harness.spec.ts --config e2e/playwright.config.ts`
   - Result: `1 passed (1.7s)`
   - The existing real-app `e2e/methodology-settings.spec.ts` was also updated, but local execution skipped because `E2E_EMAIL`, `E2E_PASSWORD`, `E2E_WORKSPACE_ID`, and `E2E_PROJECT_ID` were not set.

## Gates

- `cd echo/server && uv run pytest tests/api/test_agentic_api.py tests/test_agentic_worker.py tests/test_canvas_ticks.py -q`
  - `55 passed, 2 warnings in 68.47s`
- `cd echo/server && uv run ruff check .`
  - `All checks passed!`
- `cd echo/agent && uv run pytest tests/test_agent_tools.py -q`
  - `32 passed, 1 warning`
- `cd echo/agent && uv run pytest -q`
  - `68 passed, 4 warnings`
- `cd echo/frontend && ./node_modules/.bin/biome lint src/components/chat/AgenticChatPanel.tsx src/components/methodology/WorkspaceMethodologiesSection.tsx e2e/methodology-settings.spec.ts --diagnostic-level=error && ./node_modules/.bin/tsc --noEmit`
  - Passed
- `cd echo/frontend && npm run lint && ./node_modules/.bin/tsc --noEmit && npm run messages:compile`
  - Passed
- `cd echo/frontend && ./node_modules/.bin/playwright test e2e/methodology-settings.spec.ts --config e2e/playwright.config.ts`
  - `2 skipped` because required E2E environment variables were missing
- `cd echo/frontend && E2E_BASE_URL=http://localhost:5175 ./node_modules/.bin/playwright test e2e/methodology-harness.spec.ts --config e2e/playwright.config.ts`
  - `1 passed (1.7s)`

## Files Changed

- `echo/frontend/src/components/chat/AgenticChatPanel.tsx`
- `echo/server/dembrane/api/agentic.py`
- `echo/server/dembrane/agentic_worker.py`
- `echo/server/dembrane/canvas/ticks.py`
- `echo/server/dembrane/tasks.py`
- `echo/server/dembrane/scheduler.py`
- `echo/server/dembrane/canvas/skill.md`
- `echo/frontend/src/components/methodology/WorkspaceMethodologiesSection.tsx`
- `echo/agent/agent.py`
- `echo/server/tests/api/test_agentic_api.py`
- `echo/server/tests/test_agentic_worker.py`
- `echo/server/tests/test_canvas_ticks.py`
- `echo/agent/tests/test_agent_tools.py`
- `echo/frontend/e2e/methodology-settings.spec.ts`
- `echo/frontend/e2e/methodology-harness.html`
- `echo/frontend/e2e/methodology-harness.spec.ts`
- `echo/frontend/src/e2e/methodologyHarness.tsx`
- `echo/docs/plans/smart-loop-briefs/wave6g-REPORT.md`

## Notes

Untracked `wave6*-shots/` directories were already present in the workspace and were left untouched.
