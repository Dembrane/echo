# Wave 3 server+agent report

## What changed

- Added the Wave 3 canvas list contract at `GET /api/v2/bff/canvases?project_id=...`, returning newest-first canvas summaries with `{id, name, kind, created_at, latest_generation_at, loop}` and excluding deleted reports.
- Added `POST /api/v2/bff/canvases/preview`, which rate-limits per project for 10 seconds, runs `execute_gather_spec` + `_generate_html` + `sanitize_canvas_html`, and returns `{content_html}` without persisting a generation.
- Added BFF lifecycle routes at `POST /api/v2/bff/canvases/{id}/loop/{pause|resume|stop}` and shared service handling for terminal stopped/expired loops. Resume after stop/expiry returns `409 {"detail":"This loop has ended"}`.
- Added agentic host-token endpoints:
  - `GET /api/agentic/projects/{project_id}/canvases`
  - `POST /api/agentic/projects/{project_id}/canvases/{canvas_id}/loop/{pause|resume|stop}`
- Added agent tools and client methods:
  - `proposeCanvas(...)`, pure proposal only, no server call.
  - `listCanvases()`
  - `pauseCanvasLoop(canvas_id)`
  - `resumeCanvasLoop(canvas_id)`
  - `stopCanvasLoop(canvas_id)`, with docstring confirmation rule.
- Added a short `## Canvases` section to the agent system prompt.
- Added focused BFF, agentic route, agent client, and agent tool tests.

## Files

- `echo/server/dembrane/canvas/service.py`
- `echo/server/dembrane/api/v2/bff/canvases.py`
- `echo/server/dembrane/api/agentic.py`
- `echo/server/tests/api/test_bff_canvases.py`
- `echo/server/tests/api/test_agentic_api.py`
- `echo/agent/agent.py`
- `echo/agent/echo_client.py`
- `echo/agent/tests/test_agent_tools.py`
- `echo/agent/tests/test_echo_client.py`
- `echo/docs/plans/smart-loop-briefs/wave3-server-REPORT.md`

## Contract notes for frontend

- The mounted app prefix is `/api/v2`, so the BFF list endpoint is `/api/v2/bff/canvases?project_id=...`.
- The list payload maps Directus `project_report.date_created` to API `created_at`; this local Directus schema does not have `project_report.created_at`.
- `latest_generation_at` is `null` until an ok generation exists.
- `loop` can be `active`, `paused`, `stopped`, or `expired`. Stopped is terminal.
- Preview rate-limit response is exactly `429 {"detail":"Just previewed"}`.
- Lifecycle resume after a stopped or expired loop is exactly `409 {"detail":"This loop has ended"}`.
- Agent proposal payload uses the brief's required `type: "canvas_proposal"` key.

## QA

- `cd echo/server && uv run ruff check .`: passed.
- `cd echo/agent && uv run pytest -q`: 66 passed.
- `cd echo/server && uv run pytest tests/api/test_bff_canvases.py tests/api/test_agentic_api.py tests/test_canvas_ticks.py -q`: 32 passed.
- `cd echo/server && uv run pytest tests/api tests/agentic tests/test_canvas_ticks.py -q`: 96 passed, 4 failed. The failures match the known pre-existing failures named by the brief/Track A:
  - `tests/api/test_chat_agentic_mode.py::test_initialize_chat_mode_supports_agentic`
  - `tests/api/test_conversation.py::test_summarize_conversation`
  - `tests/api/test_conversation_e2e.py::test_delete_conversation_endpoint`
  - `tests/api/test_tier_capacities_api.py::test_tier_capacities_pricing_shape_per_kind`
- `cd echo/agent && uv run ruff check ...`: not available in this environment because the agent venv cannot spawn `ruff`. I ran `cd echo/agent && uv run python -m py_compile agent.py echo_client.py tests/test_agent_tools.py tests/test_echo_client.py`, which passed.

## Live curl transcript

Setup:

- Server: `cd echo/server && uv run uvicorn dembrane.main:app --port 8123 --loop asyncio`
- Auth: local Directus admin token from `POST http://localhost:8055/auth/login`.
- Project: `ada57b56-d707-4be2-a1ce-25eadeaf5bad`.
- Existing Track A canvas: `2`.
- Temporary live-QA canvas created for lifecycle checks: `3`, left stopped.

List:

```text
GET /api/v2/bff/canvases?project_id=ada57b56-d707-4be2-a1ce-25eadeaf5bad
HTTP 200
[
  {
    "id":"2",
    "name":"Track A live canvas",
    "kind":"canvas",
    "created_at":"2026-07-07T21:18:21.174Z",
    "latest_generation_at":"2026-07-07T21:28:26.630Z",
    "loop":{"status":"active","expires_at":"2026-07-07T22:18:20.933Z","cadence_minutes":5}
  }
]
```

Preview:

```text
POST /api/v2/bff/canvases/preview
HTTP 200
{"content_html":"<div class=\"canvas-shell\"> ... Monitoring changes in the last 5 minutes ... </div>"}
```

Lifecycle on temp canvas `3`:

```text
POST /api/v2/bff/canvases/3/loop/pause
HTTP 200
{"status":"paused","expires_at":"2026-07-07T22:41:59.437Z","cadence_minutes":5}

POST /api/v2/bff/canvases/3/loop/resume
HTTP 200
{"status":"active","expires_at":"2026-07-07T22:41:59.437Z","cadence_minutes":5}

POST /api/v2/bff/canvases/3/loop/stop
HTTP 200
{"status":"stopped","expires_at":"2026-07-07T22:41:59.437Z","cadence_minutes":5}

POST /api/v2/bff/canvases/3/loop/resume
HTTP 409
{"detail":"This loop has ended"}
```

Agentic list and stopped-loop guard:

```text
GET /api/agentic/projects/ada57b56-d707-4be2-a1ce-25eadeaf5bad/canvases
HTTP 200
[
  {"id":"3","name":"Wave 3 live QA temp","kind":"canvas","created_at":"2026-07-07T21:41:59.618Z","latest_generation_at":null,"loop":{"status":"stopped","expires_at":"2026-07-07T22:41:59.437Z","cadence_minutes":5}},
  {"id":"2","name":"Track A live canvas","kind":"canvas","created_at":"2026-07-07T21:18:21.174Z","latest_generation_at":"2026-07-07T21:28:26.630Z","loop":{"status":"active","expires_at":"2026-07-07T22:18:20.933Z","cadence_minutes":5}}
]

POST /api/agentic/projects/ada57b56-d707-4be2-a1ce-25eadeaf5bad/canvases/3/loop/resume
HTTP 409
{"detail":"This loop has ended"}
```

## Notes

- No git write commands were run.
- I did not touch frontend files. Existing frontend changes in the worktree appear to belong to the parallel frontend track.
