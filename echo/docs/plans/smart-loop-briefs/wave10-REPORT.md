# Wave 10 Report: Take Me There Navigation

## Summary

Implemented host-clicked dashboard navigation suggestions for agentic chat and
tightened the first-turn setup narration guard. Hosts can now ask where a
dashboard item lives, receive one short locating sentence plus a compact card,
and click the card button to navigate client-side while browser Back returns to
the chat.

## Implementation Notes

- Added the `navigateTo` agent tool in `echo/agent/agent.py` with a fixed page
  enum for the real dashboard surfaces: overview, chats, monitor, library, host
  guide, report, conversations, settings, and portal editor.
- The tool returns a visible structured `navigation_suggestion` payload and
  never calls the API or auto-navigates.
- Updated the agent prompt so location questions use one short locating
  sentence plus `navigateTo`, not multi-step dashboard directions.
- Added `NavigationSuggestionCard` in the frontend. It renders a compact
  suggestion with one primary button and uses `useI18nNavigate` for client-side
  navigation.
- Centralized the enum-to-path map in `NavigationSuggestionCard.tsx`, including:
  - `overview` -> `/home`
  - `settings` -> `/overview`
  - `library` with `entityId` -> `/canvases/:canvasId`
  - `conversations` with `entityId` -> `/conversations/:conversationId`
- Extended `agenticToolActivity.ts` and `AgenticChatPanel.tsx` so completed
  `navigateTo` outputs render as cards and unknown keys render nothing.
- Tightened `_sanitize_host_visible_assistant_content` in
  `echo/server/dembrane/agentic_worker.py` to suppress messages that consist
  entirely of status/planning narration, while preserving messages with any real
  answer, question, or options.
- Added the exact wave-8 leaked first-turn string as a server regression test,
  plus negative cases that must survive.

## Evidence

- Card screenshot:
  `echo/docs/plans/smart-loop-briefs/wave10-shots/navigation-card.png`
- Playwright harness:
  `echo/frontend/e2e/navigation-suggestion.spec.ts`
- Harness page:
  `echo/frontend/e2e/navigation-suggestion-harness.html`

## Verification

- `cd echo/server && uv run ruff check .`: passed.
- `cd echo/server && uv run pytest -q tests/test_agentic_worker.py -k 'sanitize_host_visible_assistant_content or placeholder'`: 3 passed.
- `cd echo/agent && uv run pytest -q`: 81 passed, 4 warnings.
- `cd echo/frontend && ./node_modules/.bin/tsc --noEmit`: passed.
- `cd echo/frontend && ./node_modules/.bin/biome lint . --diagnostic-level=error`: passed.
- `cd echo/frontend && ./node_modules/.bin/lingui extract`: passed.
- `cd echo/frontend && ./node_modules/.bin/lingui compile --typescript`: passed.
- `cd echo/frontend && E2E_BASE_URL=http://127.0.0.1:5173 ./node_modules/.bin/playwright test -c e2e/playwright.config.ts e2e/navigation-suggestion.spec.ts`: 1 passed.

## Notes

- `pnpm` was not on PATH in this worker shell, so frontend commands were run via
  local `node_modules/.bin` binaries.
- `ruff` is not installed in the agent environment, so agent verification used
  the full `uv run pytest -q` suite.
