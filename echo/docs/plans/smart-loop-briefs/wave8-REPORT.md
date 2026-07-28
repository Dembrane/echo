# Wave 8 owner feedback report

## Summary

Implemented all seven owner-feedback items on `sameer/smart-loop-feedback-1`.

## Changes

1. Setup chat toggle in project creation
   - Added a visible `Set up with the assistant after creating` switch to the project wizard.
   - Defaults on when agentic chat is enabled.
   - Off routes to project home after creation.
   - `Help me figure it out` clears the context seed and forces assistant setup on.
   - Review step now shows whether the project will start in assistant chat or project home.

2. Setup conversation wording
   - Rewrote `echo/agent/skills/interviewing.md` away from announced interviews and question counts.
   - Updated the `## Project setup` prompt to ask one question per turn, offer 2-4 concrete options, keep each turn skippable, avoid "frameworks"/"tools" as product wording, keep docs as a light aside, and avoid asking the host to report back after applying a proposal.
   - Updated agent prompt assertions.

3. Composer line removal
   - Removed `New messages will be answered next.` from the agentic chat composer.

4. Output artifact cleanup
   - Added `_sanitize_host_visible_assistant_content` at the server worker host-visible boundary.
   - It trims orphan trailing cursor artifacts after terminal punctuation, including `Let's start here!_`.
   - It suppresses single parenthetical planning prose like `(I am checking the available project frameworks.)`, including when it arrives as a direct `assistant.message` event rather than same-turn tool-call prose.
   - Added worker tests for both cases.

5. Docs are not the closer
   - Prompt now says docs mentions are light asides only, use short link text like `the docs`, and must not be the final sentence or visual CTA.

6. Sidebar order
   - Moved `Library` directly below `Monitor` in the project sidebar.

7. Apply is a message plus durable card state
   - Goal card now derives applied state from the current project goal matching the proposal content, with local state only as immediate UI feedback.
   - Canvas card now derives applied state from the project canvas list by matching the proposed canvas name, and rechecks that list immediately before create. This is the cheapest honest durable signal available from the current list API, and it prevents a remounted card from silently creating a duplicate canvas.
   - After a real apply mutation succeeds, the card sends `I applied the goal.` or `I applied the canvas.` through the normal chat send path so the thread records the action and the agent can continue.

## Validation

Passed:

- `echo/server`: `uv run ruff check .`
- `echo/server`: `uv run pytest tests/test_agentic_worker.py -q`
- `echo/agent`: `uv run pytest -q`
- `echo/frontend`: `./node_modules/.bin/tsc --noEmit`
- `echo/frontend`: `./node_modules/.bin/biome lint . --diagnostic-level=error`
- `echo/frontend`: `./node_modules/.bin/lingui extract`
- `echo/frontend`: `./node_modules/.bin/lingui compile --typescript`

Not run:

- Authenticated Playwright wizard/apply/remount flow. The repo e2e README says authenticated flows require a running local Vite/API/Directus stack plus seeded verified credentials (`E2E_EMAIL` / `E2E_PASSWORD`); those credentials and seeded state were not available in this worker context.

