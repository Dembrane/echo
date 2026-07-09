# Brief: Wave 28g — Trace as a destination, Audit log as a tab, history the agent can answer for

Start AFTER 28f is merged: `git fetch origin && git checkout -b
sameer/canvas-trace-audit origin/main` (verify 28f in main; if not, report
and stop). Read echo/docs/plans/canvas-ux-handoff.md (Trace + Audit rows,
quote-tracing RENDER spec) first.

Owner (2026-07-09, grounded in the sam/jor project conversations): trace
and audit must stop being scattered clicks. Three builds:

## 1. Trace is a view you land in, not an inline flap

Clicking ANY traceable element (dotted-underline claim or quote in Story,
Cloud, Crux, Board) takes you to the Trace tab, scrolled to that claim's
entry: the claim big, then one card per supporting quote (exact words ·
speaker · when · source link) per the handoff RENDER spec — every voice
shown, never a composite quote.

Mechanism must survive the sanitizer, CSS-only: switch the tab mechanism
to anchor/:target based (tab sections with ids, tab bar = plain links) so
a deep link like #trace-<claim-id> both activates the Trace tab
(`section:has(:target)` with the existing radio approach as fallback) and
scrolls to the entry. Keep the current inline details/summary as
progressive fallback if :has is unavailable. Round-trip sanitizer test
required.

## 2. Audit log is the fifth tab (pull-request formality)

Render from data that already exists — agent_loop_run + canvas_generation
details + config revisions + host items:
- one accordion entry per event, newest first (white accordion, royal
  border when open, tabular timestamps per the handoff)
- each entry: when · what kind (scheduled tick / manual / applied brief /
  host item added|removed / edit) · the diff summary (the detail strings
  already say "N quotes, M concepts, crux changed, rejections: ...") ·
  WHICH chat/message led to it when attributable (config revisions from
  chat applies, host items carry chat_id/message_id — link to the chat)
- rejections and omissions render honestly (the pressure valve: "left off
  the wall on judgment" belongs here)
- cap the rendered tail (~30 entries) with a link to the dashboard
  version history (wave 31 ships see-all versions) for the rest.
- entry format (owner-approved): collapsed line grammar is
  `HH:MM · outcome — cause · links`, newest first, tabular-nums times:
    09:42 · v14 minted — 2 quotes added, crux updated          run ↗
    09:37 · no change — nothing new heard (12 min quiet)       run ↗
    09:31 · v13 minted — Board tab added by you in chat ↗ — all tabs redrawn
    09:24 · pinned to Board — "Cesare's reflection" by you in chat ↗
    09:20 · v12 minted — 9 quotes in, 2 kept out ⚠             run ↗
  Rules: a mint and its run are ONE entry (run link as suffix, never a
  separate line); mint lines always carry a one-phrase diff; no_op
  entries render as honest "no change — nothing new heard"; `kept out`
  (rejections + judgment omissions) is promoted into the collapsed line
  whenever nonzero; human causes are named and link the exact chat
  message; cadence causes get no link. Expanded accordion sections:
  heard / added / updated / kept out / cause, plus `view version`.
  Versions display as small per-canvas ordinals (v12), not uuids.
- entries are backed by a JSON object {at, kind, version, cause{type,
  chat_id, message_id, run_chat_id}, heard, changes, kept_out} — the
  same object the agent reads via readCanvasHistory, so the tab and the
  chat answer from one source. Runs will later carry run_chat_id
  (headless tick runs, echo/docs/plans/canvas-agentic-tick.md) — include
  the field NOW, render the run ↗ link when present.

## 3. The history is readable and questionable in chat

- echo/agent: a `readCanvasHistory` tool (canvas by id/name, page of
  audit entries + generation summaries via a small server endpoint —
  extend the #832 canvas-activity endpoint family, same auth pattern).
- Prompt rules: when the host asks "why did this change / what happened
  to X / who added this", answer FROM the fetched history entries only
  (receipts discipline — cite the tick time and cause, link the chat when
  attributable; never reconstruct from memory). When the host reviews a
  change and expresses judgment (this was wrong / keep doing this / why
  is it missing), record an insight (recordInsight) capturing the review
  verdict with reach-back ids — that is the review loop the owner wants.
- Tests: tool wiring, prompt rules, endpoint shape/auth/empty cases.

## QA gates

- Server: ruff + focused canvas pytest + sanitizer round-trip for the
  :target tabs and trace anchors; endpoint tests.
- Agent: uv run pytest -q.
- Frontend untouched (wave 31 owns dashboard-side history).
- Report -> echo/docs/plans/smart-loop-briefs/wave28g-REPORT.md.
