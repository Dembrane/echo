# Brief: Track A - the loop engine (server): ticks, generations, canvas BFF

You are building the server core of the dynamic canvas: the loop that regenerates a
canvas every few minutes, and the endpoints the already-built frontend consumes. When
you finish, the system works END TO END: create a canvas via curl -> a generation
appears -> the real UI at /canvases/:id renders it live.

Read FIRST, in order:

1. `echo/docs/plans/smart-loop.md` - decisions D1, D4, D4a, D5, D12, D14, D15, D16, D17.
   D4 and D16 are your spec.
2. `echo/docs/plans/smart-loop-briefs/phase0-REPORT.md` - the schema you build on and
   the reader-access helper you MUST call (its "Track A notes" section is addressed to
   you).
3. `echo/docs/plans/smart-loop-briefs/trackb-REPORT.md` - "Endpoint shapes mocked" is a
   CONTRACT: the frontend already consumes exactly those shapes. Match them.
4. `echo/server/dembrane/canvas/skill.md` - the generation prompt contract your tick
   pipeline injects (read it so you inject it faithfully; do not edit it).
5. `echo/AGENTS.md` + `echo/server/AGENTS.md` - binding conventions.

## Concept, in two sentences

A loop row (mandatory expiry) drives a bounded tick: gather recent project data as the
loop's acting user, make ONE LLM call with the skill + brief + previous document + data,
sanitize, store a `canvas_generation` row. No agent, no tool loop - the full agent only
authors configs later; your tick is a mechanical pipeline.

## Deliverables

### 1. Canvas service + tick pipeline - `echo/server/dembrane/canvas/`

Extend the existing package (access.py is there):

- `service.py`: create_canvas(project_id, name, brief, gather_spec, cadence_minutes,
  expires_at, acting_directus_user_id, created_from_chat_id=None) -> creates the
  project_report row (kind='canvas'), the first canvas_config_revision, and ONE
  agent_loop (status active). Also: revise_config (new revision), pause/resume/stop
  loop, list/get helpers. All Directus writes unwrap ["data"].
- `gather.py`: execute a gather spec v1 = {window_minutes: int (default 60),
  tag_ids?: [uuid], conversation_ids?: [uuid]} scoped STRICTLY to the loop's project.
  Output: a compact JSON bundle - per conversation: id, name/participant label,
  latest transcript text within the window (cap each + total size; state your caps in
  the report), plus project name/context/language and counts. Call
  `resolve_canvas_reader_context` FIRST every tick; on CanvasReaderAccessDenied fail
  the tick closed with status 'error'.
- `ticks.py`: run_tick(loop_id, tick_kind) implementing D16 exactly:
  gather -> if window has NO new content since the last 'ok' generation, store a
  'no_op' generation-less agent_loop_run and stop (honest quiet tick) -> else ONE LLM
  call: system = skill.md contents; user = project context block + BRIEF + previous
  document (latest 'ok' generation's content_html, if any, with the instruction that
  layout stays stable) + the gathered data JSON -> strip any markdown fences ->
  sanitize -> store canvas_generation (status ok, tick_kind) + agent_loop_run ->
  publish a Redis nudge `canvas:generation:{report_id}` (mirror the monitor_stream.py
  pub/sub pattern; the frontend polls today, the nudge is the upgrade path).
- LLM call: find how the server already calls models (grep `litellm` /
  `MULTI_MODAL_FAST` in `echo/server/dembrane/` - chat_utils.py and summary tasks show
  the pattern). Use the FAST model group per D16. Temperature low. Cap max output
  tokens generously (a full HTML doc). If the model returns unusable output, store
  status 'error' with detail - never store garbage HTML silently.
- Sanitization (v1, per D6: the iframe+CSP are the real boundary): reject/strip
  external references - any `http(s)://` or `//` URL in src/href/url() outside data:
  URIs. Enforce a size cap. Keep it a pure function with tests. Do NOT strip inline
  scripts (charts need them).
- Failure discipline: increment agent_loop.failure_count on error ticks, reset on ok;
  status -> 'paused' after 3 consecutive failures; every tick writes an
  agent_loop_run row.

### 2. Scheduling - the recurrence

Evidence: `echo/server/dembrane/scheduled_tasks.py` + `task_process_scheduled_tasks`
(runs every minute) + how tasks enqueue. Reuse this durable queue; do NOT add
APScheduler jobs (the insight sweep in scheduler.py is the anti-pattern here - system
sweeps only).

- On loop creation: enqueue the first tick for now(). On tick completion (any status):
  enqueue the next at now()+cadence IF the loop is still active and now() < expires_at;
  else set status 'expired' and run one final tick before expiring if one is due.
