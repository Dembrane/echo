# Wave 20 Report - Applied Preview Primes Canvas Loop

## Summary

Implemented the "what you approved is what goes live" path for canvas chat proposals.
When a host applies a generated preview, the exact preview HTML is now sent to the
server, sanitized through the normal canvas sanitizer, stored as an `ok`
`canvas_generation` with `tick_kind="applied"`, and published through the canvas
generation nudge channel so open readers can update immediately.

## Changes

- BFF create/update canvas bodies now accept optional `applied_preview_html`.
- BFF update also accepts optional `created_from_chat_id` so applied-generation
  provenance can record the chat preview source when available.
- `create_canvas` and `update_canvas_config` store the applied preview generation
  before scheduling the next tick, so the scheduled tick sees that generation as
  the newest previous frame.
- Applied preview storage records honest provenance in `detail`, including
  `applied from chat preview`, the chat id when validated, and any stripped
  external references.
- Applied preview storage publishes the Redis generation nudge after writing the
  generation row.
- `CanvasSuggestionCard` sends `applied_preview_html` only when the host generated
  a preview on that card; apply without preview omits the field.
- Applied card copy now says: "Applied. The canvas now shows this design and keeps
  it fresh."
- Lingui catalogs were extracted and compiled for the new copy.

## Tests

Server:

```bash
cd echo/server
DIRECTUS_SECRET=test DIRECTUS_TOKEN=test \
DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/db \
REDIS_URL=redis://localhost:6379/0 \
STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 \
STORAGE_S3_KEY=test STORAGE_S3_SECRET=test \
uv run pytest tests/test_canvas_service.py tests/test_canvas_ticks.py tests/api/test_bff_canvases.py
```

Result: 19 passed, 2 warnings.

```bash
cd echo/server
DIRECTUS_SECRET=test DIRECTUS_TOKEN=test \
DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/db \
REDIS_URL=redis://localhost:6379/0 \
STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 \
STORAGE_S3_KEY=test STORAGE_S3_SECRET=test \
uv run ruff check .
```

Result: all checks passed.

Frontend:

```bash
cd echo/frontend
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/biome lint . --diagnostic-level=error
./node_modules/.bin/lingui extract
./node_modules/.bin/lingui compile --typescript
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/biome lint . --diagnostic-level=error
```

Result: TypeScript passed, Biome checked 440 files with no fixes applied, Lingui
extract/compile completed.

## Notes

- Initial `pytest` attempts without environment values failed during settings
  collection; reruns with the same dummy env bundle used by prior wave reports
  passed.
- `pnpm` was not on PATH, and `corepack pnpm` attempted an install blocked by
  ignored build-script policy. Frontend checks were run through existing local
  `node_modules/.bin` binaries.
- Live curl QA was not run because this worker does not have the local API,
  Directus, Redis, and auth stack running. The storage path is covered directly
  by `test_store_applied_preview_sanitizes_and_returns_as_latest`, which verifies
  external refs are stripped, `tick_kind="applied"` is stored, the applied row is
  returned as latest, an `agent_loop_run` points at it, and the nudge is published.
