# Brief: Wave 30b — the canvas-activity endpoint actually has to exist

Continue on branch sameer/canvas-speaks-back. No git write commands.

Wave 30's brief was wrong to claim the server needed no changes: the client
now calls `GET /agentic/projects/{project_id}/chats/{chat_id}/canvas-activity`
but no such route exists, and the agent's silent fallback means the feature
would simply never fire. Add the endpoint.

## What to build (echo/server/dembrane/api/agentic.py)

`GET /agentic/projects/{project_id}/chats/{chat_id}/canvas-activity?limit=N`
(same auth pattern as the other agentic chat routes; verify the chat
belongs to the project as its siblings do). Response shape the wave-30
client/formatter already expects:

```json
{"canvases": [{"id": "...", "name": "...", "recent_runs": [
  {"status": "ok|no_op|error", "detail": "...", "started_at": "..."}]}]}
```

- canvases: the project's agent_loop rows (report_id + report name where
  cheap; loop id is fine as id if reports are awkward — keep it consistent
  with what the formatter labels).
- recent_runs: latest N (default 5, cap 10) agent_loop_run rows per loop,
  newest first, fields status/detail/started_at only.
- No loops -> {"canvases": []}. Never 500 on missing data.

## QA gates

- Server test for the route (exists, auth, shape, empty case) +
  `cd echo/server && uv run ruff check .` + focused pytest including the
  existing agentic API tests.
- cd echo/agent && uv run pytest -q (unchanged, should stay green).
- End-to-end sanity in the report: show the client path and the route path
  are string-identical.
- Report -> echo/docs/plans/smart-loop-briefs/wave30b-REPORT.md.
