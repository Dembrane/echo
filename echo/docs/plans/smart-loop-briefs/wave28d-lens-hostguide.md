# Brief: Wave 28d — the lens, the host guide, and honest backfill

Start: `git fetch origin && git checkout -b sameer/canvas-lens origin/main`
(main includes #831). No other git write commands.

## Live evidence (echo-next, report 12 "13th Week Retrospective Wall")

Owner created a canvas with brief "13th Week Retrospective Wall" over a
project holding 5 conversations (a 92k-char team retrospective + two
product-design talks + two short ones). The generated wall (generation
609701ad) is entirely about the product-design talks: crux "How should we
design the user-friendly interface for resolving zero-sum merge
conflicts...", concepts "playbook", "merge conflict", "mainline of code".
Ledger state: 5 quotes total, ALL from one conversation (e7c27eb8, the
lunch design talk); the retrospective itself contributed ZERO quotes,
silently. Owner's verdict: "it should have been clear that it is about the
13th week rather than building the canvas. Also I don't see the host
guide."

Three defects:

## 1. The extraction never sees the brief (the lens is disconnected)

The loop brief (canvas_config_revision.brief — shape + lens, the host's
instructions) must be part of the extraction call. Add to the extraction
system/user prompt: the report name and the current brief, with the
instruction: "This wall exists for the purpose described in the brief.
Extract ONLY material that serves it. Conversations unrelated to this
purpose may legitimately yield zero quotes — returning nothing for them is
correct, not a failure. At most one small tile of off-topic room flavor is
allowed." Also honor the brief's guardrails (e.g. this brief forbids
pre-populating static transcript snippets into structure).

## 2. Host guide is a missing v1 tab

The owners' chosen starter trio (2026-07-08 talk) was Crux, Concept cloud,
Host guide; add Host guide as the fourth fixed tab (order: Crux, Concept
cloud, Story, Host guide). Shape (fixed, per the handoff design language):
a short model-written section grounded ONLY in the brief + current ledgers
+ recent run activity:
- "where the room is" (2-3 sentences, no invented facts),
- "what to ask next" (2-3 concrete questions the host can say out loud),
- "under-heard" (voices/threads with few or no receipts yet, from ledger
  attribution — omit the block entirely rather than guess).
Persist it like the other per-tab state (e.g. canvas_host_guide JSON on
the loop; extend the wave28 migration script idempotently). It updates on
ticks like the crux (replace, not append).

## 3. Backfill is silently partial

The retro conversation produced zero quotes with no trace of why. Fix:
- per-conversation extraction outcomes recorded in run/generation detail:
  "backfill conv <shortid>: N accepted / M rejected" or "model error:
  <reason>" — a failed conversation must be visible, never skipped
  silently (also verify why the live detail carries no "backfill: N
  conversations" marker even though 28c added it — find and fix the gap).
- long transcripts must be windowed: split a conversation's transcript
  into ~20k-char windows, one extraction call each, so a 92k-char retro
  actually fits the model call instead of failing or truncating.
- a model error on one conversation/window must not abort the others.

## QA gates

- Tests: brief text lands in the extraction prompt; off-topic-yields-zero
  is accepted behavior (no retry storm); host guide renders in the tab bar
  + persists + replaces; long-transcript windowing produces multiple
  extraction calls; per-conversation failure recorded and non-fatal.
- cd echo/server && uv run ruff check . ; focused canvas pytest suite.
- cd echo/agent && uv run pytest -q if agent touched (should not be).
- Migration change stays idempotent.
- Report -> echo/docs/plans/smart-loop-briefs/wave28d-REPORT.md.
