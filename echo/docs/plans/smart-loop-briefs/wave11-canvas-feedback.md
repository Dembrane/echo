# Brief: Wave 11 - canvas real-usage feedback: update proposals, chat reach-back, sample preview

Owner tried the canvas on echo-next and hit three walls. Branch:
sameer/agent-portal-link (wave 10 committed at 88d2f107). Read
echo/docs/plans/smart-loop.md (D1-D17), echo/frontend/src/components/chat/
CanvasSuggestionCard.tsx, echo/server/dembrane/canvas/service.py, and
echo/agent/agent.py canvas tools first.

## Item 1: update proposals are INVISIBLE (the big one, a wave-8 regression)

Evidence (owner screenshot, echo-next): host asked the chat to change canvas
wording and styling. Assistant message says "I have proposed an updated 'Street
Feedback Dashboard' canvas for you... You can review and apply this proposal
directly on your screen." But NO proposal card rendered. Instead the thread
shows the compact applied frame "This canvas is in your library. Open in
library."

Root cause: wave 8 made CanvasSuggestionCard derive applied-state by NAME match
against the project canvas list (matchingCanvas -> effectiveAppliedCanvasId ->
compact applied frame). An UPDATE proposal necessarily names an existing
canvas, so the card instantly renders as already-applied and the proposal is
swallowed. Name-match cannot distinguish "this proposal was applied" from
"this proposal updates an existing canvas".

Fix end to end:
1. AGENT: proposeCanvas grows an update flavor: when the host asks to change an
   existing canvas, the agent resolves it (reuse _resolve_canvas_id) and emits
   a proposal payload carrying target_canvas_id plus the updated
   name/brief/cadence. New tool or a parameter, pick the cleaner design and
   justify. The prompt must steer "change the canvas" requests through this
   path, and the assistant text must not claim a card exists if the payload is
   malformed (the tool validates).
2. FRONTEND CanvasSuggestionCard: a proposal WITH target_canvas_id renders as
   an update card: what changes (name/brief/cadence diff at whatever
   granularity the payload has), Apply calls the update path, and applied-state
   for an update is keyed to THIS proposal (e.g. the auto-sent apply message
   later in the thread than this proposal event, or canvas.updated_at newer
   than the proposal timestamp AND matching content), never bare name-match.
   Re-applying after remount must not double-apply; a create-flavor proposal
   for a name that already exists should render as an update-style choice, not
   silently show applied.
3. SERVER: whatever update endpoint the Apply needs (BFF PATCH canvas
   name/brief/cadence + trigger a fresh generation so the host sees the change
   quickly). Keep loop/expiry semantics intact (D-decisions). The auto-sent
   apply message stays: "I applied the canvas." (existing wave-8 flow).

## Item 2: reach the chat from the canvas

Owner: "i want to go to the chat from the canvas to update it! or create a new
chat to talk about it."

Facts: agent_loop already stores created_from_chat_id
(canvas/service.py:40,84; phase0 migration line 448) but the BFF canvas detail
does NOT expose it (grep echo/server/dembrane/api/v2/bff/canvases.py). The
new-chat route accepts location.state.initialMessage
(routes/project/chat/NewChatRoute.tsx ~269) and seeds the first turn with it.

Build, on the canvas page header (CanvasRoute), two quiet affordances near the
existing controls:
- "Open the chat": visible when created_from_chat_id resolves to a live chat
  (expose it through the BFF canvas detail; handle deleted chats by hiding the
  affordance, check cheaply). Navigates client-side to that chat.
- "New chat about this canvas": navigates to the project's new-chat route with
  initialMessage state like: Let's talk about the canvas "<name>". - the agent
  already resolves canvases by name (listCanvases/_resolve_canvas_id), so the
  seeded turn just works.
Brand: sentence case, no "AI", buttons subtle, lingui for all strings.

## Item 3: "Try it out" needs sample conversations

Owner: "always in the try it out - i should be able to see dummy conversations
or something in the chat otherwise it is hard to check!"

When the host previews a canvas (the try-it-out/preview flow through
usePreviewCanvasMutation -> BFF preview endpoint -> gather), a project with no
or few conversations produces an empty, unjudgeable preview. Fix: when the
gathered material is empty (or below a small threshold), the PREVIEW (and only
the preview, never scheduled/live generations) runs on clearly labeled sample
conversations: a small built-in fixture set (3-5 short plausible conversation
summaries relevant to a generic feedback project) injected at the gather layer
behind an explicit preview_sample=true flag. HONESTY RULES (D-decisions +
canvas skill): the generated preview must visibly say it is showing sample
conversations (the skill already demands honesty lines; extend it so sample
mode names itself, e.g. "Sample conversations, your real conversations replace
these"), and live generations must never use samples. Tests at the gather/tick
layer for the flag.

## QA

- Gates: server whole-tree ruff + focused pytest; agent uv run pytest -q;
  frontend tsc, biome lint, lingui extract+compile.
- Playwright with fixtures: (1) update-proposal card renders and is NOT
  swallowed by an existing same-name canvas; (2) apply -> auto message ->
  reload -> card shows applied, no duplicate and no double-update; (3) canvas
  page shows both chat affordances and they navigate client-side.
- No git write commands. Report ->
  echo/docs/plans/smart-loop-briefs/wave11-REPORT.md.
