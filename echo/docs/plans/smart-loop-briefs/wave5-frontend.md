# Brief: Wave 5 (frontend) - project creation opens into the setup chat + goal surface

Track C's user-facing half. Read: `echo/docs/plans/smart-loop.md` D8/D9/D11 + the story
beat "The evening before: creating the project is a conversation"
(docs/building/smart-loop.md), wave3-frontend-REPORT.md (card patterns), and
`echo/frontend/AGENTS.md`. A parallel server track builds the endpoints; contract below
is fixed - fixture-fallback like the previous waves.

CONTRACT: `GET /v2/bff/projects/{id}/goal` -> {current: {id, content, set_by,
created_at}|null, revisions: [...newest first]}; `POST /v2/bff/projects/{id}/goal`
{content} -> revision; `GET /v2/bff/methodologies?workspace_id=` -> [{id, name,
description, framing, is_seeded, latest_version}]. Agent proposal payload in chat tool
output: `{type: 'goal_proposal', content}` from tool `proposeGoal`.

Deliverables (touch ONLY echo/frontend):

1. **Creation opens into the setup chat.** Find the project create wizard flow (FACTS:
   create wizard `/new` - name & context -> access -> review). ON COMPLETION (project
   created), navigate to the project's Ask home / new-chat route with router state
   `{initialMessage}` (the mechanism ALREADY EXISTS - grep NewChatRoute for
   initialMessage; #793 built it) seeded with a setup message like "Help me set up
   this project." so the agent opens the interview. ONLY when agentic chat is enabled
   (ENABLE_AGENTIC_CHAT) - production keeps today's behavior. Escape hatches are the
   agent's job (its welcome line offers skip/come back/docs); your job is the routing.
   Additionally, a "Help me figure it out" affordance in the wizard's context step:
   subtle button that lets the host SKIP writing context and marks the setup chat to
   start from zero (same routing, different initial message: "Help me figure out what
   this project is for.").
2. **GoalSuggestionCard in chat.** Mirror CanvasSuggestionCard's wiring (wave 3) for
   `goal_proposal`: shows the proposed goal text (quoted), Apply -> POST the goal
   endpoint -> applied state "Saved as this project's goal", Dismiss. No Try-it
   (nothing to preview).
3. **Goal in project settings.** In ProjectSettingsRoute, a compact read surface under
   the existing context editor (own section like ProjectMemorySection): current goal
   text, "set by <interview|you|loop> <relative time>", expandable revision history
   list (content + timestamp), and an Edit affordance (textarea + save -> POST, which
   creates a new revision; autosave NOT needed - explicit save button is fine here).
   Honest empty state: "No goal yet. Set one here, or let the assistant interview you
   in chat."
4. Hooks in a goals hub (or extend project hooks) per house conventions; fixtures on
   404 in dev like previous waves.

QA: Playwright against the dev server (stub or real per practicality): creation flow
lands in the chat with the seeded message visible as the first user message; the goal
section renders fixture goal + history; GoalSuggestionCard applies. Gates: tsc, lint,
lingui extract+compile. Brand rules binding (lowercase dembrane, never "AI", no
c="dimmed", ramp tokens, ConfirmModal only if destructive). No git write commands.
Report -> echo/docs/plans/smart-loop-briefs/wave5-frontend-REPORT.md.
