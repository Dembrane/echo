# Brief: Wave 6c - two HIGH run-lifecycle bugs from the echo-next e2e

Read wave6a-REPORT.md first (beats 1 and 5). Two HIGH bugs block the Marieke story on
echo-next. Find root causes, fix, test. Both smell like agentic run/stream state in the
frontend panel and its interaction with the reconnect-driven runtime - read
`echo/frontend/src/components/chat/AgenticChatPanel.tsx` (run tracking,
storageKeyForChat, stream attach/stop paths), `NewChatRoute.tsx` (initialMessage seed),
and `echo/server/dembrane/api/agentic.py` (stream + stop endpoints; note the #793
stop-recovery: the stop endpoint force-appends run.failed(AGENT_CANCELLED) when no
local task exists in that replica).

## Bug 1 (HIGH): setup-chat seed run dies instantly with AGENT_CANCELLED

Evidence: creating a project lands in the setup chat, the seeded message renders, but
the run fails immediately - echo-next run `d7eafeb2-6707-4f25-8506-fec345ea18ff`,
status failed, latest_error "Run cancelled by user". That error text means SOMETHING
CALLED THE STOP ENDPOINT - this is not an agent failure.

Hypotheses to test (in order):
- The create->navigate sequence mounts AgenticChatPanel more than once (or navigates
  from the wizard route into the chat route in two steps), and an unmount/cleanup or
  stale-run effect calls stopAgenticRun for the just-started run.
- The seed effect races the run-storage state (storageKeyForChat) - the panel starts
  run A, a re-render sees "unknown active run" and stops it.
Reproduce locally: full local stack (Directus 8055, echo-host-redis on 6379, server
`--loop asyncio`; agent service NOT required - the cancellation happens before any
agent involvement; run `cd echo/agent && uv run uvicorn main:app --port 8001` anyway
if it helps you see a healthy turn). Frontend dev server with the wave-4 proxy env
vars. Walk: create project -> observe network calls - you should SEE the POST to
/runs/{id}/stop that kills it. Fix the cause, not the symptom (do not just retry).

## Bug 2 (HIGH): lifecycle turns stall - run stays 'running' with only user.message

Evidence: in an existing chat (where a proposeCanvas turn had SUCCEEDED earlier),
sending "Pause the wall." created run `c75c6cd8-adc7-4176-9ab7-d94a743daa33` which
persisted ONLY the user.message event - no turn start, no error - and the composer
stuck at "Working on your answer...". The runtime is reconnect-driven: a turn only
executes while a client is attached to POST /runs/{id}/stream. Zero post-user.message
events => the client never attached (or attached to the WRONG run id).

Hypotheses:
- After a completed run, the panel keeps the old run id (localStorage/state) and
  attaches (or thinks it's attached) to the terminal old run instead of the new one.
- The append-message path (existing chat, new turn) differs from the create-run path
  and misses the stream (re)attach.
Check how the panel decides which run id to stream after: (a) first message in a fresh
chat, (b) follow-up message after a completed run, (c) reconnect. You may be able to
reproduce ENTIRELY locally without a working model: what matters is whether the stream
attach POST fires for the new run id (observe the network), not whether the turn
produces good output.

## Also, while you are in there (from 6a, low)

- Review the tooltip copy "Pause updates" / "Ask for the latest version" on the canvas
  page against the brand voice; adjust only if clearly off.

## QA

- Unit/component tests for the fixed behavior where the codebase has precedent
  (agentic api tests for stop/stream sequencing; frontend logic extracted into
  testable helpers if needed).
- Local browser walk of both repro paths post-fix (describe network evidence: the
  stop call is GONE in bug 1; the stream attach fires for the NEW run id in bug 2).
- Gates for everything touched: server whole-tree ruff + tests/api tests/agentic
  (known 4 pre-existing failures); frontend tsc + lint (+ lingui if strings changed).
- No git write commands. Report ->
  echo/docs/plans/smart-loop-briefs/wave6c-REPORT.md with root causes stated plainly.
