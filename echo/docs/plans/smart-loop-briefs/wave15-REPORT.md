# Wave 15 report: canvas page honesty

## Summary

Implemented the canvas page polish across frontend, BFF, tick scheduling, and agent guidance.

- Canvas header now shows one freshness cluster that distinguishes checked vs updated. No-op loop runs read as "Checked ... Nothing new ... Updated ...", while fresh generations read as "Updated ...".
- Canvas controls are consolidated into one primary chat button plus one quiet menu for pause/resume, refresh, fullscreen, expiry, and cadence.
- The duplicate in-page "Library > canvas" breadcrumb was removed. The app breadcrumb now resolves canvas routes as `<project> > Library > <canvas name>`, while the Library sidebar highlight still treats `/canvases/:id` as active.
- The BFF exposes latest loop-run status/time/detail on loop payloads, backed by `agent_loop_run`.
- Scheduled canvas ticks now use a Redis cadence-window idempotency guard. Duplicate scheduled deliveries record a no-op duplicate run and do not enqueue their own next tick.
- The canvas iframe kit has tighter top spacing, quieter scrollbars, and darker amber chip text.
- Agent canvas guidance now treats readability/contrast complaints as canvas update proposals instead of support-only issues. The generation skill adds a hard readability rule.

## Files changed

- Frontend canvas page and frame:
  - `echo/frontend/src/routes/project/canvas/CanvasRoute.tsx`
  - `echo/frontend/src/components/canvas/CanvasFrame.tsx`
  - `echo/frontend/src/components/canvas/hooks/index.ts`
  - `echo/frontend/src/components/canvas/kit.css`
  - `echo/frontend/src/components/chat/CanvasSuggestionCard.tsx`
- App breadcrumb plumbing:
  - `echo/frontend/src/features/sidebar/breadcrumbs/AppBreadcrumbs.tsx`
  - `echo/frontend/src/features/sidebar/hooks/useSidebarView.ts`
  - `echo/frontend/src/features/sidebar/types.ts`
- Server canvas payloads and tick idempotency:
  - `echo/server/dembrane/api/v2/bff/canvases.py`
  - `echo/server/dembrane/canvas/service.py`
  - `echo/server/dembrane/canvas/ticks.py`
- Agent/generation guidance:
  - `echo/agent/agent.py`
  - `echo/server/dembrane/canvas/skill.md`
- Tests:
  - `echo/server/tests/test_canvas_ticks.py`
  - `echo/server/tests/api/test_bff_canvases.py`
  - `echo/agent/tests/test_agent_tools.py`
- Lingui extraction/compile updated locale catalogs under `echo/frontend/src/locales/`.

## Validation

Passed:

- `cd echo/server && uv run pytest tests/test_canvas_ticks.py tests/api/test_bff_canvases.py`
- `cd echo/server && uv run ruff check .`
- `cd echo/agent && uv run pytest tests/test_agent_tools.py -q`
- `cd echo/frontend && ./node_modules/.bin/tsc --noEmit`
- `cd echo/frontend && ./node_modules/.bin/biome lint . --diagnostic-level=error`
- `cd echo/frontend && ./node_modules/.bin/lingui extract && ./node_modules/.bin/lingui compile --typescript`
- Touched frontend files formatted with `./node_modules/.bin/biome format --write ...`

Not completed:

- Playwright screenshot evidence under `wave15-shots/` was not produced in this worker run.
- Whole-tree Biome format check still reports pre-existing formatting drift outside this wave; full lint is clean.

## Notes

- `pnpm` was not available on PATH in this terminal, so frontend commands were run through local `node_modules/.bin`.
- Existing untracked shot directories and Directus `__pycache__` were left untouched.
