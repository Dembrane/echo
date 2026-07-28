# Wave 22 Verify Residuals Report

Run time: 2026-07-08.

## Summary

Status: **implemented and locally verified**.

Wave-19 residual 1 is addressed by changing the agent prompt from permission-based navigation-card language to a same-turn `navigateTo` rule. Wave-19 residual 2 is addressed by adding a latest-agentic-run lookup for a project chat and using it to hydrate run events when a fresh browser has no `agentic-run:<chatId>` localStorage key, so persisted proposal cards can re-render from stored events instead of falling back to plain messages only.

## Item 1: navigation card permission ask

- Updated `echo/agent/agent.py` so portal/share/dashboard-location asks call `navigateTo("overview")` or `navigateTo("host-guide")` in the same turn as the locating sentence.
- Added the explicit counterexample: do not ask "Would you like me to show a navigation card?"
- Kept the existing `navigateTo` payload shape unchanged: `type: "navigation_suggestion"`, `project_id`, `page`, `entity_id`, `label`, `visible_to_user`.
- Added prompt regression assertions in `echo/agent/tests/test_agent_tools.py`.

## Item 2: proposal cards after reload

- Added `AgenticRunService.get_latest_for_chat(project_chat_id)` sorted by `created_at`.
- Added `GET /api/agentic/chats/{project_chat_id}/latest-run`, authorized through the same run authorization path as direct run reads.
- Added `getLatestAgenticRunForChat(chatId)` in the frontend API client.
- Updated `AgenticChatPanel` hydration:
  - First tries the run id in localStorage.
  - Removes stale localStorage on run `404`.
  - If no stored run is usable, fetches the latest server-side run for the chat.
  - Hydrates all events through the existing `loadAllEvents` path and stores the recovered run id.
  - Treats latest-run `404` as no recoverable run, preserving the existing plain-message fallback.
- Added focused API tests for latest-run lookup and missing-run `404`.
- Added a Playwright harness using a persisted canvas update proposal plus one malformed payload. It renders the real `CanvasSuggestionCard`, mocks canvas BFF list/detail responses, verifies the applied card after remount, and verifies the malformed payload does not blank the thread.

## QA

- `echo/agent`: `uv run pytest -q` passed, 92 tests.
- `echo/server`: `uv run ruff check .` passed.
- `echo/server`: focused pytest for latest chat run passed, 2 tests.
- `echo/frontend`: `npx tsc --noEmit` passed.
- `echo/frontend`: `npx biome lint . --diagnostic-level=error` passed.
- `echo/frontend`: `npm run messages:extract && npm run messages:compile` passed.
- `echo/frontend`: `E2E_BASE_URL=http://localhost:5175 npx playwright test --config e2e/playwright.config.ts e2e/agentic-persisted-canvas.spec.ts` passed, 1 test.

Note: the first Playwright attempt used the default `localhost:5173` and failed with `net::ERR_EMPTY_RESPONSE` because no usable Vite server was available there. Vite then started on `localhost:5175` because ports 5173 and 5174 were already occupied, and the focused Playwright run passed against that port.

