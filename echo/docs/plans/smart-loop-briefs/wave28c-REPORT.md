# Wave 28c Report: Cold Start Guard

## What Shipped

- Added cold-start backfill detection for tabbed canvas loops: if the quotes ledger is empty, the tick gathers full transcript history instead of the delta window.
- Cold-start backfill processes each gathered conversation with a separate sequential extraction call so long histories fit the model window.
- Subsequent ticks flip back to normal delta gathering once the quotes ledger has content.
- Added an empty-over-full guard: when extraction leaves no quotes, no concepts, and no active host items while a previous contentful generation exists, the tick records `no_op` and does not store the empty skeleton.
- Genuinely new canvases with no prior generation can still store the empty skeleton.
- Successful run details now include the same ledger detail as generation rows, including `backfill: N conversations`.

## Files Modified

- `echo/server/dembrane/canvas/gather.py`
- `echo/server/dembrane/canvas/ticks.py`
- `echo/server/tests/test_canvas_gather.py`
- `echo/server/tests/test_canvas_ticks.py`
- `echo/docs/plans/smart-loop-briefs/wave28c-REPORT.md`

## QA Gates

- `cd echo/server && uv run ruff check .` passed.
- `cd echo/server && DIRECTUS_SECRET=test DIRECTUS_TOKEN=test DATABASE_URL=postgresql://user:pass@localhost:5432/db REDIS_URL=redis://localhost:6379/0 STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 STORAGE_S3_KEY=test STORAGE_S3_SECRET=test uv run pytest -q tests/test_canvas_ledgers.py tests/test_canvas_ticks.py tests/test_canvas_sanitize.py tests/test_canvas_gather.py tests/test_canvas_service.py tests/api/test_bff_canvases.py` passed: 40 passed.

## Coverage Added

- Cold-start tick passes `full_history=True`, extracts per conversation, records `backfill: 2 conversations`, and the next tick passes `full_history=False`.
- Full-history gather removes the conversation chunk `created_at >= since` filter; normal gather keeps it.
- Empty extraction over a prior contentful generation returns `no_op`, creates no generation, and leaves loop state untouched.
- A genuinely new canvas with no prior generation still stores the empty tabbed skeleton.

## Notes

- The Wave 28c brief did not require agent or frontend changes, so agent/frontend gates were not run.
- `wave18-shots/` remains unrelated untracked workspace state and was not touched.