- The tick body is async (Directus + LLM): respect the no-asyncio-in-actors rule -
  from the Dramatiq/scheduled-task context use `run_async_in_new_loop` from
  `dembrane.async_helpers` (grep existing usages).
- Expiry is enforced in TWO places: the scheduler check AND at tick start (a tick that
  wakes past expires_at expires the loop instead of generating).

### 3. The BFF - `echo/server/dembrane/api/v2/bff/canvases.py`

Mount at `/v2/bff/canvases` in `api/v2/__init__.py` (mirror bff/memory.py, which is the
cleanest recent example - access via `resolve_project_access` from `bff/_access.py`).
The response shapes MUST match trackb-REPORT.md "Endpoint shapes mocked" verbatim
(top-level id/name/kind/project_id + latest_generation + loop):

- `GET /{id}` - resolve the report row, 404 if kind != 'canvas' or deleted;
  require project:read. Include latest generation + loop {status, expires_at,
  cadence_minutes}.
- `GET /{id}/generations?limit=` (default 8, max 50, newest first) - project:read.
- `POST /{id}/refresh` - project:update; rate-limit per canvas via a Redis SETNX key
  (30s TTL) -> 429 {"detail": "Just refreshed"} when hot; else run a manual tick
  inline-async and return 202 {"generation": "pending"}.
- `POST ""` (create) - body {project_id, name, brief, gather_spec?, cadence_minutes?,
  expires_at} - require project:update; acting user = the caller; delegates to
  service.create_canvas. This is how the chat's apply flow AND your curl QA create
  canvases. Validate: expires_at required, in the future, <= 7 days out;
  cadence_minutes >= 2 (floor) and <= 120.

### 4. Wire-up nits

- `usePulse`/frontend not your scope; do not touch echo/frontend or docs/.
- If settings are needed (e.g. CANVAS_MAX_HTML_BYTES), fields on AppSettings with
  defaults - never os.environ.

## QA required before you report done (this is the acceptance)

Local stack: podman services are up (Directus localhost:8055 admin@dembrane.com/admin,
static Bearer `admin`; Redis 6379; Postgres 5432). Run THIS worktree's server:
`cd echo/server && uv run uvicorn dembrane.main:app --port 8123 --loop asyncio`.
Login for a session token: POST http://localhost:8055/auth/login. If tokens look
expired: `podman machine ssh "sudo date -s @$(date +%s)"` (VM clock drift).

1. Unit tests: sanitizer, gather caps, tick no-op path, tick error path (LLM mocked),
   scheduling enqueue logic, bff shapes + gates (mirror tests/api/test_bff_memory.py
   monkeypatch style). Whole-tree `uv run ruff check .` clean;
   `uv run pytest tests/ -q` no NEW failures (known pre-existing host failures:
   test_initialize_chat_mode_supports_agentic, test_summarize_conversation,
   test_delete_conversation_endpoint, test_tier_capacities_pricing_shape_per_kind).
2. LIVE end-to-end: pick a real project id from local Directus that has conversations
   with transcript chunks (query Directus with the admin Bearer; if none has recent
   chunks, widen your test gather window to cover whatever exists). Then, as a real
   logged-in user session: POST /v2/bff/canvases (expiry ~1h, cadence 5) -> confirm
   the first generation appears (trigger via your manual refresh if the queue tick is
   slow) -> GET /{id} and /generations match the contract -> POST refresh twice fast
   -> second returns 429. Paste the actual generation's first ~30 lines of HTML in
   your report so taste can be judged. The LLM call uses the dev .env's configured
   models; if the FAST group is not configured locally, say so and fall back to
   whichever group chat uses locally - note it clearly.
3. If feasible, prove the UI: with the server on 8123, the frontend dev server proxies
   /api to... check `echo/frontend/vite.config*` for the dev proxy target; if it
   points at localhost:8000, run the server on 8000 instead. Load
   /w/{ws}/projects/{pid}/canvases/{report_id} logged in as the dev admin and describe
   what renders. If browser verification is impractical, say so - the curl contract
   check is the hard requirement.

## Constraints

- No git write commands. Working tree only; the orchestrator commits.
- Touch ONLY `echo/server/` (plus nothing else; frontend and agent are other tracks).
- Do not edit `echo/server/dembrane/canvas/skill.md` or `access.py` semantics (extend
  around them; small compatible additions to access.py are fine if justified in the
  report).
- Brand rules for any user-visible string: lowercase dembrane, never "AI", never
  "successfully".

## Report back (write to `echo/docs/plans/smart-loop-briefs/tracka-REPORT.md`)

Files, QA evidence (paste the curl transcript + generation HTML sample), caps and
rate-limit values chosen, LLM group/model actually used locally, deviations from the
Track B contract (should be none), and what wave 3 (chat authoring tools + Try-it
previews) must know.
