# Wave 16 echo-next regressions report

## Summary

Fixed the three live regressions from the post-#815 echo-next verification:

- Persisted agentic chats no longer render as the empty Ask state when a browser lacks the `agentic-run:<chatId>` localStorage key. `AgenticChatPanel` now falls back to `/bff/chat-messages` history, normalizes persisted `User`/`assistant` roles, and contains suggestion-card parsing so malformed tool payloads degrade to ordinary tool activity instead of blanking the thread.
- `getPortalLink` no longer falls through to production for internal cluster API URLs. Portal origin resolution now prefers `AGENT_CORS_ORIGINS` entries whose host starts with `portal.`, keeps public API hostname mapping as a secondary source, and returns `portal_link: null` plus an Overview/Host guide fallback reason when no environment signal exists.
- Suppressed assistant status narration no longer re-enters Gemini history. `_build_message_history` now applies the same host-visible assistant sanitizer used at persistence time before replaying assistant turns to the model.

## Root Causes

### A. Persisted chat empty state

The agentic panel only hydrated run events from a run id stored in `localStorage`. Existing chats opened in a fresh browser/session could load the chat row and BFF chat messages successfully, but the timeline stayed empty because no stored run id was available.

PR #815 also added more structured tool suggestion parsing in the main timeline pass. The parsers were mostly defensive, but the render pipeline called them repeatedly without a containment boundary; one unexpected payload shape could still threaten the entire thread render path.

### B. Production portal link on echo-next

`portal_base_url_for_api_url("http://echo-api:8000/api")` had no environment signal and fell back to `https://portal.dembrane.com`. In echo-next, the pod's public environment signal is in `AGENT_CORS_ORIGINS`, not `ECHO_API_URL`, because `ECHO_API_URL` is the internal cluster service URL.

### C. Vertex empty parts 400

The worker already prevented empty and suppressed assistant text from being persisted as host-visible messages. History replay still accepted any non-empty persisted assistant content, including status-only narration that the sanitizer would suppress today. That made follow-up turns vulnerable to sending model-hostile or semantically empty assistant turns back into Gemini history.

## Changes

- `echo/frontend/src/components/chat/AgenticChatPanel.tsx`
  - Added `useChatHistory(chatId)` fallback rendering when run events contain no top-level messages.
  - Converts BFF `ProjectChatMessage` rows into agentic `RenderMessage`s with citation enrichment.
  - Filters old internal assistant placeholders from persisted history.
  - Wraps all suggestion parser calls behind `tryParseTimelineSuggestion`; malformed structured tool output remains visible as tool activity.

- `echo/agent/echo_client.py`
  - Added `portal_base_url_for_cors_origins`.
  - Changed API URL mapping to return `None` instead of production fallback for unknown/internal hosts.
  - Changed `build_project_portal_link` to return `str | None`.

- `echo/agent/agent.py`
  - `getPortalLink` now returns `portal_link: null` with a reason and dashboard fallback locations when no portal origin can be determined.

- `echo/server/dembrane/agentic_worker.py`
  - `_build_message_history` sanitizes assistant history with `_sanitize_host_visible_assistant_content`.

- Tests added/updated:
  - Internal cluster API URL + echo-next CORS origins resolves to `https://portal.echo-next.dembrane.com`.
  - No-signal portal resolution returns `None`, never production.
  - `getPortalLink` returns `portal_link: null` in no-signal config.
  - Suppressed assistant narration is skipped in replayed message history.

## Verification

Passed:

```bash
cd echo/server
uv run ruff check .

DIRECTUS_SECRET=test DIRECTUS_TOKEN=test \
DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/db \
REDIS_URL=redis://localhost:6379/0 \
STORAGE_S3_BUCKET=test STORAGE_S3_ENDPOINT=http://localhost:9000 \
STORAGE_S3_KEY=test STORAGE_S3_SECRET=test \
uv run pytest -q tests/test_agentic_worker.py

cd echo/agent
uv run pytest -q

cd echo/frontend
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/biome lint . --diagnostic-level=error
./node_modules/.bin/lingui extract
./node_modules/.bin/lingui compile --typescript
```

Results:

- Server ruff: passed.
- Server `tests/test_agentic_worker.py`: 25 passed.
- Agent `uv run pytest -q`: 87 passed.
- Frontend tsc: passed.
- Frontend biome lint: passed.
- Lingui extract/compile: passed.

Notes:

- `pnpm` was not directly on PATH. `corepack pnpm install --frozen-lockfile` populated `node_modules` but exited nonzero because local pnpm policy requires approving build scripts; I ran frontend checks through local binaries afterward.
- I did not add/run a new Playwright persisted-history fixture. The existing Playwright harnesses are route/static harnesses, while `AgenticChatPanel` depends on authenticated BFF/query/workspace context; the frontend regression is covered by the direct BFF-history fallback implementation plus `tsc`/lint, and the server/agent regressions have explicit pytest coverage.
