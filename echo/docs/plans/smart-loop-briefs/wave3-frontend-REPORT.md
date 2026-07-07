# Wave 3 frontend report - Library and canvas proposal card

## Files changed for this task

- `echo/frontend/src/Router.tsx`
- `echo/frontend/src/components/canvas/fixtures.ts`
- `echo/frontend/src/components/canvas/hooks/index.ts`
- `echo/frontend/src/components/chat/AgenticChatPanel.tsx`
- `echo/frontend/src/components/chat/CanvasSuggestionCard.tsx`
- `echo/frontend/src/components/chat/agenticToolActivity.ts`
- `echo/frontend/src/features/sidebar/breadcrumbs/AppBreadcrumbs.tsx`
- `echo/frontend/src/features/sidebar/views/project/ProjectHomeView.tsx`
- `echo/frontend/src/routes/project/canvas/CanvasRoute.tsx`
- `echo/frontend/src/routes/project/library/LibraryRoute.tsx`
- Locale catalogs and compiled locale modules under `echo/frontend/src/locales/`
- `echo/docs/plans/smart-loop-briefs/wave3-frontend-REPORT.md`

## What shipped

- Added the project sidebar `Library` item with a Phosphor books icon, placed next to `Report` and not gated to admins.
- Replaced the project `/library` index with `LibraryRoute`, a reports-style list of project canvases. It shows canvas name, loop status, last-updated time, fixture badges in local fallback mode, click-through to `/canvases/:canvasId`, and the requested empty state with no create button.
- Updated project breadcrumbs so the `library` leaf reads `Library`.
- Extended the canvas hook hub with `useProjectCanvases`, preview, create, and lifecycle mutations. Local development falls back to fixtures on missing canvas BFF endpoints.
- Added `CanvasSuggestionCard` for completed `proposeCanvas` tool output payloads. It shows name, brief with expand/collapse, the plain rhythm line, `Try it`, `Apply`, and `Dismiss`.
- `Try it` calls `POST /v2/bff/canvases/preview` and renders returned `content_html` through the existing `CanvasFrame`/`assembleCanvasDocument` path inside a bounded preview area. A 429 shows the quiet "Just previewed. Give it a moment." line.
- `Apply` calls `POST /v2/bff/canvases` and flips the card to an applied state with an i18n `Open in Library` link to the existing canvas route.
- Added canvas page Pause/Resume controls wired to `POST /v2/bff/canvases/{id}/loop/pause|resume`. Ended loops render as ended and still offer Resume, so a server 409 detail surfaces as a toast.

## Browser QA

Dev server command: `corepack pnpm@10 run dev` in `echo/frontend`.

Port 5173 and 5174 were occupied, so Vite started at `http://localhost:5175/`.

Playwright ran against that Vite server with API stubs for auth, workspace, project access, canvas BFF endpoints, and agentic run events.

Observed DOM evidence:

- `GET /v2/bff/canvases?project_id=...` returning 404 in local mode rendered fixture Library data.
- `project-library-route` rendered, `library-canvas-list` contained 2 rows, and `Live panel wall` was visible.
- A second project with `GET /v2/bff/canvases?project_id=...` returning `[]` rendered `library-empty-state` with `Ask for one in chat.`
- A stored agentic run event for tool `proposeCanvas` rendered `agentic-canvas-suggestion` with `Live pulse wall`.
- Clicking `Try it` rendered `canvas-proposal-preview`, showed `This is not saved yet.`, and mounted one `canvas-frame-iframe` with the preview HTML.
- Clicking `Apply` rendered `agentic-canvas-suggestion-applied` and the `Open in Library` link.
- On `CanvasRoute`, the lifecycle button rendered `Pause`, switched to `Resume` after the stubbed pause endpoint returned `paused`, then switched back to `Pause` after the stubbed resume endpoint returned `active`.

Console notes:

- The browser run had expected local/stub noise from pre-existing app requests not relevant to this wave: the existing React Grab version warning, an existing Mantine style warning, and Vite proxy errors for unstubbed announcements/templates/project-BFF helper calls. The checked canvas DOM paths above rendered and interacted correctly.

## Verification commands

- `corepack pnpm@10 exec tsc`: passed
- `corepack pnpm@10 run lint`: passed
- `corepack pnpm@10 run messages:extract && corepack pnpm@10 run messages:compile`: passed
- Re-run `corepack pnpm@10 exec tsc`: passed
- Re-run `corepack pnpm@10 run lint`: passed

## Notes

- I did not run any git write commands.
- I left unrelated non-frontend worktree changes untouched.
