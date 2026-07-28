# Wave 28b Report: Model Extraction Restored

## What shipped

- Replaced Wave 28's deterministic sentence/concept/crux extraction path with one structured `MODELS.MULTI_MODAL_FAST` extraction call for transcript-bearing ticks.
- Added a model prompt with the handoff's quote tracing, concept cloud, and crux checklists embedded in code.
- Added mechanical receipt validation:
  - quotes are accepted only when the proposed text appears verbatim, after whitespace normalization, in the gathered transcript for that conversation;
  - concepts are accepted only when their phrase appears inside at least one accepted supporting quote;
  - story slide quote references are filtered to accepted quote IDs only.
- Preserved deterministic rendering, CSS-only tabs, host items, add/remove canvas tools, and migration behavior from Wave 28.
- Added persisted `canvas_story_slides` alongside the other loop ledger JSON fields.
- Changed model failure behavior to `no_op` with a run detail and no loop-state write, so failed extraction leaves the previous wall untouched.
- Added rejection details to generation/run detail text so fabricated receipts and unsupported concepts are visible to operators.

## File list

- `echo/server/dembrane/canvas/ledgers.py`
- `echo/server/dembrane/canvas/ticks.py`
- `echo/server/dembrane/canvas/service.py`
- `echo/server/dembrane/api/v2/bff/canvases.py`
- `echo/directus/migrations/add_smart_loop_wave28_canvas_ledgers.py`
- `echo/server/tests/test_canvas_ledgers.py`
- `echo/server/tests/test_canvas_ticks.py`
- `echo/docs/plans/smart-loop-briefs/wave28b-REPORT.md`

Wave 28 files for host-item tools/API remain part of the worktree but were not materially changed for 28b.

## QA gates

- `cd echo/server && uv run ruff check .` passed.
- `cd echo/server && DIRECTUS_SECRET=test DIRECTUS_TOKEN=test DATABASE_URL=postgresql://user:pass@localhost:5432/db REDIS_URL=redis://localhost:6379/0 STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 STORAGE_S3_KEY=test STORAGE_S3_SECRET=test uv run pytest -q tests/test_canvas_ledgers.py tests/test_canvas_ticks.py tests/test_canvas_sanitize.py tests/test_canvas_gather.py tests/test_canvas_service.py tests/api/test_bff_canvases.py` passed: 36 passed.
- `cd echo/agent && uv run pytest -q` passed: 97 passed.

## Coverage added

- Verbatim quote accepted and deduped.
- Fabricated quote rejected and recorded.
- Concept with no accepted supporting quote rejected and recorded.
- Concept caps and exactly three XL tiers enforced in code.
- Crux updates in place and preserves history.
- Tick model failure returns `no_op`, creates no generation, and does not update loop state.
- Tick model success stores accepted state and records rejected receipts in generation detail.

## Notes

- `canvas-update-modes.md` remains absent and Wave 28b explicitly said to ignore that.
- Migration was not run against a real Directus scratch instance in this worker. It remains idempotent through the existing `ensure_field` guards.
- `wave18-shots/` is still unrelated untracked workspace state and was not touched.
