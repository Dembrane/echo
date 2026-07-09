# Wave 28g Report

## Summary

Implemented Trace as an anchor-addressable canvas destination, added an Audit log tab backed by shared canvas history objects, and exposed the same history through the agent-facing `readCanvasHistory` tool.

## Implementation

- Added `trace` and `audit` canvas tab kinds and default tabs.
- Kept radio-tab fallback markup while adding CSS `:has()` / `:target` routing for `#tab-*` tabs and `#trace-*` claim anchors.
- Built Trace entries from concept, story, and board claims with stable claim/quote-id hashes.
- Kept inline `<details>` receipt fallbacks while making traceable claim labels link to the Trace destination.
- Added Audit log accordions with the refined `HH:MM · outcome — cause · links` summary grammar and expanded heard / added-updated / kept-out / cause / view-version sections.
- Added `echo/server/dembrane/canvas/history.py` so stored canvas HTML and the agent endpoint read the same normalized `{at, kind, version, cause, heard, changes, kept_out}` history objects.
- Populated Audit entries during living canvas HTML generation.
- Fix-back: made `build_canvas_history` accept an injected Directus client and made tick rendering pass `ticks.async_directus`, preserving the existing tick test contract and preventing non-test tick rendering from bypassing the active Directus seam.
- Added `GET /agentic/projects/{project_id}/canvases/{canvas_id}/history` with the same agent token, project access, and canvas ownership checks as the existing canvas endpoints.
- Added `EchoClient.get_canvas_history` and the `readCanvasHistory` agent tool with canvas id/name resolution.
- Updated the agent prompt to require `readCanvasHistory` for canvas history/change/cause questions and `recordInsight` for review judgments.

## Gates

- Server ruff:
  `cd echo/server && uv run ruff check dembrane/canvas/ledgers.py dembrane/canvas/history.py dembrane/canvas/ticks.py dembrane/api/agentic.py tests/test_canvas_ledgers.py tests/test_canvas_history.py tests/test_canvas_ticks.py tests/test_canvas_sanitize.py tests/test_canvas_gather.py tests/test_canvas_service.py tests/api/test_bff_canvases.py tests/api/test_agentic_api.py`
- Full requested canvas pytest, with local dummy settings required for test collection:
  `cd echo/server && DIRECTUS_SECRET=test DIRECTUS_TOKEN=test DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/test REDIS_URL=redis://localhost:6379/0 STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 STORAGE_S3_KEY=test STORAGE_S3_SECRET=test uv run pytest -q tests/test_canvas_ledgers.py tests/test_canvas_history.py tests/test_canvas_ticks.py tests/test_canvas_sanitize.py tests/test_canvas_gather.py tests/test_canvas_service.py tests/api/test_bff_canvases.py tests/api/test_agentic_api.py`
  Result: 88 passed, 2 warnings.
- Fix-back reproduction before the Directus seam fix produced the 8 expected `tests/test_canvas_ticks.py` failures; the targeted rerun of those 8 tests passed after the fix.
- Sanitizer round-trip coverage is in `tests/test_canvas_ledgers.py::test_render_tabbed_canvas_includes_tabs_traceable_quotes_and_host_items`.
- Endpoint shape/auth coverage is in `tests/api/test_agentic_api.py::test_agentic_canvas_history_returns_shared_history`.
- Agent:
  `cd echo/agent && uv run pytest -q`
  Result: 105 passed, 4 warnings.

All listed gates passed. Frontend was untouched per the brief.
