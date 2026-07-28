# Brief: Wave 26 - the wall is actually alive (nudge -> SSE -> instant updates)

You are in the solve-queue-issues worktree. Start:
`git fetch origin && git checkout -b sameer/live-wall origin/main` (wave 25
lands before you; take the tree as you find it).

Owner, during a real live retrospective: "i feel like it wasn't updating on
its own and i have to hit refresh on canvas." Diagnosis (verified): the
server generated fine every 3-5 minutes (loop 9d94c1eb, report 11); the
canvas page polls every 30s via React Query refetchInterval, which PAUSES
when the window is unfocused (default refetchIntervalInBackground: false).
A wall display or unfocused tab never updates. Meanwhile
publish_generation_nudge already fires on every generation
(canvas/events.py, Redis channel canvas:generation:{report_id}) and NOTHING
subscribes. Repo rule (AGENTS.md): don't poll for progress that has an SSE
channel.

## Build

1. SERVER (BFF): `GET /api/v2/bff/canvases/{canvas_id}/events` - an SSE
   endpoint that authorizes like the other canvas reads, subscribes to the
   Redis nudge channel for that report, and emits a small event per nudge
   (generation available; id if cheap). Follow the existing SSE + Redis
   pub/sub pattern used for report/health progress (grep for EventSource/
   sse in the server). Heartbeat comments so proxies keep it open;
   client-disconnect cleanup.
2. FRONTEND: on the canvas page (and any wall/reader view that renders
   CanvasFrame from live data), subscribe with EventSource; on nudge,
   invalidate/refetch the canvas + generations queries so the new frame
   renders within seconds. Reconnect with backoff on drops. Keep the 30s
   polling as fallback BUT set refetchIntervalInBackground: true on the
   canvas queries so an unfocused wall still updates even if SSE dies.
3. The freshness cluster should reflect it: when a new generation arrives
   via nudge, the "Updated X ago" line updates without any interaction
   (it already re-renders from the query; verify).
4. Respect fullscreen mode: SSE keeps working there (same component).

## Item 4b: briefs are instructions, never content (the brief-bloat antipattern)

Owner: "are the briefs going too long for conversation updates?" Evidence
(report 11, Wednesday Check in): 8 config revisions, brief grew 511 -> 3368
chars, and the latest brief CONTAINS the synthesis itself - person-by-person
reflection summaries, open issues, and discussion questions verbatim. The
agent inverted the architecture: content belongs to the LOOP (gather reads
the live transcript each tick and the generation writes the synthesis); the
brief is standing instructions only (structure, style, spellings, what to
include/exclude). With content frozen in the brief, the canvas stops
self-updating and every new share needs a manual chat update.

Fix in the agent (proposeCanvas/editCanvas guidance + canvas prompt section)
and the server generation skill:
- Prompt: a canvas brief holds durable instructions (sections, style rules,
  standing corrections, focus/exclusions). It must NEVER contain gathered
  content, participant reflections, quotes, or synthesis text - the loop
  writes those fresh each tick from the transcript. Name the Wednesday
  Check in brief as the counterexample. When a host asks to "add X's
  reflection", the right move is: confirm the canvas's instructions already
  cover person-by-person reflections and (if needed) nudge a refresh - not
  to paste X's reflection into the brief.
- On every brief revision, REWRITE the brief cleanly (consolidate standing
  edits and corrections; revision history preserves the past); do not
  append forever.
- skill.md: generations must synthesize from the gathered material, and may
  not depend on content embedded in the brief.
- Agent tests for the rules.

## Folded-in chat insights (owner: "fold in some chat_insights along with the changes")

From echo-next agent_insight rows (the agent's own capability-gap log):

5. FULLSCREEN FILLS THE VIEWPORT (friction, 11:12): "the canvas full-screen
   presentation mode is buggy because the container stops abruptly and does
   not scale to the full viewport height." In fullscreen the frame must be a
   full-viewport responsive layout (100dvh, no abrupt cutoff, iframe keeps
   viewport-height behavior per wave 18). Fix in CanvasRoute/CanvasFrame
   fullscreen styles; screenshot evidence.
6. QR IN THE CHAT (wish, 10:52): "scan a QR code directly from the assistant
   chat to start recording a conversation immediately." When the agent gives
   the portal link (getPortalLink flow), the chat reply's link should also
   render as a small QR block in the thread so a phone can scan it off the
   host's screen. Frontend: render a QR (reuse the dashboard's QR generator,
   e.g. in the message renderer or a light card) for portal start links in
   assistant messages; keep it quiet and only for the project's own portal
   link (same origin+path validation rules as the canvas-qr kit primitive).
7. CORRECTIONS BECOME KEY TERMS (wish, 11:05): hosts correct spellings in
   chat (Akshita, Jorim, AI4Deliberation); transcription keeps misspelling
   them because the project's key terms field never learns. Agent prompt:
   when saving a spelling/name correction to memory, ALSO offer (one line) a
   proposeProjectUpdate adding it to default_conversation_transcript_prompt
   (the key terms field) so future transcription gets it right. No new
   machinery; prompt + existing tools.
8. TRACK, DO NOT BUILD (add one line each to the smart-loop.md tracked
   list): weekly email summaries from canvases (wish 09:54); webhook-driven
   notification to the chat when a conversation finishes recording (wish
   11:04, pairs with the live-session flow).

## QA

Gates: server whole-tree ruff + focused pytest (SSE endpoint unit test with
a fake pubsub); frontend tsc, biome lint, lingui if strings change. Local
Playwright/manual: open the canvas page, publish a nudge via Redis in the
podman stack (or call the internal publisher), assert the iframe content
refetches without focus/interaction; screenshot to wave26-shots/ (no
git-add). Confirm no CSP/sandbox change is needed (SSE is on the parent
page, not in the iframe).

No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave26-REPORT.md (this worktree).
