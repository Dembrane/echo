# Brief: Wave 33 — per-version JSON snapshots, readCanvasTab / editCanvasTab, edit buttons

Start AFTER 28h is merged: `git fetch origin && git checkout -b
sameer/canvas-json-surgery origin/main` (verify the cloud-scatter/board-
seeding work is in main; if not, report and stop).

Owner decision (2026-07-09): "we need a JSON store for each canvas
version along with the html... so JSON edits are always surgical and the
agent should know when to edit what." Live proof of the gap: asked to
find concept-cloud duplicates, the agent had to grep raw HTML because no
tool exposes the ledgers.

## 1. state_snapshot on every generation

canvas_generation gains a state_snapshot JSON field: the full canvas
state (tabs config + all ledgers + crux + host items + story slides +
board cards + open questions) exactly as rendered into that version's
content_html. Written at mint time in the same store call. Extend the
wave28 migration script idempotently. Backfill is NOT required for old
generations (null = pre-snapshot version; tools must say so honestly).
This makes versions diffable and restorable: a follow-up wave adds
restore; do not build restore now.

## 2. readCanvasTab (agent tool + endpoint)

readCanvasTab(canvas, tab) -> the CURRENT JSON state for that tab
(e.g. concept_cloud -> concepts with ids, phrases, tiers, quote_ids and
their receipt quotes; board -> cards; crux -> question + history).
Server: GET /agentic/projects/{pid}/canvases/{cid}/tabs/{tab} following
the history endpoint's auth pattern (#838). Optional version param
(generation id) reads that version's state_snapshot instead; null
snapshot -> honest "version predates snapshots" response.
Agent prompt: for ANY question about what is on the wall (duplicates,
what concepts exist, who has receipts, why is X sized that way), use
readCanvasTab — never inspect canvas HTML again.

## 3. editCanvasTab (agent tool + endpoint)

editCanvasTab(canvas, tab, operations) — surgical JSON operations, NOT
freeform state replacement. v1 operation set (validated server-side):
- concept_cloud: merge_concepts(ids, into_phrase?), remove_concept(id),
  rename_concept(id, phrase — must still pass the receipts containment
  check against its pooled quotes, else 422)
- board: remove_card(id), set_card_label(id, label)
- crux: set_question(text — same rules as extraction: one question,
  history preserved)
- story: remove_slide(index), reorder_slides(indices)
- any tab: remove_host_item(id) (parity with removeFromCanvas)
Each edit: applies to the live ledgers, mints a new generation
(tick_kind="edited", with state_snapshot), writes an audit history entry
(cause: chat edit, linking chat/message id), publishes the SSE nudge.
Receipts invariants are enforced server-side: an edit can never create
an unreceipted underline (rename revalidates; merges pool receipts).
Agent prompt: prefer editCanvasTab for content surgery; editCanvas
(HTML) remains ONLY for pure presentation tweaks that no operation
covers, and says so in its docstring.

## 4. Per-tab edit buttons on the wall

Next to each tab's content, a small quiet edit affordance (pencil,
handoff styling: royal, no button chrome) linking target=_top to the
prefilled chat route (#835/#836 pattern):
"Edit the {tab label} tab of the {report name} canvas: ". Sanitizer
round-trip test. The + button pattern in ledgers.py shows the URL
construction.

## QA gates

- Server: ruff; FULL canvas suite + agentic API tests; new tests:
  snapshot written at mint and equals rendered state; readCanvasTab
  shapes per tab; version param + pre-snapshot honesty; each edit
  operation (incl. rename receipts-containment 422, merge pooling,
  audit entry + edited generation + snapshot); edit buttons survive
  sanitizer.
- Agent: uv run pytest -q; tool wiring + prompt rules (readCanvasTab
  over HTML; editCanvasTab over editCanvas for content).
- Migration idempotent.
- Report -> echo/docs/plans/smart-loop-briefs/wave33-REPORT.md.
