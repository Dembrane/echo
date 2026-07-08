# Wave 26 Report

## Summary

The worktree already contained the broad wave26 implementation in `HEAD`: canvas generation SSE backed by the existing Redis nudge channel, frontend EventSource invalidation with background polling fallback, fullscreen canvas sizing, assistant-message portal QR rendering, brief-as-instructions prompt guidance, canvas generation skill guidance, and the tracked smart-loop follow-ups.

This pass added focused coverage for the canvas BFF SSE stream, tightened the agent prompt tests around brief bloat and key-term corrections, and fixed two static-check issues in the existing frontend changes.

## Files Changed In This Pass

- `echo/server/tests/api/test_bff_canvases.py`
- `echo/agent/tests/test_agent_tools.py`
- `echo/frontend/src/routes/project/canvas/CanvasRoute.tsx`
- `echo/frontend/src/components/chat/ChatHistoryMessage.tsx`

## Verified Present In The Tree

- `GET /api/v2/bff/canvases/{canvas_id}/events` authorizes through the canvas read path, subscribes to `canvas:generation:{report_id}`, emits `generation` SSE events, sends keep-alive comments, and cleans up the Redis pubsub subscription.
- Canvas queries use `refetchIntervalInBackground: true`, and `CanvasRoute` opens an EventSource with backoff to invalidate canvas detail and generation queries on generation nudges.
- Fullscreen canvas mode uses viewport-height sizing so the iframe fills the fullscreen surface.
- Assistant messages render a small QR block only for same-origin participant portal `/start` links matching the current project.
- Agent and generation prompts now state that canvas briefs are durable instructions only, not a place to paste live synthesis or participant reflections.
- Smart-loop tracked list includes weekly canvas email summaries and webhook-driven chat notification when recording finishes.

## Validation

Passed:

- `echo/server`: `uv run ruff check .` with required dummy local env vars.
- `echo/server`: `uv run pytest -q tests/api/test_bff_canvases.py tests/test_canvas_service.py` with required dummy local env vars, 13 passed.
- `echo/agent`: `uv run pytest -q tests/test_agent_tools.py`, 40 passed.
- `echo/frontend`: `corepack pnpm@10 exec tsc --noEmit`.
- `echo/frontend`: `corepack pnpm@10 run lint`.

Not run:

- Lingui extract/compile. No user-facing translated frontend strings were added.
- Local Playwright/manual Redis nudge screenshot flow. I did not start the full podman/backend stack in this worker session, so there is no new `wave26-shots/` evidence.

## Notes

Initial server pytest collection failed without local env because `DIRECTUS_SECRET`, `DIRECTUS_TOKEN`, `DATABASE_URL`, and S3 settings are required at import time. The passing server test and Ruff runs used dummy local values for those settings.
