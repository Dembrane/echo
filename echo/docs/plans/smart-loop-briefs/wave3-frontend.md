# Brief: Wave 3 (frontend) - the Library + canvas proposal card in chat

Foundation is live (read first: trackb-REPORT.md, tracka-REPORT.md,
`echo/docs/plans/smart-loop.md` D12/D14/D15, and `echo/frontend/AGENTS.md`). Owner
decision: the sidebar word is **Library** - it lists the project's canvases the way
Reports lists reports. A parallel server track is building the endpoints; the contract
below is fixed - build against it with fixture fallbacks exactly like Track B did.

CONTRACT (fixed): list `GET /v2/bff/canvases?project_id=` ->
`[{id, name, kind, created_at, latest_generation_at, loop:{status, expires_at,
cadence_minutes}|null}]`; preview `POST /v2/bff/canvases/preview {project_id, brief,
gather_spec?}` -> `{content_html}` (429 {"detail":"Just previewed"} when hot); create
`POST /v2/bff/canvases {project_id, name, brief, gather_spec?, cadence_minutes?,
expires_at}` (EXISTS, live); lifecycle `POST /v2/bff/canvases/{id}/loop/pause|resume|stop`
-> loop object. Agent proposal payload arriving in chat tool output:
`{type:'canvas_proposal', name, brief, gather_spec:{window_minutes}, cadence_minutes,
expires_at}` from tool name `proposeCanvas`.

Deliverables (touch ONLY echo/frontend):

1. **Library sidebar + route.** NavItem "Library" in
   `features/sidebar/views/project/ProjectHomeView.tsx` (BooksIcon or similar Phosphor,
   NOT gated to admins; placement near Reports), route
   `/:lang?/w/:ws/projects/:pid/library` -> `LibraryRoute`: a reports-style list of the
   project's canvases (name, "stays up to date until <time>" / "paused" / "ended"
   status line from loop, last-updated from latest_generation_at, click -> the existing
   CanvasRoute). Honest empty state ("Canvases the assistant builds for this project
   live here. Ask for one in chat.") - no create button (creation happens in chat, like
   conversations have no new-conversation button). Breadcrumb leaf `library: "Library"`.
   Extend the canvas hooks hub with useProjectCanvases(projectId) + fixture fallback on
   404 (dev only), consistent with the existing hooks file.
2. **CanvasSuggestionCard in chat.** Mirror CustomVerificationTopicSuggestionCard's
   wiring in AgenticChatPanel EXACTLY (find where tool outputs map to cards, ~line
   1316). Card shows: name, the brief (quoted, truncated with expand), the plain-words
   rhythm line ("updates every few minutes until <expiry, local time>"), and three
   controls: **Try it** -> calls preview, renders the returned content_html inside a
   bounded-height CanvasFrame (reuse assembleCanvasDocument + the existing component)
   right in the card, with a clearly-marked preview label; 429 -> quiet "just
   previewed, give it a moment" line; **Apply** -> POST create, success -> card flips
   to applied state with an i18n link "Open in Library" to the canvas route; **Dismiss**
   (local state, mirrors existing cards). Loading/error states honest, never blank.
3. **Canvas page lifecycle.** On CanvasRoute add Pause/Resume (subtle buttons wired to
   the lifecycle endpoints; state from the loop object; expired/stopped shows the
   ended state, resume on ended surfaces the 409 detail as a toast).

QA: dev server + Playwright (as Track B did): verify the Library route renders fixture
canvases, the empty state, and - by stubbing the tool-output event or adding a fixture
proposal - the CanvasSuggestionCard including a Try-it render with fixture HTML and the
applied state. Describe DOM evidence in the report. Gates: `corepack pnpm@10 exec tsc`,
`corepack pnpm@10 run lint`, `corepack pnpm@10 run messages:extract && corepack pnpm@10
run messages:compile` (lingui macros for every string). Brand rules binding: lowercase
dembrane, never "AI", no c="dimmed", type-ramp tokens only, ConfirmModal for anything
destructive (stop). No git write commands. Report ->
echo/docs/plans/smart-loop-briefs/wave3-frontend-REPORT.md.
