# Wave 5 frontend report - setup chat and project goals

## Files changed for this task

- `echo/frontend/src/routes/project/CreateProjectRoute.tsx`
- `echo/frontend/src/routes/project/chat/NewChatRoute.tsx`
- `echo/frontend/src/components/chat/AgenticChatPanel.tsx`
- `echo/frontend/src/components/chat/agenticToolActivity.ts`
- `echo/frontend/src/components/goal/GoalSuggestionCard.tsx`
- `echo/frontend/src/components/goal/ProjectGoalSection.tsx`
- `echo/frontend/src/components/goal/fixtures.ts`
- `echo/frontend/src/components/goal/hooks/index.ts`
- `echo/frontend/src/routes/project/ProjectRoutes.tsx`
- Locale catalogs and compiled locale modules under `echo/frontend/src/locales/`
- `echo/docs/plans/smart-loop-briefs/wave5-frontend-REPORT.md`

## What shipped

- Project creation keeps the current `/home` landing when `ENABLE_AGENTIC_CHAT` is off.
- When `ENABLE_AGENTIC_CHAT` is on, project creation now lands on the project's Ask/new-chat route with router state `{ initialMessage }`.
- `NewChatRoute` now consumes that `initialMessage` state once, creates an agentic chat, and forwards the seed to `AgenticChatPanel`, which sends it as the first user message.
- The create wizard context step now includes a subtle `Help me figure it out` affordance. It clears context, advances to access, and uses the zero-context seed: `Help me figure out what this project is for.`
- Added a goal hook hub with `GET /v2/bff/projects/{id}/goal`, `POST /v2/bff/projects/{id}/goal`, React Query invalidation, and local 404/network fixture fallback.
- Added `GoalSuggestionCard` for completed `proposeGoal` tool output with `{ type: "goal_proposal", content }`. It shows quoted goal text, supports Dismiss/Review again, and Apply saves the goal.
- Added a `ProjectGoalSection` under the project settings context editor. It shows current goal text, set-by line with relative time, explicit edit/save, empty state, and expandable revision history.

## Browser QA

Dev server command: `corepack pnpm@10 run dev` in `echo/frontend`.

Vite used `http://localhost:5175/` because ports 5173 and 5174 were occupied.

Playwright ran against that Vite server with inline stubs for auth/session, workspace, project create, project details, chat creation/context/history, agentic run events, project goal BFF endpoints, templates, quick-access preferences, and project memory.

Observed DOM evidence:

- The create wizard rendered the `Help me figure it out` affordance.
- Completing the wizard with `ENABLE_AGENTIC_CHAT` on navigated to `/w/:workspaceId/projects/:projectId/chats/:chatId`.
- The seeded first user message `Help me set up this project.` was visible in the new agentic chat.
- A stored completed `proposeGoal` event rendered `agentic-goal-suggestion`.
- Clicking `Apply` called the goal POST stub and rendered `agentic-goal-suggestion-applied`.
- Project settings rendered `Project goal`, the fixture current goal, and an expandable history with the older revision.

Console notes:

- Browser runs had existing local/stub noise unrelated to this wave: React Grab warnings, a Mantine style warning, and announcement/Directus proxy noise when not fully stubbed.
- One live-stream stub attempt showed the seeded message but not the proposal card because the synthetic stream shape did not match the parser. The stored-run path used the parser shape expected by existing completed tool events and passed.

## Verification commands

- `corepack pnpm@10 exec tsc`: passed
- `corepack pnpm@10 run lint`: passed
- `corepack pnpm@10 run messages:extract && corepack pnpm@10 run messages:compile`: passed
- Playwright inline QA: passed for creation seed message, goal proposal apply, and settings goal/history render

## Notes

- I did not run any git write commands.
- The methodologies endpoint from the contract is not used by this frontend scope; the creation conversation can offer methodologies from the server/agent side once that track is ready.
