# Brief: Wave 36 — what the agent mints, the host can amend by id

Worktree: /Users/sam-dembrane/orca/workspaces/echo/driveby, branch
sameer/edit-by-id (already created from origin/main). NO git commands.

Owner principle (2026-07-09): "we should also be able to edit stuff like
noted insights — other edits might be needed by id." Generalized: every
durable record the agent creates must be amendable and retractable BY ID
in the same chat, and the UI card must reflect the change. No invisible
mutations (the no-phantom-actions rule applies to edits too).

## 1. Insights: editInsight / retractInsight

- Agent tools (echo/agent/agent.py):
  - editInsight(insight_id, content?, kind?, suggested_capability?) —
    partial update; at least one field required.
  - retractInsight(insight_id, reason) — sets status="retracted" and
    stores the reason; never hard-deletes (the dembrane team may already
    have read it — retraction is itself signal).
- noteInsight must return the insight id in its payload (verify #837's
  agent_insight_note payload includes it; add if missing) and the
  InsightNoteCard must show a short id suffix so the host can reference
  it ("edit insight a1b2").
- Server (echo/server/dembrane/api/agentic.py): PATCH
  /agentic/insights/{id} and POST /agentic/insights/{id}/retract with
  the standard agent-token auth; ownership check: the insight's
  project_id must match the authenticated run's project scope (follow
  the canvas-history endpoint pattern from #838).
- Frontend: edited insights render an updated card state (parse the
  editInsight/retractInsight tool events; retracted = muted card with
  "retracted" chip and reason). Old payloads keep parsing.
- Prompt rules: when the host corrects or withdraws a noted insight
  ("that's not right", "actually scrap that note"), use these tools in
  the same turn and confirm in one sentence WHAT changed. Never re-note
  a corrected insight as a new row when an edit will do (id continuity
  preserves the dembrane team's thread).

## 2. Memories: amendMemory / forgetMemory

- readMemory must return each memory with its id (verify; add if
  missing).
- Agent tools: amendMemory(memory_id, content) and
  forgetMemory(memory_id, reason) with matching agentic endpoints
  (PATCH /agentic/memories/{id}, DELETE or retract-style — follow
  however remember/readMemory persist today; hard-delete is acceptable
  for memories since they are project-scoped working state, unlike
  insights).
- Prompt rules: when the host corrects a remembered fact, amend the
  EXISTING memory rather than layering a contradicting one; when they
  say to forget something, forgetMemory and confirm plainly.

## 3. Taxonomy + docs

Add the new tools to the UI/write taxonomy from #837 (editInsight,
retractInsight render card updates -> UI_TOOLS if the card state changes
via tool event; amend/forget are write tools). Update the README
taxonomy section and each docstring ("amends by id — use when the host
corrects...").

## QA gates (run all, report verbatim)

- cd echo/agent && uv run pytest -q — tool wiring, payload ids, prompt
  rules (edit-over-renote, same-turn confirmation).
- cd echo/server && uv run ruff check . && dummy-env focused pytest
  tests/api/test_agentic_api.py — new endpoints: auth, ownership,
  partial update, retract keeps row with status+reason, memory amend/
  forget.
- cd echo/frontend && npx tsc --noEmit && biome lint; lingui
  extract+compile after string changes; vitest for the card parser
  (edited + retracted + legacy fixtures).
- Report -> echo/docs/plans/smart-loop-briefs/wave36-REPORT.md.
