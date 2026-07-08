# Brief: Wave 28 — the tabbed living canvas

Start: `git fetch origin && git checkout -b sameer/tabbed-canvas origin/main`.
Do NOT run any other git write commands.

Required reading, in order:
1. echo/docs/plans/canvas-ux-handoff.md — the design contract (styling +
   judgment rules). This file is on disk, untracked; treat it as source
   material and keep it in the tree.
2. echo/docs/plans/canvas-update-modes.md — why updates must be additive.
3. echo/server/dembrane/canvas/ (service.py, ticks.py) and the generation
   prompt path — current single-HTML tick architecture.

## The model (decided by the owners, 2026-07-08)

The canvas is a set of TABS. Each tab is a smart default with a FIXED shape;
only its content updates. The tick is a sequence of per-tab jobs and every
job is ADDITIVE — nothing rebuilds from scratch, unchanged tabs render
unchanged.

v1 tabs, in this order: **Crux**, **Concept cloud**, **Story**.
(Trace behaves as an interaction inside cloud/story, not its own tab.
Audit log / Munching / Host guide / Monitor are later waves — leave room.)

## What to build

1. **Ledgers (the additive substrate).** Persist per-loop working state so
   ticks append instead of regenerate:
   - quotes ledger: {id, who (or null — attribution perfect or absent),
     quote (verbatim, uncleaned), source conversation_id + chunk id if
     available, when}
   - concepts ledger: {id, phrase (from the transcript only), quote_ids,
     size tier, first_seen, last_reinforced}
   - crux: single current question + history of updates
   - host_items: entries the host adds via chat (see tool below): {id, text,
     person/label optional, target tab, source chat_id/message_id, added_at}
   Choose storage pragmatically (JSON fields on the loop or a small
   collection; migration must be idempotent, echo/directus/migrations
   add_*_schema.py pattern).

2. **Per-tab tick jobs**, replacing the monolithic regenerate:
   a. extract NEW verbatim quotes from transcript added since the last tick
      -> append to quotes ledger (quote-tracing rules in the handoff:
      verbatim copied, sentence boundaries, no receipt no entry).
   b. merge concepts additively (checklist in the handoff: grep test,
      size = repetition × spread, exactly 3 XL, ~20 tile cap, room's
      metaphors only). Existing concepts may grow/shrink tier; they are
      never dropped silently — removals must be logged in the run record.
   c. update the crux (rules in handoff: one question, updated never
      appended, newcomer-answerable, invitation phrasing).
   d. refresh the story slides around the durable material.
   e. render host_items faithfully inside their target tab — exact text,
      never paraphrased, never lost on refresh.
   The no-new-content no_op must still short-circuit scheduled ticks when
   nothing new arrived (manual ticks bypass, as today).

3. **Rendering: single sanitized HTML fragment** (same pipeline as today —
   generations stay body fragments, SSE nudge unchanged). Inside it:
   - the tab bar per the handoff (quiet text, 2px royal underline). The
     sanitizer likely strips <script>; use a CSS-only tab mechanism
     (hidden radio inputs + labels, or :target) — verify it SURVIVES
     _sanitize round-trip with a unit test.
   - brand kit v2: the handoff tokens replace the current canvas kit
     (parchment ground, royal as the only interactive color, borders not
     shadows, DM Sans 400/500/600, amber = just-landed, max one kicker per
     screen). Keep whitelabel logo behavior as-is.
   - traceable quotes: dotted royal underline; CSS-only expansion (e.g.
     details/summary styled per the trace row: quote card with royal left
     stripe, speaker, when). Claims without quote ids get NO underline.
   - concept cloud styling per handoff (±1.2° rotation, 7s float, four
     size classes, reduced-motion fallback).
   - mobile responsive: no page-in-page, no absurd margins (owner rule).

4. **Agent chat verb** in echo/agent/agent.py: `addToCanvas` (and
   `removeFromCanvas`) — appends/removes a host_item with target tab.
   Acts IMMEDIATELY like editCanvas (no proposal card), echoes one plain
   sentence, then enqueues a manual tick so the wall shows it in seconds.
   Prompt: when the host says "put X on the wall", "add <person>'s
   reflection", "pin that" — use this tool in the same turn, never stuff
   the item into the brief (named antipattern).

5. **Model discipline**: the tick prompts must be written for a Flash-class
   model — explicit checklists from the handoff pasted in, subtractive
   rules, no room for extrapolation. Keep prompts in code (config-in-code).

Compatibility: existing canvases without tab config keep working (default
them to the v1 tab set on next tick or render legacy-style — your call,
document it). Preview/try-now must produce the same tabbed output.

## QA gates

- server: `cd echo/server && uv run ruff check .` + focused pytest for
  canvas/ticks/ledgers + the sanitizer round-trip test for the tab
  mechanism and trace expansion.
- agent: `cd echo/agent && uv run pytest -q` (tool + prompt-rule tests).
- migration: idempotent (run twice locally against a scratch check if
  feasible, else assert guards in code).
- frontend untouched unless strictly needed; if touched: tsc, biome lint,
  lingui extract+compile.
- No git write commands beyond the initial checkout.

Report -> echo/docs/plans/smart-loop-briefs/wave28-REPORT.md: what shipped,
file list, gate results, the compatibility decision, and anything cut.
