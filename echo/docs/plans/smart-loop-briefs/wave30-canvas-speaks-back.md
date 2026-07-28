# Brief: Wave 30 — the canvas speaks back

Start: `git fetch origin && git checkout -b sameer/canvas-speaks-back
origin/main` (main now includes the tabbed canvas, #830). No other git
write commands.

## The gap (owner's words, 2026-07-08)

"I did not find it speaking to me. I constantly found myself saying: hey,
I'm not seeing this. It never once asked what I really want." The host
always had to tell the canvas what was missing; the agent never asked.

## What to build

When the host is in a chat and a canvas tick has produced signal since the
last agent turn, the agent may ask AT MOST ONE pointed question — and only
at a REAL fork. Not a survey, not "anything else?", not a menu.

1. **Context injection** (echo/agent/agent.py + echo_client.py): for the
   chat's linked canvas(es), fetch the most recent agent_loop_run rows
   (status + detail — details now carry ledger deltas and receipt
   rejections, e.g. "rejections: quote[3] not found verbatim", "backfill:
   5 conversations", "0 quote(s), 0 concept change(s)") and inject a
   compact "## Canvas activity since last turn" block into the system
   context for the run. Keep it small: last ~5 runs, detail strings
   truncated.

2. **Prompt rule**: if the activity shows a genuine fork, ask ONE pointed
   question in the same turn as the rest of the reply. Real forks, with
   examples:
   - receipts were rejected ("I dropped two quotes I could not verify
     verbatim — want me to relisten to that stretch of Cesare's
     conversation?")
   - a tab is starving ("nothing has earned XL in the cloud yet — loosen
     the two-people rule, or wait?")
   - repeated no_ops while the host keeps asking for updates ("the loop
     has heard nothing new for 40 minutes — is the recorder still on?")
   Named counterexamples (put these in the prompt): never ask permission
   to do something you can already do; never ask more than one question;
   never ask when there is no fork — silence is correct then.

3. **Honesty**: the question must be grounded in the injected run details
   only — never invent activity (no-phantom-actions rule applies).

## QA gates

- cd echo/agent && uv run pytest -q; add tests: prompt contains the
  one-question rule + counterexamples; context builder renders run
  details; no canvas -> no activity block.
- If echo_client changes: client tests for the new fetch.
- Server untouched (the run details already exist). Frontend untouched.
- Report -> echo/docs/plans/smart-loop-briefs/wave30-REPORT.md.
