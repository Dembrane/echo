# Wave 5 Server/Agent Report

## What changed

- Added Wave 5 Directus schema migration: `echo/directus/migrations/add_smart_loop_wave5_schema.py`.
- Added Directus snapshot files for `project_goal_revision`, `methodology`, `methodology_version`, and `project.methodology_version_id`.
- Seeded the public `dembrane` methodology and one `methodology_version` in the migration script.
- Added BFF endpoints:
  - `GET /api/v2/bff/projects/{project_id}/goal`
  - `POST /api/v2/bff/projects/{project_id}/goal`
  - `GET /api/v2/bff/methodologies?workspace_id={workspace_id}`
- Extended `/api/v2/bff/projects/{project_id}` PATCH whitelist with `methodology_version_id`.
- Added agentic endpoints:
  - `GET /api/agentic/projects/{project_id}/goal`
  - `GET /api/agentic/projects/{project_id}/methodologies`
- Added shared server helpers for goal revision reads and visible methodology listing.
- Added `Project Goal:` to the initial hidden agent prompt after `Project Context:`.
- Added current goal content to the canvas gather bundle as `bundle["project"]["goal"]`.
- Added agent skill `echo/agent/skills/interviewing.md`.
- Added agent tools:
  - `readGoal()`
  - `proposeGoal(content)` returning pure `{type: "goal_proposal", content, project_id, visible_to_user}`
  - `listMethodologies()`
- Updated the agent system prompt with project setup behavior: read `interviewing.md`, offer methodologies, keep setup escapable, and suggest methodology extraction only gently after substantial artifacts/reports.

## Frontend contract

- Goal read:
  - `GET /api/v2/bff/projects/{project_id}/goal`
  - Response: `{ current: revision|null, revisions: revision[] }`
  - Revision shape: `{ id, content, set_by, created_at }`
  - `revisions` is newest-first.
- Goal write:
  - `POST /api/v2/bff/projects/{project_id}/goal`
  - Body: `{ content: string, chat_id?: string }`
  - Creates `set_by = "host-edit"`.
  - Response is the created revision shape.
- Methodology list:
  - `GET /api/v2/bff/methodologies?workspace_id={workspace_id}`
  - Response item shape: `{ id, name, description, framing, is_seeded, latest_version }`
  - `latest_version` shape: `{ id, note, created_at } | null`
  - Includes public seeded methodologies, workspace-visible methodologies for the workspace, and methodologies owned by the caller.
- Project methodology selection:
  - Existing BFF project PATCH now accepts `methodology_version_id`.
- Agent proposal:
  - `proposeGoal(content)` returns a visible proposal only. The host apply flow should call the BFF goal POST.
  - Proposal payload type is `goal_proposal`.

## QA evidence

- `python3 echo/directus/migrations/add_smart_loop_wave5_schema.py -u http://localhost:8055 -e admin@dembrane.com -p admin`: applied cleanly.
- `cd echo/directus && bash sync.sh -u http://localhost:8055 -e admin@dembrane.com -p admin pull`: pulled 841 snapshot files.
- `cd echo/directus && bash sync.sh -u http://localhost:8055 -e admin@dembrane.com -p admin diff`: reported `No changes to apply`; the known `sync/collections/operations.json` `_syncId` shuffle was reverted by patch.
- Live curl against FastAPI on `127.0.0.1:8123`, Directus `localhost:8055`, project `ada57b56-d707-4be2-a1ce-25eadeaf5bad`, workspace `0ac34bcb-0d26-4154-a0a9-9f1e6cf5f570`:
  - POST goal created revision `e9694af1-5b2a-4e1e-bc10-0df818681204`.
  - GET goal returned that revision as `current` and in `revisions`.
  - GET methodologies returned seeded `dembrane` with latest version `3869f9c7-a375-49ed-8d2e-9e75b438089e`.
- `cd echo/server && uv run ruff check .`: passed.
- `cd echo/server && uv run pytest tests/api/test_bff_goals.py tests/api/test_agentic_api.py tests/test_canvas_gather.py tests/test_agentic_worker.py -q`: 51 passed.
- `cd echo/agent && uv run pytest -q`: 67 passed.
- `cd echo/agent && uv run ruff check agent.py echo_client.py tests/test_agent_tools.py knowledge.py`: ruff executable unavailable in this environment (`No such file or directory`), same constraint as Phase 0.
- `cd echo/server && uv run pytest tests/api tests/agentic -q`: 99 passed, 4 failed. Failures match the brief's known pre-existing failures: `test_initialize_chat_mode_supports_agentic`, `test_summarize_conversation`, `test_delete_conversation_endpoint`, and `test_tier_capacities_pricing_shape_per_kind`.
- `python3 -m py_compile echo/directus/migrations/add_smart_loop_wave5_schema.py`: passed.

## Notes and constraints

- No git write commands were run.
- No frontend files were touched.
- The report path is outside the "touch only" implementation directories because the brief explicitly required this report here.
