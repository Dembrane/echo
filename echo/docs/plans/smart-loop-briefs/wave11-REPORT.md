# Wave 11 report - canvas real-usage feedback

## Summary

Implemented the three Wave 11 fixes:

- Canvas update proposals now carry `target_canvas_id`, render as update cards, patch the existing canvas config, and avoid the wave-8 name-match applied-state regression.
- Canvas detail now exposes a live `created_from_chat_id`, and the canvas page has subtle chat affordances for opening the originating chat or starting a seeded new chat about the canvas.
- Preview generation can use clearly labeled built-in sample conversations when real gathered material is sparse, gated by `preview_sample=True` so scheduled/live generations never use samples.

## Details

### Update proposals

- Extended `proposeCanvas` with optional `target_canvas_id`; the tool resolves ids or unique name references through the existing canvas resolver and returns `target_canvas_id`/`target_canvas_name` in the proposal payload.
- Updated the agent canvas prompt guidance so "change this canvas" requests go through the update proposal path.
- Added BFF `PATCH /canvases/{canvas_id}` and shared service `update_canvas_config`, which appends a config revision, updates report/loop display fields, resets loop failures, and enqueues a fresh tick.
- Updated `CanvasSuggestionCard` so:
  - explicit update proposals render as update cards;
  - same-name create proposals become an update choice instead of silently rendering as applied;
  - update applied-state is keyed to the target config matching this proposal after the proposal timestamp, or to the local apply result;
  - create proposals no longer treat bare same-name canvases as already applied.

### Canvas to chat

- Canvas BFF detail returns latest config metadata, loop `updated_at`, and `created_from_chat_id` only when the referenced chat still exists, is not deleted, and belongs to the same project.
- Canvas creation can carry `created_from_chat_id`; the BFF validates it cheaply and drops invalid/deleted/cross-project ids.
- `CanvasRoute` now shows:
  - `Open the chat` when `created_from_chat_id` resolves;
  - `New chat about this canvas`, which navigates to the new-chat route with `initialMessage`.

### Preview samples

- Added four short built-in sample conversations at the gather layer.
- `execute_gather_spec(..., preview_sample=True)` uses samples only when gathered real material is below the threshold and marks `sample_mode`, `sample_notice`, and `counts.sample_conversations_used`.
- BFF preview is the only caller passing `preview_sample=True`; scheduled and manual ticks keep the default false value.
- The canvas generator receives a sample-mode instruction requiring the visible line: `Sample conversations, your real conversations replace these.`

## Validation

- `echo/server`: `uv run ruff check .`
- `echo/server`: `uv run pytest -q tests/api/test_bff_canvases.py tests/test_canvas_gather.py tests/test_canvas_ticks.py`
- `echo/agent`: `uv run pytest -q`
- `echo/frontend`: `./node_modules/.bin/tsc --noEmit`
- `echo/frontend`: `./node_modules/.bin/biome lint . --diagnostic-level=error`
- `echo/frontend`: `./node_modules/.bin/lingui extract`
- `echo/frontend`: `./node_modules/.bin/lingui compile --typescript`

Notes:

- `pnpm` was not on PATH; `corepack pnpm exec ...` tried to mutate the existing modules layout and aborted non-interactively, so frontend checks used local binaries from `node_modules/.bin`.
- Playwright fixture coverage requested in the brief was not added or run in this pass.

## Files touched

- Agent: `echo/agent/agent.py`, `echo/agent/tests/test_agent_tools.py`
- Server: `echo/server/dembrane/api/v2/bff/canvases.py`, `echo/server/dembrane/canvas/gather.py`, `echo/server/dembrane/canvas/service.py`, `echo/server/dembrane/canvas/ticks.py`, server canvas tests
- Frontend: canvas hooks/card/route/chat parsing, Lingui catalogs
