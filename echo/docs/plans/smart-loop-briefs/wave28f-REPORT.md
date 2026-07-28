# Wave 28f Report: Render Polish

## Start Check

- `origin/main` includes Wave 28e #834 at `a903e626`, so the brief's wait condition was satisfied before implementation.
- The current worktree already had unrelated docs edits in `echo/docs/plans/smart-loop-briefs/wave28g-trace-audit.md`, untracked `echo/docs/plans/canvas-agentic-tick.md`, and untracked `wave18-shots/`; these were left untouched.

## What Shipped

- Renamed the visible `host_guide` tab label and rendered copy to `Open questions` while keeping internal `canvas_host_guide` field names unchanged.
- Added a code comment documenting the label/internal-field split to avoid migration churn.
- Updated the Open questions prompt so `where_the_room_is` is one short orienting line and the tab leans into parked or next questions.
- Reworked deterministic Story rendering so each structured slide is its own `80vh` centered screen with one kicker, display heading sizing, balanced text, and handoff spacing tiers.
- Kept the other tab spacing sweep scoped to existing renderer tokens: cloud measure, trace cards, dense board blocks, tab gaps, and mobile minima remain in handoff ranges.
- Converted the tab-bar `+` from inert text to a `_top` chat link with a URL-encoded prefill: `I need a new tab in the {report name} canvas: `.
- Added `workspace_id` to gathered project context so real renders can build `/{lang}/w/{workspace_id}/projects/{project_id}/chats/new?prefill=...`.
- Verified sanitizer round-trips the relative prefill anchor and preserves `target="_top"`.

## Files Modified

- `echo/server/dembrane/api/v2/bff/canvases.py`
- `echo/server/dembrane/canvas/gather.py`
- `echo/server/dembrane/canvas/ledgers.py`
- `echo/server/dembrane/canvas/ticks.py`
- `echo/server/tests/test_canvas_gather.py`
- `echo/server/tests/test_canvas_ledgers.py`
- `echo/server/tests/test_canvas_sanitize.py`
- `echo/server/tests/test_canvas_ticks.py`
- `echo/docs/plans/smart-loop-briefs/wave28f-REPORT.md`

## QA Gates

- `cd echo/server && uv run ruff check .` passed.
- `cd echo/server && DIRECTUS_SECRET=test DIRECTUS_TOKEN=test DATABASE_URL=postgresql://test:test@localhost:5432/test REDIS_URL=redis://localhost:6379/0 STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 STORAGE_S3_KEY=test STORAGE_S3_SECRET=test uv run pytest -q tests/test_canvas_ledgers.py tests/test_canvas_ticks.py tests/test_canvas_sanitize.py tests/test_canvas_gather.py tests/test_canvas_service.py tests/api/test_bff_canvases.py` passed: 51 passed, 2 warnings.
- `cd echo/agent && rg -n "host guide|Host guide" agent.py tests skills -g '*.py' -g '*.md'` found agent copy references, so the agent gate was run.
- `cd echo/agent && uv run pytest -q` passed: 103 passed, 4 warnings.

## Coverage Added

- Rendered fragment assertions now expect `Open questions`, not `Host guide`.
- Story render assertions check for full-screen slide hooks and display heading CSS.
- The tab-bar `+` assertion covers the language segment, workspace/project route, `_top` target, and report-name prefill.
- Gather tests assert `workspace_id` is present in project context.
- Sanitizer tests assert relative chat-prefill anchors keep `href` and `target="_top"` without being counted as stripped external references.
