# Brief: Phase 0 - canvas/loop schema + chat-identity threading

You are building the foundation of the "dynamic canvas" feature for dembrane echo.
Read these FIRST, in order - they are the why behind everything you'll do:

1. `echo/docs/plans/smart-loop.md` - the decision record (D1-D17). Your work: D3 (v1
   interpretation below), D4/D5 (schema), D7 (threading).
2. `docs/building/smart-loop.md` - the user story this all serves.
3. `echo/AGENTS.md` + `echo/server/AGENTS.md` - repo conventions. They are binding.

## Concept, in two sentences

A host asks in chat for "a live wall of what people are saying, updated every 5
minutes". Behind it: a LOOP (with a hard expiry) whose tick regenerates a CANVAS (one
HTML document) from project data; everything the host does goes through chat, and every
insight the assistant files must be traceable back to the exact chat message and user so
the team can reach back when a feature ships.

## Your scope (three deliverables)

### 1. Directus schema (new collections + one field)

Hard interface - these exact names (Track A/B build against them):

- `project_report.kind` - varchar, default `'report'`, values `'report' | 'canvas'`.
  (Canvases reuse the report primitives per D5.)
- `canvas_config_revision` - id uuid pk, report_id (m2o -> project_report), brief text,
  gather_spec json, cadence_minutes int default 5, created_by varchar (directus user
  id), note varchar, created_at timestamp (date-created special).
- `canvas_generation` - id uuid pk, report_id (m2o -> project_report),
  config_revision_id (m2o -> canvas_config_revision), content_html text, status varchar
  default 'ok' ('ok' | 'no_op' | 'error'), tick_kind varchar ('scheduled' | 'manual' |
  'preview'), detail text nullable, created_at timestamp (date-created special).
