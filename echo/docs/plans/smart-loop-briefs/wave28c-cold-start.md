# Brief: Wave 28c — cold-start backfill + never render an empty wall over a full one

Continue on branch sameer/tabbed-canvas. Note: origin/main now CONTAINS your
squashed wave 28+28b work (#830). First run:
`git fetch origin && git checkout -b sameer/tabbed-canvas-28c origin/main`
and work there. No other git write commands.

## Live failure (echo-next, report 11, generation 3f987bfc)

A manual tick on the existing 13th-week retro canvas produced an EMPTY
tabbed skeleton ("Concepts will appear as transcript receipts arrive")
over a wall the room spent 100 minutes building. Two causes:

1. Ledgers start empty for existing loops, and extraction only reads
   transcript NEW since the last tick — for an old canvas that is zero, so
   nothing ever backfills.
2. The renderer happily stores an empty-state fragment even when the
   previous generation had real content.

## Fixes

1. **Cold-start backfill.** When the quotes ledger is empty (first tabbed
   tick for a loop), gather the FULL transcript window for the report
   scope, not the delta. Process per conversation (one extraction call per
   conversation, sequentially) so long histories fit the model window.
   Subsequent ticks stay delta-based. Record "backfill: N conversations"
   in the run detail.

2. **Empty-over-full guard.** If after extraction+merge the state has no
   quotes, no concepts, and no host items, and a previous generation with
   content exists, no_op the tick (record why) instead of storing the
   skeleton. The empty-state skeleton is only ever stored when there is no
   prior generation at all (a genuinely new canvas).

3. **Crux placeholder**: with an empty state on a NEW canvas the
   placeholder question is fine; make sure the model-written crux replaces
   it on the first content-bearing tick (should already, verify in test).

## QA gates

- Tests: cold-start backfill uses full window then flips to delta;
  empty-extraction on a loop with a prior contentful generation -> no_op,
  prior generation stays newest; genuinely new canvas still renders the
  skeleton.
- cd echo/server && uv run ruff check . ; focused canvas pytest.
- Report -> echo/docs/plans/smart-loop-briefs/wave28c-REPORT.md.
