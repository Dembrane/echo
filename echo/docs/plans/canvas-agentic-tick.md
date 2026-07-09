# Design: the agentic tick — every canvas update is a headless run

Owner decision, 2026-07-09 (morning of the 13th-week retro day 2).

## The shape

The canvas tick stops being a fixed 1-2-3-4-5 pipeline and becomes a
HEADLESS AGENTIC RUN: the same harness as the project chat agent (same
model, memory injection, tool budget discipline, honesty rules), executed
without a human on the other side, stored as a project chat that is HIDDEN
from the Ask list (chat kind: "canvas_tick" or hidden flag). Every tick is
therefore fully replayable and readable in the existing chat UI — tool
calls, reasoning, receipts, everything.

## What the tick agent gets

- Read tools shared with chat: grepConversationSnippets,
  listConversationSummary, listConversationFullTranscript, readMemory,
  readGoal, getProjectSettings (post-rename names).
- Canvas tools: readCanvasTab, editCanvasTab (surgical JSON edits to a
  tab's state), plus the pipeline steps AS TOOLS: gatherNewTranscript,
  extractReceipts (returns validated quotes only), mintVersion (render +
  store generation).
- A per-tick tool budget (~6-8 calls) and the tab skills (per-tab
  contract files: crux/cloud/story/board/open-questions rules distilled
  from the canvas-ux-handoff) injected as skill context.

## What stays below the agent's reach (non-negotiable)

1. RECEIPT VALIDATION is tool-layer code: every quote returned by
   extractReceipts has passed the verbatim-substring check; the agent
   cannot forge or bypass evidence. No receipt, no underline — by
   construction, not by prompt.
2. RENDER is deterministic: mintVersion turns JSON state into HTML with
   zero model involvement. The agent decides WHAT to update, never how it
   is drawn.
3. VOICE FLOOR (wave 34 invariant): per-speaker coverage is checked in
   code after extraction; selectivity applies to material, never to
   voices; uncovered voices trigger a targeted pass or land in
   under-heard honestly.

## Versions and audit

- Each generation stores state_snapshot (full JSON: tabs + ledgers) next
  to content_html — versions are diffable, restorable, surgically
  editable (wave 33).
- The Audit log tab renders the run ledger. Entry grammar (refined with
  owner): `HH:MM · outcome — cause · links`; a mint and its run are one
  entry with `run ↗` (hidden chat) and `view version ↗` suffix links;
  no_ops render honestly ("no change — nothing new heard"); kept-out
  counts surface in the collapsed line. Full spec lives in
  wave28g-trace-audit.md. Applies/host items keep chat/message links.
- "Questionable in chat": the visible project chat agent can read these
  hidden runs (readChat / readCanvasHistory) and answer "why did this
  change" from the actual run, then noteInsight on the owner's verdict.

## Why this is safe now

The night's fences carry over unchanged: per-turn/run tool budgets,
no-phantom-actions, mechanical receipts, empty-over-full guard, cadence
window locks, banned-copy checks. The agentic layer only replaces the
PLAN of a tick (which tabs need work, what to look at), which was the
part hardcoded 1-5 could never do well.

## Sequencing

28f (rename/spacing/+button) -> 34 (voice floor) -> 28g (trace + audit
tab, schema already includes optional run-chat links) -> 32 (tool renames
+ noteInsight visibility + editProjectTags) -> 33 (state_snapshot +
readCanvasTab/editCanvasTab + per-tab edit buttons) -> 35 (this note:
headless run migration of the tick).
