# Phase 0 Report: Schema and Threading

## What changed

- Added Directus migration script: `echo/directus/migrations/add_smart_loop_phase0_schema.py`.
- Added Directus snapshot files for `project_report.kind`, reach-back columns on `support_request` and `usage_insight`, and new collections `canvas_config_revision`, `canvas_generation`, `agent_loop`, `agent_loop_run`.
- Threaded `X-Dembrane-Chat-Id`, `X-Dembrane-App-User-Id`, and `X-Dembrane-Message-Id` from server agentic runs to the agent service.
- Added agent-side header intake and included the reach-back ids in `reachOutToDembrane` support request payloads.
- Added nullable reach-back population for idle chat `usage_insight` rows.
- Added `dembrane.canvas.access.resolve_canvas_reader_context`, which verifies the acting Directus user still has project access and returns only project/user ids.
- Added focused tests for server headers, agent header intake, support payloads, and the canvas reader helper.

## QA evidence

- `python3 echo/directus/migrations/add_smart_loop_phase0_schema.py -u http://localhost:8055 -e admin@dembrane.com -p admin`: applied cleanly after fixing the script to create UUID primary keys at collection creation time.
- `cd echo/directus && bash sync.sh -u http://localhost:8055 -e admin@dembrane.com -p admin diff`: before pull showed only the expected Phase 0 additions.
- `cd echo/directus && bash sync.sh -u http://localhost:8055 -e admin@dembrane.com -p admin pull`: pulled 810 snapshot files.
- `cd echo/directus && bash sync.sh -u http://localhost:8055 -e admin@dembrane.com -p admin diff`: reported `No changes to apply` immediately after pull. The known `sync/collections/operations.json` `_syncId` shuffle was then reverted by patch.
- Directus curl round-trip: created and read an `agent_loop` row with resolved `project_id.id` and `report_id.id`, and a `canvas_generation` row with resolved `report_id.id` and `config_revision_id.id`.
- `cd echo/server && uv run ruff check .`: passed.
- `cd echo/server && uv run pytest tests/test_canvas_access.py tests/test_agentic_client.py tests/test_agentic_worker.py -q`: 31 passed.
- `cd echo/server && uv run pytest tests/test_canvas_access.py tests/test_agentic_client.py tests/test_agentic_worker.py tests/api/test_agentic_api.py -q`: 52 passed.
- `cd echo/agent && uv run pytest -q`: 60 passed.
- `cd echo/agent && uv run ruff check .`: not available in this environment, `ruff` executable missing.
- `cd echo/server && uv run pytest tests/api tests/agentic -q`: 85 passed, 4 failed. Failures were outside this change path and match the brief's known host-suite failure categories: `test_initialize_chat_mode_supports_agentic`, `test_summarize_conversation`, `test_delete_conversation_endpoint`, and `test_tier_capacities_pricing_shape_per_kind`.
- `python3 -m py_compile echo/directus/migrations/add_smart_loop_phase0_schema.py`: passed.

## Schema decisions

- New canvas and loop ids are UUID primary keys, matching the brief. Directus defaults new collection ids to integer unless the UUID field is provided during `POST /collections`, so the migration creates the id field in the collection creation payload.
- Relation reverse fields are omitted (`one_field: null`) for the new collections to keep Phase 0 schema narrow.
- `project_report.kind`, loop/generation status fields, and tick kind are Directus dropdown choices plus database defaults where requested, not database enum constraints.
- `agent_loop.expires_at` is required and non-nullable.
- `support_request.message_id` receives the triggering `project_agentic_run_event.id` for live agent runs. `usage_insight.message_id` receives the latest host `project_chat_message.id` from the idle sweep.

## Skipped or constrained

- No git write commands were run.
- No frontend files were touched.
- No live agent service was required for threading QA because `stream_agent_events` now has a unit test asserting outbound headers, and agent route tests assert inbound header propagation.

## Track A notes

- Use `dembrane.canvas.access.resolve_canvas_reader_context(acting_directus_user_id=..., project_id=...)` at tick start. If it raises `CanvasReaderAccessDenied`, fail the tick closed.
- The helper returns `project_id`, `workspace_id`, `directus_user_id`, and `app_user_id` only. It does not mint tokens in Phase 0.
- The loop table makes expiry mandatory. Track A should not create an `agent_loop` without `expires_at`.
- `canvas_generation.status` defaults to `ok`; use `no_op` for quiet ticks and `error` with `detail` for failed ticks.
