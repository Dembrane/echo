# Wave 28 Report: Tabbed Living Canvas

## What shipped

- Added a tabbed v1 canvas renderer with fixed tabs in owner order: Crux, Concept cloud, Story.
- Added additive canvas ledgers on `agent_loop`: quote receipts, concept tiles, crux state/history, host items, and tab config.
- Updated ticks so scheduled no-new-content still no-ops, while content-bearing/manual ticks merge ledgers additively before rendering a sanitized CSS-only tab fragment.
- Preserved chunk IDs in canvas gather output so quote receipts can point to conversation/chunk sources when available.
- Added CSS-only tabs with hidden radios/labels and CSS-only trace expansion through `details`/`summary`; sanitizer round-trip coverage verifies both survive.
- Added `addToCanvas` and `removeFromCanvas` to the agent, plus agentic/BFF endpoints and client methods. Host-added items are stored exactly, target a tab, and enqueue a manual tick immediately.
- Added an idempotent Directus migration script for the new `agent_loop` JSON fields.

## File list

- `echo/server/dembrane/canvas/ledgers.py`
- `echo/server/dembrane/canvas/ticks.py`
- `echo/server/dembrane/canvas/gather.py`
- `echo/server/dembrane/canvas/service.py`
- `echo/server/dembrane/api/agentic.py`
- `echo/server/dembrane/api/v2/bff/canvases.py`
- `echo/directus/migrations/add_smart_loop_wave28_canvas_ledgers.py`
- `echo/agent/agent.py`
- `echo/agent/echo_client.py`
- `echo/server/tests/test_canvas_ledgers.py`
- `echo/server/tests/test_canvas_sanitize.py`
- `echo/server/tests/test_canvas_ticks.py`
- `echo/agent/tests/test_agent_graph.py`
- `echo/agent/tests/test_agent_tools.py`
- `echo/agent/tests/test_echo_client.py`
- `echo/docs/plans/canvas-ux-handoff.md`
- `echo/docs/plans/smart-loop-briefs/wave28-tabbed-canvas.md`
- `echo/docs/plans/smart-loop-briefs/wave28-REPORT.md`

## QA gates

- `cd echo/server && uv run ruff check .` passed.
- `cd echo/server && DIRECTUS_SECRET=test DIRECTUS_TOKEN=test DATABASE_URL=postgresql://user:pass@localhost:5432/db REDIS_URL=redis://localhost:6379/0 STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 STORAGE_S3_KEY=test STORAGE_S3_SECRET=test uv run pytest -q tests/test_canvas_ledgers.py tests/test_canvas_ticks.py tests/test_canvas_sanitize.py tests/test_canvas_gather.py tests/test_canvas_service.py tests/api/test_bff_canvases.py` passed: 31 passed.
- `cd echo/agent && uv run pytest -q` passed: 97 passed.
- Migration was not run against a scratch Directus because no local Directus credentials/runtime were available in this worker. The migration uses the existing `ensure_field` guards and calls phase 0 `ensure_schema`, so reruns skip existing fields.
- Frontend was not touched, so no frontend gates were run.

## Compatibility decision

Existing canvas loops without tab/ledger fields default to the v1 tab set on the next tick through `fresh_canvas_state`. Existing stored generations remain renderable until the next tick or preview; the next successful tick stores the tabbed fragment and writes the additive state back to `agent_loop`.

## Cut or constrained

- `echo/docs/plans/canvas-update-modes.md` was required by the brief but absent after checkout and full filename search. I attempted to ask the coordinator twice; both `orca orchestration ask` calls lost their runtime connection before a response, so I proceeded from the wave brief and `canvas-ux-handoff.md`.
- The per-tab jobs are implemented as deterministic additive ledger merges plus deterministic rendering. The legacy model prompt fallback still carries the Flash-class discipline checklist, but the live tabbed renderer does not depend on a model to restyle or rebuild the HTML.
