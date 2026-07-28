# Wave 17 Agent Insights Report

## Summary

Implemented the quiet `agent_insight` product-learning path:

- Added an idempotent Directus migration script for `agent_insight`.
- Pulled the generated Directus snapshot for the new collection and fields.
- Added a backend `POST /api/agentic/projects/{project_id}/insight` endpoint.
- Added `EchoClient.create_agent_insight` and the agent `recordInsight` tool.
- Updated the agent prompt with quiet insight logging rules, today's examples, and host guide proposal guidance.
- Confirmed `host_guide` is accepted by the proposal/read path because `get_project_settings_for_agent` returns `ProjectUpdate.model_fields`, and `ProjectUpdate` includes `host_guide`; the frontend suggestion labels also include `host_guide`.

No git write commands were run, so there is no commit in this worker checkout.

## Schema

Added `echo/directus/migrations/add_agent_insight_schema.py`.

New collection: `agent_insight`

Fields:

- `id`: uuid primary key
- `created_at`: timestamp, date-created
- `kind`: `capability_gap | friction | wish | praise`
- `content`: text
- `suggested_capability`: text, nullable
- `workspace_id`: string, nullable
- `project_id`: string, nullable
- `chat_id`: string, nullable
- `message_id`: string, nullable
- `status`: string, default `new`

Snapshot files were generated under:

- `echo/directus/sync/snapshot/collections/agent_insight.json`
- `echo/directus/sync/snapshot/fields/agent_insight/`

The known `sync/collections/operations.json` id shuffle was reverted by patch.

## Behavior

`recordInsight(kind, content, suggested_capability=None)` now writes through the server endpoint with the current run's `project_id`, `chat_id`, and `message_id`. The server derives `workspace_id` from the project, matching the support-request pattern rather than trusting the agent.

The prompt now tells the agent to record one quiet insight when it hits a capability gap, uses a workaround, hears product friction, or hears a wish. It keeps `reachOutToDembrane` as the loud support path for broken/account questions, while `recordInsight` is the quiet product-learning path.

Host-guide guidance was added to the project update section: when hosts want participants or facilitators guided differently, the agent should propose a `host_guide` update in the project language.

## Verification

Migration and snapshot:

- `python3 add_agent_insight_schema.py -u http://localhost:8055 -e admin@dembrane.com -p admin`
- repeated the same migration command: second run skipped collection and all fields
- `cd echo/directus && bash sync.sh -u http://localhost:8055 -e admin@dembrane.com -p admin pull`
- `cd echo/directus && bash sync.sh -u http://localhost:8055 -e admin@dembrane.com -p admin diff`: `No changes to apply`

Tests and lint:

- `cd echo/agent && uv run pytest -q`: 83 passed
- `cd echo/server && uv run ruff check .`: all checks passed
- `cd echo/server && uv run pytest -q tests/api/test_agentic_api.py -k insight`: 1 passed

Curl QA:

- Started a temporary backend from this checkout on `127.0.0.1:8002` with `--loop asyncio`.
- Posted `POST /api/agentic/projects/{project_id}/insight` using the local Directus admin token.
- Created row `161c4d68-bbb0-443e-88d3-70865a8ab0c5` in `agent_insight`.
- Read-back row had `kind=capability_gap`, `chat_id=curl-qa-chat`, `message_id=curl-qa-message`, `status=new`.
- The selected local project had `workspace_id=null`, so that curl row also has `workspace_id=null`; the focused server test covers non-null workspace derivation.

## Notes

I did not run a full live agent/LLM conversation because the local backend container was mounted to a different checkout and the current-checkout host server was sufficient to validate the persistence endpoint. The agent-side tests cover tool registration, prompt assertions, and reach-back payload wiring.
