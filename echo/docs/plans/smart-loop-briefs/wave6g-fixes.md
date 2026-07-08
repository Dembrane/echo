# Brief: Wave 6g - the composer morph is the bug, plus three verified fixes

Read wave6f-REPORT.md and wave6e-REPORT.md. The orchestrator's diagnosis of beat 1,
which reframes the fix - verify it before building:

The panel's stop path is now genuinely safe (single caller, armed by real activation on
the Stop control). The echo-next stop calls persist because THE AUTOMATION - and any
human - clicks the button where Send just was, while a run is in flight. The Send->Stop
in-place morph turns "send my next answer" into "kill the run". 6e's local repro passed
only because nobody interacted mid-flight. This explains beats 1 AND 5 (each Ask-home
phrase became a seeded chat + an eager follow-up click). Confirm from
wave6f-shots/wave6f-target-evidence.json timing if possible, then fix the DESIGN:

## 1 (HIGH): Send never morphs into Stop

- While a run is in flight, the primary control STAYS a send control. Typing and
  sending during a turn must do something honest: the backend supports appending a
  message to a run (`POST /agentic/runs/{id}/messages` - read api/agentic.py
  append_message + how the worker consumes queued turns) - wire the composer to append
  (the message shows in the thread immediately, answered when the current step
  finishes). If mid-run append turns out not to be consumable as a next turn, fall
  back to: disable Send with a quiet "the assistant is answering - your message will
  send next" QUEUE behavior in the panel (send automatically on run completion). Pick
  whichever is truly supported end-to-end and prove it.
- Stop becomes a SEPARATE, small, deliberate control (icon-only ActionIcon with
  tooltip, distinct position, still armed-activation-guarded). It must be impossible
  to hit it by clicking where Send was.
- Keep all 6c/6e safety (watchdog, guards). Update tests.

## 2 (HIGH): scheduled recurrence must survive a crashed tick + heal itself

Evidence: canvas 5's loop produced NO scheduled entries after its 23:10 crash - the
chain died with the tick. In canvas/ticks.py + scheduled task wiring:
- The next occurrence must be enqueued in a finally-style path: ok, no_op, AND error
  ticks all schedule the next one (unless expired/paused/stopped).
- Add a catch-up sweep per the house pattern (echo/server/AGENTS.md "Layered
  reconciliation", scheduler.py system sweeps): every few minutes, find loops with
  status active, expires_at in the future, and NO pending canvas_tick scheduled_task ->
  re-enqueue one. One flag, simple condition, logged.
- Tests for both.

## 3 (MEDIUM): workspace Methodologies card crashes into the error boundary

wave6f hit "Something went wrong" on Workspace General while driving the methodology
modal (shot 39-target-methodology-error.png). Reproduce locally (real or stubbed
workspace), find the render crash in WorkspaceMethodologiesSection (or its data edge
cases: null latest_version, empty content, undefined versions_count), fix, and prove
create -> edit -> history increment locally via Playwright with the 6e testIds.

## 4 (MEDIUM): setup interview must converge to a GOAL proposal

wave6f beat 1: after three answers the agent produced a project-update suggestion, not
a goal proposal. In the agent system prompt (## Project setup): when the project has no
goal and the conversation is the setup interview, the closing move is proposeGoal -
propose the goal FIRST; suggest context/settings updates only after a goal exists.
Agent test asserting the instruction.

## 5 (LOW): generation copy still says "Real-time"

Strengthen skill.md's banned-words framing (the model ignored prose; make it a short
explicit blacklist: "real-time", "AI", "successfully", em dashes in visible text) and
add a store-time DETECTION (not mutation): when a generation contains a banned lexeme,
record it in the generation's detail field so quality drift is measurable. No content
rewriting.

QA: full gates (server whole-tree ruff + baselined suites; agent pytest; frontend
tsc/lint/lingui). REQUIRED local reproductions: (a) with the new composer, type and
click during an in-flight run - prove NO /stop fires and the message is
appended/queued and eventually answered; (b) a crashed tick (force one in a test/dev
hook) still enqueues the next occurrence, and the sweep resurrects an orphaned loop;
(c) methodology create/edit passes locally under Playwright. No git write commands.
Report -> echo/docs/plans/smart-loop-briefs/wave6g-REPORT.md.
