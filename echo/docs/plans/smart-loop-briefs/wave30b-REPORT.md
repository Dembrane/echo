# Wave 30b Canvas Activity Endpoint Report

## Summary

- Added `GET /agentic/projects/{project_id}/chats/{chat_id}/canvas-activity` on the server, mounted through the existing `/api/agentic` router prefix.
- The route requires the agent bearer token, checks project access, verifies the chat belongs to the requested project, and hides private chats owned by someone else.
- The response is `{"canvases": [...]}` from the project's `agent_loop` rows, with best-effort report names and latest per-loop `agent_loop_run` records limited to `status`, `detail`, and `started_at`.
- Empty or missing loop/report/run data returns an empty canvas/run shape instead of a 500.

## Files Changed

- `echo/server/dembrane/api/agentic.py`
- `echo/server/tests/api/test_agentic_api.py`
- `echo/docs/plans/smart-loop-briefs/wave30b-REPORT.md`

## End-to-End Path Sanity

- Client call in `echo/agent/echo_client.py`: `/agentic/projects/{project_id}/chats/{chat_id}/canvas-activity`
- Server route after the app's `/api` prefix: `/agentic/projects/{project_id}/chats/{chat_id}/canvas-activity`
- These strings are identical after the existing client/server `/api` base split.

## QA Gates

- `cd echo/server && DIRECTUS_SECRET=t DIRECTUS_TOKEN=t DATABASE_URL=postgresql+psycopg://u:p@localhost:5432/db REDIS_URL=redis://localhost:6379/0 STORAGE_S3_BUCKET=t STORAGE_S3_ENDPOINT=http://localhost STORAGE_S3_KEY=t STORAGE_S3_SECRET=t uv run ruff check .`: passed.
- `cd echo/server && DIRECTUS_SECRET=t DIRECTUS_TOKEN=t DATABASE_URL=postgresql+psycopg://u:p@localhost:5432/db REDIS_URL=redis://localhost:6379/0 STORAGE_S3_BUCKET=t STORAGE_S3_ENDPOINT=http://localhost STORAGE_S3_KEY=t STORAGE_S3_SECRET=t uv run pytest -q tests/api/test_agentic_api.py`: passed, `34 passed, 2 warnings`.
- `cd echo/agent && uv run pytest -q`: passed, `102 passed, 4 warnings`.

## Notes

- The first server pytest attempt without environment placeholders failed during settings import because `DIRECTUS_SECRET`, `DIRECTUS_TOKEN`, and then `DATABASE_URL` were unset. The reruns used dummy values because the focused tests mock external Directus/service paths.
