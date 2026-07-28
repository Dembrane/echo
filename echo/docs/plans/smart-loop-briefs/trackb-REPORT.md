# Track B report - canvas shell and kit

## Files created or changed

- Created `echo/frontend/src/components/canvas/CanvasFrame.tsx`
- Created `echo/frontend/src/components/canvas/fixtures.ts`
- Created `echo/frontend/src/components/canvas/hooks/index.ts`
- Created `echo/frontend/src/components/canvas/kit.css`
- Created `echo/frontend/src/components/canvas/kit.ts`
- Created `echo/frontend/src/routes/project/canvas/CanvasRoute.tsx`
- Changed `echo/frontend/src/Router.tsx`
- Changed `echo/frontend/src/features/sidebar/breadcrumbs/AppBreadcrumbs.tsx`
- Changed `echo/frontend/src/lib/bff.ts`
- Changed locale catalogs and compiled locale modules under `echo/frontend/src/locales/` via `messages:extract` and `messages:compile`

## What shipped

- Registered `/:lang?/w/:workspaceId/projects/:projectId/canvases/:canvasId` through the existing project route tree.
- Added a project breadcrumb leaf for `canvases` as `Canvas`.
- Added `CanvasRoute` with title, loop status, fixture-mode note, subtle `Refresh now`, fullscreen toggle, locked frame, and a compact generation strip.
- Added `CanvasFrame` with `srcdoc`, strict sandboxing, CSP-injected source assembly, postMessage-only height reporting, empty/error/stale states, and auto-sizing.
- Added pure `assembleCanvasDocument(contentHtml: string): string`.
- Added static render-kit CSS with dembrane tokens and utility classes.
- Inlined D3 v7 from the installed dependency at `node_modules/d3/dist/d3.min.js` via Vite raw import. No new npm dependency was added.
- Added fixture-backed React Query hooks in `src/components/canvas/hooks/index.ts`, with local/dev 404 fallback for the parallel Track A endpoints.
- Preserved HTTP status on `bff` errors so the canvas hooks can distinguish 404 and 429.

## Browser verification

Dev server command: `corepack pnpm@10 run dev` in `echo/frontend`.

Port 5173 and 5174 were occupied, so Vite started at `http://localhost:5175/`.

I verified this route with Playwright against the running Vite server:

`http://localhost:5175/w/11111111-1111-1111-1111-111111111111/projects/22222222-2222-2222-2222-222222222222/canvases/33333333-3333-3333-3333-333333333333`

The browser run stubbed auth/workspace/project responses and returned 404 for `/api/v2/bff/canvases*` so the required fixture fallback path was exercised. Observed DOM/runtime evidence:

- Page title rendered as `Live panel wall`.
- Status line rendered as `Stays up to date until 04:00 today Using fixture data.`
- Iframe rendered with `sandbox="allow-scripts"`.
- Iframe auto-sized to about `968px` after postMessage height reporting.
- Fixture wall rendered inside the iframe with 5 `.canvas-card` nodes.
- D3 chart rendered inside the iframe with 4 SVG `rect` bars.
- `Refresh now` was disabled in fixture mode.
- Clicking the error generation chip rendered the honest error state.
- Clicking back to the live generation restored the wall.
- Fullscreen toggle entered fullscreen. `document.fullscreenElement` was truthy.

Console evidence: the expected canvas BFF 404s appeared and triggered fixture mode. Remaining unexpected console messages were pre-existing app/stub noise, not canvas-specific: one Mantine style-property warning and one announcements query warning caused by the minimal Playwright API fallback.

## Security self-check

Exact iframe sandbox shipped:

```html
sandbox="allow-scripts"
```

Exact CSP shipped in the generated `srcdoc`:

```html
default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data:; font-src data:;
```

What a malicious generation can do:

- Run inline JavaScript inside its iframe.
- Render inline styles, inline SVG, data images, and D3-driven visuals.
- Send `postMessage` events to the parent, but the shell only accepts `{ type: "dembrane:canvas:height", height: number }` from the iframe window.

What it cannot do:

- Read cookies, localStorage, sessionStorage, parent DOM, or app credentials because the iframe has no `allow-same-origin` and therefore runs with a null origin.
- Fetch network resources, load external scripts, load external images, or load external fonts because the CSP has `default-src 'none'` and only allows inline script/style, blob scripts, data images, and data fonts.
- Navigate the top window or open privileged browser capabilities because the sandbox only grants scripts.

## Kit class inventory

Layout:

- `canvas-shell`
- `canvas-section`
- `canvas-grid`
- `canvas-grid-2`
- `canvas-stack`
- `canvas-row`

Cards and emphasis:

- `canvas-card`
- `canvas-card-accent`
- `canvas-pill`
- `canvas-pill-blue`
- `canvas-pill-green`
- `canvas-pill-amber`
- `canvas-divider`

Typography:

- `canvas-eyebrow`
- `canvas-title`
- `canvas-heading`
- `canvas-subheading`
- `canvas-body`
- `canvas-caption`
- `canvas-metric`
- `canvas-quote`

Utilities:

- `canvas-muted`
- `canvas-blue`
- `canvas-green`
- `canvas-amber`
- `canvas-tight`
- `canvas-center`
- `canvas-right`
- `canvas-chart`

## Endpoint shapes mocked

The hooks are built against:

```ts
GET /v2/bff/canvases/{id} -> {
  id: string;
  name: string;
  kind: "canvas";
  project_id?: string | null;
  latest_generation?: CanvasGeneration | null;
  loop?: {
    status: string;
    expires_at?: string | null;
    cadence_minutes?: number | null;
  } | null;
}
```

The normalizer also accepts `{ report: { id, name, kind, project_id, ... }, latest_generation, loop }` if Track A returns report fields nested under `report`.

```ts
GET /v2/bff/canvases/{id}/generations?limit=8 -> CanvasGeneration[]
```

```ts
POST /v2/bff/canvases/{id}/refresh -> 202 { generation: "pending" }
```

`CanvasGeneration` shape:

```ts
{
  id: string;
  report_id: string;
  config_revision_id: string;
  content_html: string;
  status: "ok" | "no_op" | "error";
  tick_kind?: string | null;
  created_at: string;
}
```

429 refresh errors surface as `Just refreshed. Give it a moment.`

## Decisions made beyond the brief

- Because D3 is already a dependency, I did not vendor a second D3 file. I imported the installed dist bundle as a raw string from `node_modules/d3/dist/d3.min.js`.
- Fixture mode disables `Refresh now` and explains that refresh will work when the canvas service is ready. This avoids a button that always fails before Track A lands.
- Local development also treats fetch/network misses as fixture-eligible. Deployed environments only fall back on 404.
- The generation strip shows status suffixes for `no_op` and `error`, and the error generation chip opens the honest frame error state.

## Skipped or deferred

- No unit test was added because `echo/frontend/package.json` has no unit-test runner. The pure assembler is covered by `tsc`, lint, and browser verification instead.
- No sidebar entry was added, per Q5/naming guidance in the brief.
- No `vite build` was run because the brief says it OOMs locally and not to run it.

## Verification commands

- `corepack pnpm@10 exec tsc` clean
- `corepack pnpm@10 run lint` clean
- `corepack pnpm@10 run messages:extract && corepack pnpm@10 run messages:compile` clean
- Re-ran `corepack pnpm@10 exec tsc` clean
- Re-ran `corepack pnpm@10 run lint` clean
