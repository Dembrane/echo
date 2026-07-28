# Wave 36 — what the agent mints, the host can amend by id (REPORT)

Branch: `sameer/edit-by-id`. Every durable record the agent creates is now
amendable and retractable BY ID in the same chat, and the card reflects it.

## What shipped

### 1. Insights: editInsight / retractInsight
- **Agent tools** (`echo/agent/agent.py`): `editInsight(insight_id, content?,
  kind?, suggested_capability?)` — partial update, at least one field required;
  `retractInsight(insight_id, reason)` — sets status and stores the reason, never
  hard-deletes. Both return an `agent_insight_note` payload with a new `mode`
  discriminator (`edited` / `retracted`) so the existing insight card
  re-renders. `noteInsight` now stamps `mode: "noted"` and already returned
  `agent_insight_id` (verified, no change needed there).
- **Client** (`echo/agent/echo_client.py`): `edit_agent_insight`,
  `retract_agent_insight` (PATCH / POST-retract).
- **Server** (`echo/server/dembrane/api/agentic.py`): `PATCH
  /agentic/insights/{id}` and `POST /agentic/insights/{id}/retract`, agent-token
  auth, ownership via `_assert_project_access(insight.project_id)` — mirrors the
  #838 canvas pattern (load row → resolve its project → access-gate; non-members
  get 404). Retract writes `status="retracted"` + `retracted_reason`, keeps the
  row, and returns it.
- **Frontend**: `parseInsightNote` now accepts `editInsight` / `retractInsight`
  (plus legacy `noteInsight` / `recordInsight`), extracts `insightId`, `mode`,
  `reason`; legacy payloads with no `mode` fall back to `"noted"`.
  `InsightNoteCard` shows a short id suffix ("insight a1b2"), an "updated" chip
  for edits, and mutes with a "retracted" chip + reason for retractions.

### 2. Memories: amendMemory / forgetMemory
- **Agent tools**: `amendMemory(memory_id, content)` and
  `forgetMemory(memory_id, reason)`; `readMemory` already returns each memory's
  `id` (verified via `MEMORY_CARD_FIELDS`).
- **Client**: `amend_memory` (PATCH), `forget_memory` (DELETE).
- **Server**: `PATCH /agentic/memories/{id}` (amend content) and `DELETE
  /agentic/memories/{id}` (hard delete — acceptable per brief, memories are
  project-scoped working state). Scope-aware ownership (`_assert_memory_access`):
  user memory needs the owner, project memory needs project access, workspace
  memory needs workspace membership; otherwise 404.

### 3. Taxonomy + prompt + docs
- `UI_TOOLS` gains `editInsight` / `retractInsight`; taxonomy comment + README
  updated (edit/retract render cards; amend/forget are write tools).
- System prompt: edit-over-renote + same-turn-confirmation rule for insights;
  amend-existing / forget-by-id rule for memories.
- New tool-activity headlines for all four tools.

## Directus migration (answering the coordinator's question)
A migration change **was** needed, but not for the status value itself:
- `agent_insight.status` is a free-text `character varying(255)` with a
  select-dropdown interface (actual existing choices are `new / reviewed /
  archived`, not the brief's guessed `new/tracked/in_progress/shipped`). So
  writing `status="retracted"` persists with **no DB schema change**.
- I still extended `add_agent_insight_schema.py` idempotently: added a new
  `retracted_reason` **text column** (this is the real schema addition — prod
  must run the migration to store retraction reasons), added `"retracted"` to
  the status dropdown choices, and added an idempotent `ensure_field_choices`
  helper that PATCHes the status field's options on existing installs so the
  admin dropdown offers "retracted" too (cosmetic; column stays free text).

## QA gates (all pass)

- `cd echo/agent && uv run pytest -q` → **119 passed, 4 warnings**
- `cd echo/server && uv run ruff check .` → **All checks passed!**
- server focused pytest (dummy env) `tests/api/test_agentic_api.py` → **45
  passed, 2 warnings** (one benign Redis-connect warning from the pre-existing
  stop-run test; no local Redis)
- `cd echo/frontend && ./node_modules/.bin/tsc --noEmit` → exit 0
- `./node_modules/.bin/biome lint . --diagnostic-level=error` → **Checked 451
  files, no errors**
- `./node_modules/.bin/vitest run src/components/chat/agenticToolActivity.test.ts`
  → **10 passed** (edited + retracted + legacy + id fixtures)
- `lingui extract` (en-US source 3600 msgs) + `lingui compile --typescript`
  → Done

## Files touched
10 source files (agent.py, echo_client.py, README.md, test_agent_tools.py;
agentic.py, test_agentic_api.py; add_agent_insight_schema.py;
agenticToolActivity.ts, InsightNoteCard.tsx, agenticToolActivity.test.ts) plus
16 regenerated lingui locale artifacts.
