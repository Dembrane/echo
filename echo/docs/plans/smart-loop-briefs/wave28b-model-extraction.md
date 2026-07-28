# Brief: Wave 28b — put the model back in the tick

Continue on branch sameer/tabbed-canvas (your wave-28 work). No git write
commands. (canvas-update-modes.md being absent was fine — ignore.)

## What is wrong

Wave 28 made the per-tab jobs fully deterministic: every transcript
sentence >=16 chars becomes a "quote", `_concept_phrase` picks the first
half of non-stopword words as a "concept", and the crux is a template
string. That is ingestion wearing the judgment layer's clothes. The
handoff's checklists are instructions FOR A MODEL ("written so a
Flash-class model can follow it") — the design is model judgment +
mechanical receipt verification + deterministic render. You built the
third part well; restore the first and add the second.

## The fix

1. **One MULTI_MODAL_FAST structured call per content-bearing tick**
   (same router used by the legacy path). Input: the NEW transcript since
   the last tick (cap the window sensibly) + a compact summary of current
   ledgers (existing concept phrases + tiers, current crux, story
   headings). Prompt = the judgment-layer checklists from
   echo/docs/plans/canvas-ux-handoff.md pasted nearly verbatim (quote
   tracing PROCESS rules, concept cloud checklist 1-9, crux rules).
   Output JSON:
   - quotes: [{who|null, quote, conversation_id, chunk_id|null}] — only
     passages that do real work (name a decision, coin a phrase, answer or
     contradict). A 30-min transcript should yield dozens, not hundreds.
   - concepts: [{phrase, supporting_quote_indices}] — new or reinforced.
   - crux: {question} or null if unchanged.
   - story_slides: [{eyebrow|null, heading, lede, quote_indices}].

2. **Mechanical receipt validation in code (the grep test, enforced).**
   After the model returns:
   - accept a quote ONLY if it appears verbatim (whitespace-normalized,
     case-preserved) as a substring of the gathered transcript text for
     that conversation; otherwise drop it and record the rejection in the
     run record (nothing silently swallowed).
   - accept a concept ONLY if its phrase is a substring of at least one of
     its accepted supporting quotes.
   - a slide lede references quote ids only when those quotes were
     accepted; otherwise render it as plain synthesis (no trace markup —
     no receipt, no underline).
   Keep repetition × spread scoring and the 3 XL / ~20 tile caps in code
   as you have them — code enforces scarcity, the model proposes.

3. **Crux**: the model writes it (one question, newcomer-answerable,
   invitation phrasing); code keeps your update-not-append history logic
   and rejects empty/over-long questions.

4. **On model failure**: keep previous state untouched, no_op the tick,
   record the error on the run record. DELETE the deterministic
   sentence-spam path (_sentences-as-quotes, _concept_phrase) rather than
   keeping it as a fallback — a garbage wall is worse than an unchanged
   wall.

5. Rendering, ledgers persistence, host_items, addToCanvas, migration,
   CSS-only tabs: unchanged from wave 28.

## QA gates

- Update tests: mock the model call (as existing tick tests do); add
  rejection tests (fabricated quote -> dropped + recorded; concept without
  a home quote -> dropped), caps, crux update-not-append, model-failure ->
  no_op with previous state intact.
- cd echo/server && uv run ruff check . ; focused pytest for canvas files.
- cd echo/agent && uv run pytest -q (should be untouched).
- Report -> echo/docs/plans/smart-loop-briefs/wave28b-REPORT.md.
