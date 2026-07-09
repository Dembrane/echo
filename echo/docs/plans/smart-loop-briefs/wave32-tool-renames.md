# Brief: Wave 32 — tool renames, noteInsight becomes visible, editProjectTags

Worktree: /Users/sam-dembrane/orca/workspaces/echo/driveby, branch
sameer/tool-renames (already created from origin/main). NO git commands.

Owner decisions, 2026-07-09:

## 1. Convo -> Conversation(s), everywhere visible

Rename the agent tools (echo/agent/agent.py):
- findConvosByKeywords -> findConversationsByKeywords
- listConvoSummary -> listConversationSummary
- listConvoFullTranscript -> listConversationFullTranscript
- grepConvoSnippets -> grepConversationSnippets
Also reachOutToDembrane -> reachOutToDembraneSupport and
recordInsight -> noteInsight.

Compatibility is the hard part (learned from live Vertex 400s):
- Replayed histories contain the OLD tool names. At the history-replay
  boundary, normalize old->new (a rename map applied when rebuilding
  messages), so old runs replay cleanly. Do NOT register duplicate
  visible tools.
- The fused-parallel-call splitter in agent.py matches exact tool names —
  update its name list to the new names (and make sure the map handles a
  fused OLD name if one appears in a replayed history).
- grep the whole repo (agent prompts, skills, tests, frontend
  agenticToolActivity parsers, docs) for the old names; update every
  reference. Frontend parsers must accept BOTH old and new names in
  persisted event payloads (old chats must still render their cards).

## 2. noteInsight renders a card (no more invisible sends)

When noteInsight runs, the host must SEE what was sent. Frontend
(echo/frontend/src/components/chat/): parse the noteInsight (and legacy
recordInsight) tool event into a small card in the timeline: kind chip
(capability gap / friction / wish / praise), the content sentence, the
suggested capability if present, and a quiet "noted for the dembrane
team" line. Subtle variant, brand rules (lowercase dembrane, no bold,
Phosphor icon, no em dashes). Same containment as other cards (one
malformed payload never blanks the thread).

## 3. editProjectTags

New agent tool editProjectTags(add: list[str], remove: list[str]) ->
updated tag list. Server side: extend the agentic API
(echo/server/dembrane/api/agentic.py) with a tags update endpoint
following the existing auth/ownership pattern (getProjectTags's read
path shows the shape). Adding creates project_tag rows; removing deletes
by exact text match (case-insensitive), never touching tags in use by
conversations unless removal is explicit. Agent prompt: confirm in one
sentence what changed; tags are host-visible portal vocabulary.

## 4. UI tag in the tool taxonomy

Mark tools whose output renders dashboard UI (navigateTo, proposeCanvas,
proposeGoal, proposeProjectUpdate, noteInsight, sendProgressUpdate) with
a UI marker: a UI_TOOLS frozenset in agent.py next to the tool
definitions plus one docstring line each ("renders a card in the chat
UI"). Add a short section to the agent README or module docstring
listing the taxonomy (UI vs read vs write tools).

## QA gates (run all, report results verbatim)

- cd echo/agent && uv run pytest -q (update tests for renames; add
  replay-normalization test: history with old names rebuilds with new)
- cd echo/server && uv run ruff check . && focused pytest for
  tests/api/test_agentic_api.py (with the dummy-env pattern other briefs
  use)
- cd echo/frontend && npx tsc --noEmit && biome lint; lingui
  extract+compile after string changes; vitest for the insight-card
  parser (old + new name fixtures)
- Report -> echo/docs/plans/smart-loop-briefs/wave32-REPORT.md: what
  shipped, file list, gate outputs, anything deferred.
