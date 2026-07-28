# Brief: Wave 28e — the Board primitive + applied briefs must visibly matter

Start: `git fetch origin && git checkout -b sameer/canvas-board origin/main`
(main will include 28d by the time you start; verify with
`git log --oneline -3 origin/main` and if 28d ("lens") is NOT merged yet,
say so in the report and branch from origin/main anyway, rebasing later is
the coordinator's problem — do not wait).

## Live evidence (echo-next chat e59c0720, canvas 12)

Host asked in chat for "a good summary person by person" like an earlier
canvas version had. The agent proposed a brief update promising the loop
would "rebuild the board, presenting a clear person-by-person summary".
Host applied TWICE. Both post-apply generations: "0 quote(s), 0 concept
change(s), crux unchanged, story unchanged" — identical wall. Two gaps:

1. There is no tab shape that can express person-by-person.
2. An applied brief cannot change which tabs exist, so shape requests are
   dead on arrival — and nothing tells the host that.

## What to build

1. **Board primitive** (new tab kind `board`): a dense grid of white cards
   (per the handoff "Canvas" row: 5-col grid at desktop, 9px gaps,
   `12px 13px` blocks) keyed by a grouping the config declares — v1
   grouping: `person`. Each card: the person/label as header, a short
   model-written synthesis of THAT voice grounded in accepted quotes
   attributed to them (attribution perfect or absent: voices without
   attributed quotes render under one "the room" card rather than guessed
   names), plus 1-2 receipt quotes (traceable, same details/summary
   mechanism). Board state persists like the other ledgers and updates
   additively per tick (synthesis rewritten, receipts appended). The
   extraction call gains a `board_cards` output section only when a board
   tab is enabled.

2. **Tabs become config** (they already live on `canvas_tabs`): the
   applied brief maps to tab config. Extend the config revision/apply path
   so a proposal can declare tabs (e.g. add `board` with grouping person,
   drop `story`), defaulting to the current set when unspecified. The
   agent-side proposal tool schema gains an optional `tabs` field —
   proposeCanvas passes it through. v1 tab kinds: crux, cloud, story,
   host_guide (28d), board.

3. **Apply must visibly matter**: after an applied revision, the manual
   tick re-renders with the new tab set immediately (even with zero new
   transcript — tab-set changes bypass the empty-over-full guard because
   the STRUCTURE changed, content did not). If an applied brief requests
   something no primitive can express, the run detail must say so
   plainly ("brief asks for X; no tab primitive supports it") so the
   agent (canvas-activity block, #832) can surface it instead of promising
   a rebuild that cannot happen.

4. **Agent prompt** (echo/agent/agent.py): when the host asks for a
   structural view that maps to a primitive (per-person, per-table board),
   the proposal declares the tab change. When it maps to NO primitive, say
   that honestly in chat and record an insight — never promise the loop
   will "rebuild" into a shape that does not exist.

## QA gates

- Server: ruff + focused canvas pytest; tests: board render from
  attributed quotes; unattributed voices fold into "the room"; tab-set
  change re-renders on apply despite no new content; unsupported-shape
  detail recorded.
- Agent: uv run pytest -q; tests for the tabs field passthrough + honest
  no-primitive reply rule.
- Migration: extend idempotently if new fields are needed.
- Report -> echo/docs/plans/smart-loop-briefs/wave28e-REPORT.md.
