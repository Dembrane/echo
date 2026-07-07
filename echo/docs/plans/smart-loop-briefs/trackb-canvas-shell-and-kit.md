# Brief: Track B (part 1) - the canvas shell + render kit (frontend only)

You are building the client side of the "dynamic canvas" for dembrane echo: the trusted
shell that renders an assistant-generated HTML document safely and beautifully.

Read FIRST, in order:

1. `echo/docs/plans/smart-loop.md` - decisions D5, D6, D12, D14, D15, D17. D6 and D14
   are your spec.
2. `docs/building/smart-loop.md` - the user story (Marieke's wall). Your work is what
   she looks at all day.
3. `echo/AGENTS.md` + `echo/frontend/AGENTS.md` - conventions. Binding, especially the
   brand/UI rules (button variants, type ramp, no `c="dimmed"`, Mantine+Tailwind blend).

## Concept, in two sentences

Every ~5 minutes the server stores a fresh assistant-generated HTML document (a
"generation") for a canvas; your shell shows the latest one in a locked iframe, swaps it
when a new one lands, offers full-screen and a rate-limited "Refresh now", and never
lets generated code touch credentials or the network. The design bar (D17): meaningful,
approachable, human - never generic dashboard-ware.

## Hard interface requirements (build against these; server lands in parallel)

- A canvas is a `project_report` row with `kind === 'canvas'`. Generations are
  `canvas_generation` rows {id, report_id, config_revision_id, content_html, status:
  'ok'|'no_op'|'error', tick_kind, created_at}.
- BFF endpoints (Track A is building them; MOCK them for now behind your data hook):
  - `GET /v2/bff/canvases/{id}` -> {report fields, latest_generation, loop: {status,
    expires_at, cadence_minutes}}
  - `GET /v2/bff/canvases/{id}/generations?limit=` -> newest-first list
  - `POST /v2/bff/canvases/{id}/refresh` -> 202 {generation pending} (manual refresh,
    server rate-limits; surface 429 gracefully as "just refreshed - give it a moment")
  - New-generation signal: assume a lightweight poll on the latest-generation id every
    30s for now, structured so an SSE upgrade is a drop-in (isolate it in the hook).
  Put ALL data access in `src/components/canvas/hooks/index.ts` (React Query, mirroring
  `src/components/project/hooks/index.ts` conventions, using the `bff` helper in
  `src/lib/bff.ts`) with a fixture-mode fallback (see QA) so the UI is fully
  demonstrable before the server exists.

## Deliverables

### 1. `CanvasFrame` - the locked room (D6, non-negotiable security)

A component rendering one generation's `content_html`:

- `<iframe sandbox="allow-scripts" ...>` via `srcdoc` - null-origin (NO
  `allow-same-origin`), so scripts run but see no cookies, storage, or parent DOM.
- Inject a strict CSP `<meta http-equiv="Content-Security-Policy">` into the srcdoc
  head: `default-src 'none'; script-src 'unsafe-inline' blob:; style-src
  'unsafe-inline'; img-src data:; font-src data:;` - zero network. The kit (below) is
  INLINED into the document at assembly time, not fetched.
- postMessage-only channel for height reporting (auto-size) - validate message shape,
  ignore everything else.
- Graceful states: no generation yet ("The assistant is preparing this canvas"),
  status='error' (honest error line, never a blank box), stale (older than 2x cadence:
  quiet "last updated X ago" line - use date-fns `formatDistanceToNow`).

### 2. The render kit (D6/D17)

`src/components/canvas/kit.ts`: assembles the final srcdoc = CSP + kit + generated body.

- Bundle LOCALLY (no CDN): Tailwind via the play-CDN-style runtime is FORBIDDEN (it
  fetches); instead precompile a small static kit CSS. Pragmatic v1: a hand-rolled
  ~200-line `kit.css` exposing dembrane's look as plain CSS variables + utility classes
  (spacing, cards, type ramp mapped from `frontend/src/index.css` tokens: parchment
  background #F6F4F1, graphite text #2D2D2C, royal blue #4169e1 accents, DM Sans via
  system fallback stack since fonts can't be fetched) - document every class in a
  comment block; the generation skill will cite them. If you find a clean way to
  precompile real Tailwind utilities offline into a static css file committed to the
  repo, do that instead and say so.
- d3: vendor the minified d3 v7 bundle into `src/components/canvas/vendor/d3.min.js`
  (add it as a raw-string import inlined into the srcdoc). Check
  `frontend/package.json` first - if d3 is already a dependency, import its dist build
  instead of vendoring.
- Keep kit assembly a pure function: `assembleCanvasDocument(contentHtml: string):
  string` with unit-testable output.

### 3. `CanvasRoute` - the page

Route `/:lang?/w/:workspaceId/projects/:projectId/canvases/:canvasId` (register in
`src/Router.tsx` following existing project-scoped routes; add breadcrumb leaf "Canvas"
in `src/features/sidebar/breadcrumbs/AppBreadcrumbs.tsx` PROJECT_SECTION_LABELS
pattern). Page = title (the report name, click-to-edit NOT needed v1), the loop status
line ("stays up to date until 17:00 today" / "paused" / "ended"), `Refresh now`
(subtle Button, disabled while pending), full-screen toggle (use the Fullscreen API on
the frame container), and the CanvasFrame. NO sidebar entry yet (naming undecided -
Q5); the route is reached from chat links. Sentence-case, brand-clean copy; every
string through lingui (`t`/`<Trans>` macros).

### 4. Version strip (D5/D12, minimal v1)

Under the frame: a quiet horizontal strip of the last N generations (timestamp chips;
click shows that generation in the frame with a clear "viewing 14:20 - back to live"
affordance). Keep it to ~60 lines; the full scrub timeline is later.

## QA required before you report done

- Fixture mode: `src/components/canvas/fixtures.ts` with 3 realistic generations (a
  themed wall with a small inline d3 bar chart; a no_op; an error) - the hooks return
  fixtures when the bff call 404s, clearly marked in code as DEV FIXTURE. Then run the
  dev server (`corepack pnpm@10 run dev` in `echo/frontend`, port 5173) and verify the
  route renders the fixture wall - iframe sized, chart drawn, refresh button disabled
  gracefully on 404, full-screen works. Describe what you SEE in the report (you have
  no screenshot tool; describe the DOM/console evidence).
- Security self-check in the report: paste the exact sandbox attribute + CSP you ship
  and state what a malicious generation could and could not do.
- `corepack pnpm@10 exec tsc` clean; `corepack pnpm@10 run lint` clean;
  `corepack pnpm@10 run messages:extract && corepack pnpm@10 run messages:compile`
  after your strings land (commit-ready .po/.ts changes stay in the working tree).
- Unit test for `assembleCanvasDocument` if a test runner exists in the frontend
  (check package.json; if none exists, do NOT add one - state it).

## Gotchas (hard-won)

- node_modules in THIS worktree are darwin-native and installed - use
  `corepack pnpm@10 ...` exactly; plain `pnpm` is not on PATH.
- `vite build` OOMs locally - do not run it; tsc + lint are the gates.
- Mantine theme defaults Paper to withBorder - pass `withBorder={false}` explicitly
  where needed. Never `variant="default"`, never `color="blue"`, never `c="dimmed"`,
  no hardcoded font sizes (use the ramp tokens).
- Lingui: routed screens import `t` from `@lingui/core/macro` and `Trans` from
  `@lingui/react/macro`. If you forget messages:compile the UI shows raw hash IDs.
- react-best-practices skill applies to this repo's TSX (hooks deps, memo discipline).

## Constraints

- Do NOT run any git write commands (add/commit/push/checkout). Leave changes in the
  working tree; the orchestrator reviews and commits.
- Touch ONLY `echo/frontend/` (another agent works on server/agent/directus in
  parallel).
- No new npm dependencies without stating why in the report (vendored d3 file is fine).

## Report back (write to `echo/docs/plans/smart-loop-briefs/trackb-REPORT.md`)

Files created/changed, what you verified in the browser (specific), the security
self-check, kit class inventory (the list the generation skill will cite), decisions
made beyond the brief, anything skipped and why, and the exact endpoint shapes you
mocked so Track A can match them.
