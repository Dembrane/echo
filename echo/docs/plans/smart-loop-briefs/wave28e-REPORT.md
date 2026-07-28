# Wave 28e Report: Board Primitive

## What Shipped

- Added a `board` canvas tab primitive with a responsive grid renderer and persistent `canvas_board_cards` state.
- Extended canvas tab config from strings to structured tab objects while keeping old string tabs readable for compatibility.
- Threaded `tabs` through canvas creation, preview, config revision, BFF payloads, frontend proposals, and agent `proposeCanvas` calls.
- Made applied structural briefs visibly matter: changing tabs now updates loop state and rerenders even when there is no new transcript content.
- Added board extraction support gated on the enabled tab set, with evidence-backed cards built only from accepted receipt quote ids.
- Added attribution rules for board cards: exact single speaker evidence can create a person card, while unattributed or mixed evidence folds into `"the room"`.
- Added honest shape warnings when a brief asks for unsupported structures such as person-by-person views without a board tab, timelines, calendars, matrices, or charts.
- Updated the agent prompt so it proposes a board tab for person-by-person, per-person, speaker-by-speaker, and per-table briefs, and records a `capability_gap` insight for unsupported structural asks.
- Extended the idempotent Wave 28 Directus migration with `canvas_config_revision.tabs` and `agent_loop.canvas_board_cards`.
- Reconciled the board work on top of Wave 28d #833 so the real `host_guide` tab state, renderer, lensed extraction, host-guide generation, and honest windowed backfill remain intact.

## Reconcile Note

- The branch was fast-forwarded from `origin/main`, whose head is now `0da73cf8` (#833), after the initial Wave 28e work was temporarily stashed.
- The earlier placeholder-compatible `host_guide` support was removed in favor of the real 28d implementation: `canvas_host_guide` persists on the loop, renders as the Host guide tab, and updates through `_generate_host_guide`.
- Shared tick detail now reports both host guide and board changes, and the focused tests cover 28d windowed backfill plus 28e board/tab-shape behavior in one reconciled suite.
- The temporary Wave 28e stash was used only for conflict resolution and was dropped after final verification.

## Files Modified

- `echo/agent/agent.py`
- `echo/agent/tests/test_agent_tools.py`
- `echo/directus/migrations/add_smart_loop_wave28_canvas_ledgers.py`
- `echo/frontend/src/components/canvas/hooks/index.ts`
- `echo/frontend/src/components/chat/CanvasSuggestionCard.tsx`
- `echo/frontend/src/components/chat/agenticToolActivity.ts`
- `echo/server/dembrane/api/v2/bff/canvases.py`
- `echo/server/dembrane/canvas/ledgers.py`
- `echo/server/dembrane/canvas/service.py`
- `echo/server/dembrane/canvas/ticks.py`
- `echo/server/tests/api/test_bff_canvases.py`
- `echo/server/tests/test_canvas_ledgers.py`
- `echo/server/tests/test_canvas_service.py`
- `echo/server/tests/test_canvas_ticks.py`
- `echo/docs/plans/smart-loop-briefs/wave28e-REPORT.md`

## QA Gates

- `cd echo/server && uv run ruff check .` passed.
- `cd echo/server && DIRECTUS_SECRET=test DIRECTUS_TOKEN=test DATABASE_URL=postgresql://test:test@localhost:5432/test REDIS_URL=redis://localhost:6379/0 STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 STORAGE_S3_KEY=test STORAGE_S3_SECRET=test uv run pytest -q tests/test_canvas_ledgers.py tests/test_canvas_ticks.py tests/test_canvas_service.py tests/api/test_bff_canvases.py` passed: 40 passed, 2 warnings.
- `cd echo/agent && uv run pytest -q` passed: 103 passed, 4 warnings.
- `cd echo/frontend && node_modules/.bin/tsc --noEmit` passed.

## Coverage Added

- Board cards render from attributed accepted quotes when a board tab is enabled.
- Unattributed board evidence folds into a `"the room"` card instead of inventing a person.
- A tab set change rerenders despite no new transcript content.
- Unsupported structural asks are recorded in generation detail rejections.
- Canvas config updates preserve existing tabs when the update omits the `tabs` field.
- BFF create, update, preview, and payload shapes pass tabs through.
- Agent tool tests cover board prompt guidance and `proposeCanvas` tabs passthrough.
- Reconciled focused canvas tests cover long-transcript backfill windowing and nonfatal per-conversation model errors alongside board/tab-shape regressions.

## Notes

- The Directus snapshot JSON was not hand-edited; the existing idempotent migration script was extended instead.
- A broad `tests/test_canvas_*.py` collection run failed before tests executed because this local shell had no server import-time env vars; the focused gate was rerun with dummy local settings and passed.
- Existing unrelated untracked workspace state under `wave18-shots/` was not touched.