- `agent_loop` - id uuid pk, project_id (m2o -> project), report_id (m2o ->
  project_report), name varchar, status varchar default 'active'
  ('active' | 'paused' | 'expired' | 'stopped'), expires_at timestamp NOT NULL (a loop
  without expiry must be unrepresentable), cadence_minutes int default 5,
  acting_directus_user_id varchar (the "reader" identity - see D3 note), chat_id varchar
  nullable (the loop's chat thread), created_from_chat_id varchar nullable,
  failure_count int default 0, caps json nullable, created_at/updated_at timestamps.
- `agent_loop_run` - id uuid pk, loop_id (m2o -> agent_loop), status varchar
  ('ok' | 'no_op' | 'error'), detail text nullable, generation_id (m2o ->
  canvas_generation, nullable), started_at timestamp, finished_at timestamp nullable.

PROCEDURE (non-negotiable, from echo/AGENTS.md "Directus Rules"): NEVER hand-write
snapshot JSON. Write an idempotent Python script (requests against the local Directus
REST API: POST /collections, /fields, /relations, checking existence first), run it
against local Directus at `http://localhost:8055` (admin@dembrane.com / admin; static
token `admin` also works as Bearer), then pull the snapshot:
`cd echo/directus && bash sync.sh -u http://localhost:8055 -e admin@dembrane.com -p admin pull`.
KNOWN NOISE: the pull may shuffle `_syncId`s inside `sync/collections/operations.json` -
revert that file if its only changes are _syncId swaps
(`git checkout -- echo/directus/sync/collections/operations.json`). Keep the schema
script in `echo/directus/migrations/` (it does not need to run in CI; the snapshot is
the source of truth). Verify with `bash sync.sh ... diff` that the only drift is your
additions before AND that there is none after the pull.

### 2. Chat-identity threading (D7)

Today only project_id reaches the agent service. Thread chat identity through so
insights and support requests carry reach-back ids.

- Evidence: `echo/server/dembrane/api/agentic.py` - `create_run` persists the run
  (`agentic_run_service.create_run(project_id, project_chat_id, directus_user_id)`), so
  the run ALREADY knows chat + user; the gap is the hop to the agent service and into
  the outbox rows. Follow how the run flows: `agentic_worker.py` /
  `agentic_client.py` (`stream_agent_events` -> http://echo-agent:8001), and how
  `X-Dembrane-Docs-Base-Url` is already forwarded per-request (grep it: that is the
  established pattern for threading per-run context to the agent - copy it).
- Add to the server->agent call: `X-Dembrane-Chat-Id`, `X-Dembrane-App-User-Id` (resolve
  via `dembrane.app_user.get_app_user_or_raise` from the run's directus_user_id), and
  the triggering `X-Dembrane-Message-Id` if cheaply available from the run's latest
  user.message event - if not cheap, skip message id and say so in your report.
- Agent side (`echo/agent/`): receive the headers in `main.py` the same way
  docs_base_url is received, put them on the graph/config, and include them in the
  payloads `reachOutToDembrane` sends and the idle-sweep insight writer stores.
  Server-side writers: grep `support_request` and `usage_insight` in
  `echo/server/dembrane/` - add nullable columns `chat_id`, `app_user_id`,
  `message_id` to BOTH collections via the same schema script, and populate them.

### 3. Reader-semantics helper (D3, v1 interpretation)

The plan's D3 describes minted scoped tokens. v1 DOWNSCOPES this deliberately: the tick
pipeline runs in-process (D16/D1), so no token crosses a process boundary yet. What v1
needs is the SEMANTICS: a helper the tick pipeline will call that, given
`acting_directus_user_id` + `project_id`, verifies that user still has project read
access (reuse `dembrane.api.v2.bff._access.resolve_project_access` logic or the
underlying `get_user_project_access`) and returns a narrow "reader context" (project ids
+ user ids only). Put it in a new module `echo/server/dembrane/canvas/access.py` (create
the `canvas` package - Track A will fill in `ticks.py` etc. next to it). If the user
lost access, the helper raises - a tick must fail closed. Document in the module
docstring that the minted-token version arrives with D2 (external execution).

## Gotchas you'd otherwise hit (hard-won, believe them)

- Python DirectusClient: `create_item`/`update_item` return `{"data": {...}}` - unwrap
  with `["data"]`. `get_items` needs `{"query": {...}}` wrapper. Nested fields use dot
  notation strings, never dicts.
- Settings: new env vars go on `AppSettings` in `dembrane/settings.py`; never
  `os.environ` directly. (You likely need no new env vars.)
- Run the WHOLE-TREE lint before you finish: `cd echo/server && uv run ruff check .` -
  per-file ruff misses import-sort issues that CI catches.
- Tests: host-run needs the existing `.env` in `echo/server/` (already set up in this
  worktree - do not modify it). Run `uv run pytest tests/api tests/agentic -q`. Some
  suites fail on the host for pre-existing env reasons (conversation/e2e/tier/chat-mode
  tests) - verify your failures are not among the pre-existing set by checking they fail
  the same way on an unmodified tree if in doubt.
- Local server for curl QA: `cd echo/server && uv run uvicorn dembrane.main:app --port
  8123 --loop asyncio` (uvloop breaks nest_asyncio - the --loop flag matters). Login:
  `curl -s -X POST http://localhost:8055/auth/login -H 'Content-Type: application/json'
  -d '{"email":"admin@dembrane.com","password":"admin"}'` -> access_token -> use as
  Bearer against localhost:8123.
- If Directus-minted JWTs are rejected as expired: the podman VM clock drifts after mac
  sleep. Fix: `podman machine ssh "sudo date -s @$(date +%s)"`.
- Agent tests: `cd echo/agent && uv run pytest -q` (they pass on host).
- No asyncio inside Dramatiq actors, ever (you shouldn't need actors in this brief).

## QA required before you report done

- Schema: sync.sh diff clean after pull; a curl round-trip creating and reading an
  `agent_loop` row + a `canvas_generation` row via Directus (Bearer admin) proving
  relations resolve.
- Threading: server + agent test suites green; one live check if feasible (run the
  server, create a run via the agentic API, verify the headers reach the agent -
  a unit test asserting the client sends the headers is acceptable if a live agent
  isn't running locally).
- Whole-tree ruff clean; `uv run pytest tests/api tests/agentic -q` no NEW failures.

## Constraints

- Do NOT run any git write commands (add/commit/push/checkout). Leave all changes in
  the working tree; the orchestrator reviews and commits.
- Do not touch `echo/frontend/` (another agent works there in parallel).
- Do not modify `.env`, docs/, or anything outside: `echo/server/`, `echo/agent/`,
  `echo/directus/`.
- Brand rule if you write any user-visible string: "dembrane" lowercase, never say
  "AI", never say "successfully".

## Report back (write to `echo/docs/plans/smart-loop-briefs/phase0-REPORT.md`)

What you built (file list), the QA evidence (commands + outcomes), schema decisions you
had to make beyond this brief, anything you skipped and why, and anything Track A (loop
+ tick pipeline) must know that isn't in the plan.
