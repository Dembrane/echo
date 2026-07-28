# Brief: Wave 3 (server+agent) - canvas authoring: propose, preview, list, lifecycle

Foundation is live (read these reports first: phase0-REPORT.md, tracka-REPORT.md, and
`echo/docs/plans/smart-loop.md` D12/D15/D16/D17). The loop engine works end to end. Your
job: let the CHAT author and manage canvases - propose, Try-it preview, and lifecycle -
plus the list endpoint the new Library sidebar (parallel frontend track) consumes.

HARD CONTRACT (the frontend track builds against this verbatim):

1. `GET /v2/bff/canvases?project_id=` (project:read) -> newest-first
   `[{id, name, kind:'canvas', created_at, latest_generation_at: string|null,
   loop: {status, expires_at, cadence_minutes} | null}]`. Exclude deleted reports.
2. `POST /v2/bff/canvases/preview` (project:update) - body {project_id, brief,
   gather_spec?} -> 200 {content_html}. Runs gather + generate + sanitize WITHOUT
   persisting anything (tracka-REPORT says reuse execute_gather_spec, _generate_html,
   sanitize_canvas_html - refactor them to be cleanly importable if needed, do not
   change tick behavior). If the project has NO conversations in scope, still generate
   (the skill handles empty data honestly). Rate-limit per project (Redis SETNX, 10s)
   -> 429 {"detail": "Just previewed"}.
3. `POST /v2/bff/canvases/{id}/loop/pause|resume|stop` (project:update) -> the updated
   loop object {status, expires_at, cadence_minutes}. Resume on an expired/stopped loop
   -> 409 {"detail": "This loop has ended"}. Stop is terminal.
4. Agent tools (echo/agent/agent.py, mirror the existing proposal + memory tool
   patterns EXACTLY - read proposeCustomVerificationTopic and readMemory first):
   - `proposeCanvas(name, brief, gather_window_minutes=60, cadence_minutes=5,
     expires_in_hours=8)` - NO server call: validates inputs (cadence>=2,
     expires_in_hours<=168, brief non-empty), computes expires_at ISO from now, and
     RETURNS the structured proposal {type:'canvas_proposal', name, brief, gather_spec:
     {window_minutes}, cadence_minutes, expires_at}. The docstring must tell the model:
     propose only when the host asked for a recurring/live artifact; always state the
     expiry out loud in your message; the host applies it - you never create it.
   - `listCanvases()` - via a new agentic endpoint GET /agentic/projects/{id}/canvases
     (host-token + _assert_project_access, same gate as the memory endpoints) returning
     the same list shape as (1).
   - `pauseCanvasLoop(canvas_id)` / `resumeCanvasLoop(canvas_id)` /
     `stopCanvasLoop(canvas_id)` - via POST /agentic/projects/{id}/canvases/{cid}/loop/{action}
     (host-token, _assert_project_access, delegate to the same service the bff uses).
     Stop requires the model to confirm with the host first (docstring rule).
   - System prompt: add a short "## Canvases" section - what a canvas is (a living page
     in the project Library that regenerates on a loop until its expiry), when to
     propose one, lifecycle by chat, honest about the ~5-minute rhythm without jargon.
     Keep it in the voice of the existing prompt; no em dashes; never "AI".

QA: unit tests for every new endpoint (mirror tests/api/test_bff_canvases.py style) +
agent tool tests (mirror existing proposal tool tests); whole-tree `uv run ruff check .`
+ `cd echo/agent && uv run pytest -q` + `cd echo/server && uv run pytest tests/api
tests/agentic tests/test_canvas_ticks.py -q` (known pre-existing failures: the 4 named
in tracka-REPORT). Live: server on :8123 (podman redis is host-mapped as
echo-host-redis now), curl the list + preview + lifecycle endpoints with a real session
token; paste transcripts. Gotchas: unwrap Directus writes with ["data"]; settings via
AppSettings; --loop asyncio; no git write commands; touch ONLY echo/server and
echo/agent. Report -> echo/docs/plans/smart-loop-briefs/wave3-server-REPORT.md (include
anything the frontend track must know).
