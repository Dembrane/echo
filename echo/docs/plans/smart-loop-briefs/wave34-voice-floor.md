# Brief: Wave 34 — the voice floor: selectivity applies to material, never to voices

Start AFTER 28h is merged: `git fetch origin && git checkout -b
sameer/voice-floor origin/main` (verify the cloud-scatter work is in
main; if not, report and stop).

## The invariant (owner decision, 2026-07-09)

Live failure it prevents: the first backfill of the 13th-week wall
extracted 5 quotes, ALL from one conversation; Usama (remote, quieter
audio, distinct accent) contributed zero receipts and vanished from the
wall silently. The extraction rule "only what does real work" is right
for content and wrong for people.

The invariant, enforced in CODE after extraction, never left to the
model: every voice with words in the gathered transcript ends the tick
either (a) with at least one accepted receipt, or (b) named in the
under-heard block of the Open questions tab, with the honest reason.
No third state. A voice is never silently absent.

## Implementation (echo/server/dembrane/canvas/)

1. Voice inventory at gather time: per conversation, the set of speaker
   labels present (attribution data already flows for board cards; where
   the transcript has no speaker attribution, the conversation itself is
   the "voice" — its participant_name/label).
2. Post-extraction coverage check in the tick: voices with material in
   THIS tick's gathered window but zero accepted receipts overall ->
   ONE targeted second extraction pass, scoped to only that voice's
   passages (filter chunks/segments by speaker where attribution exists,
   else the whole conversation), with a prompt that says: this voice has
   no receipts on the wall yet; extract their strongest 1-3 verbatim
   passages if ANY passes the receipts bar. Budget: one extra model call
   per uncovered voice per tick, max 3 per tick (record when the cap
   truncates).
3. Still nothing? The voice lands in under-heard (Open questions tab)
   with the reason: "no receipt-quality passage yet" — and the run
   detail records it ("voice floor: Usama -> under-heard").
4. Board grouping "person": a voice with receipts but no board card gets
   its card on the next render (verify this already holds; test it).
5. Run/generation detail gains a voices line:
   "voices: 6 heard, 1 under-heard (Usama)".

## QA gates

- Tests: uncovered voice triggers exactly one targeted pass; covered
  voices trigger none; still-uncovered voice renders in under-heard AND
  run detail; cap at 3 targeted passes recorded honestly; no-attribution
  conversations use the conversation label as the voice.
- cd echo/server && uv run ruff check . ; FULL canvas pytest suite (all
  test_canvas_*.py + tests/api/test_bff_canvases.py +
  tests/api/test_agentic_api.py).
- Report -> echo/docs/plans/smart-loop-briefs/wave34-REPORT.md.
