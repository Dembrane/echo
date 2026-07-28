# Wave 4 report - real-stack integration proof

## Scope and setup

- Branch: `sameer/smart-loop-build`.
- Real stack used: Directus `localhost:8055`, Postgres `5432`, Redis `6379`, FastAPI on `8123`, Vite on `5175`.
- Project: `ada57b56-d707-4be2-a1ce-25eadeaf5bad` (`Facilation 1`), workspace `0ac34bcb-0d26-4154-a0a9-9f1e6cf5f570`.
- Browser login used the real admin session: `admin@dembrane.com` / `admin`.
- Scheduled Dramatiq tick workers were not running on the host; manual refresh drove generation inline, per brief.

## What rendered

1. Library at `/w/0ac34bcb-0d26-4154-a0a9-9f1e6cf5f570/projects/ada57b56-d707-4be2-a1ce-25eadeaf5bad/library`
   - DOM showed real canvas rows: `Wave 3 live QA temp` with `Ended` / `No version yet`, and `Track A live canvas` with `Stays up to date until 00:18` / `Last updated 26 minutes ago`.
   - Screenshot: `wave4-shots/01-library.png`.

2. Canvas 2 at `/canvases/2`
   - DOM showed `Track A live canvas`, `Pause`, `Refresh now`, version strip buttons `23:28`, `23:19`, `23:18`.
   - Iframe rendered with `sandbox="allow-scripts"`, height `4652px`, and a non-empty `srcdoc` length of `288506`.
   - Iframe text included `FACILATION 1`, `Participant Concerns & Themes`, `Updated live • 8 conversations registered`, and honest waiting-state copy.
   - Screenshot: `wave4-shots/02-canvas-2-live.png`.

3. Canvas 2 lifecycle
   - Clicking `Pause` changed the lifecycle control to `Resume` and rendered `Paused`.
   - Clicking `Resume` returned the control to `Pause` and rendered `Stays up to date`.
   - Screenshots: `wave4-shots/03-canvas-2-paused.png`, `wave4-shots/04-canvas-2-resumed.png`.

4. Proposal card, preview, and apply
   - The local agent service was not used for a live turn. I used the brief's fallback variant: a hand-built real `project_agentic_run` in a real `agentic` chat, plus the browser-local run pointer that the normal live agentic UI would set.
   - Proof chat: `1e82c203-a06d-440b-b0ce-135e98c5f926`; proof run: `66842a15-2c1f-485b-8308-0664df160a18`.
   - Card DOM showed `Wave 4 integration proof`, `Try it`, `Apply`.
   - `Try it` hit the real preview endpoint and rendered a real iframe preview. Iframe text included `FACILATION 1`, `Live Pulse Wall`, `Waiting for active conversation streams to begin`, and `8 conversation`.
   - `Apply` hit the real create endpoint and rendered `This canvas is in your Library` with `Open in Library`.
   - Screenshots: `wave4-shots/05-proposal-card.png`, `wave4-shots/06-proposal-preview.png`, `wave4-shots/07-proposal-applied.png`.

5. New canvas open and manual refresh
   - `Open in Library` navigated to `/canvases/4`.
   - Initial page showed `The assistant is preparing this canvas. A first version will appear here when it is ready.`
   - `Refresh now` created a real generation through the configured `vertex_ai/gemini-3.5-flash` deployment. Reload showed an iframe, version strip `23:54`, and body text beginning `FACILATION 1`, `Live Pulse Wall`, `Monitoring 8 conversations • Updated just now`.
   - Screenshots: `wave4-shots/08-new-canvas-open.png`, `wave4-shots/09-new-canvas-refreshed.png`.

Full Playwright evidence is saved at `wave4-shots/wave4-playwright-evidence.json`.

## Fixes made

- `echo/frontend/vite.config.ts`: added `VITE_DEV_API_PROXY` with the existing `http://localhost:8000/` default. This let Vite proxy `/api` to the real FastAPI server on `8123` when `gvproxy` occupied port `8000`.
- `echo/frontend/vite.config.ts`: added `VITE_DEV_DIRECTUS_PROXY` with the existing `http://directus:8055` default. This let browser login use the real host Directus at `localhost:8055`; without it, Vite returned proxy `500` because `directus` did not resolve from the host process.

Both are dev-only, backward-compatible wiring fixes.

## Could not prove

- I did not prove scheduled ticks. The brief explicitly kept Dramatiq worker scheduling out of scope for this host proof.
- I did not prove a fully live agent-service chat turn producing `proposeCanvas`. The fallback card path used a hand-built proposal payload in a real stored agentic run, then exercised the real preview and create endpoints.

## Generation sample and judgement

First 40 lines of canvas `4` latest generation:

```html
<div class="canvas-shell">
  <!-- Header -->
  <div class="canvas-section">
    <div class="canvas-stack canvas-tight">
      <div class="canvas-eyebrow">Facilation 1</div>
      <div class="canvas-title">Live Pulse Wall</div>
      <div class="canvas-caption">
        Monitoring 8 conversations • Updated just now
      </div>
    </div>
  </div>

  <div class="canvas-divider"></div>

  <!-- Main Content: Honest State of Data -->
  <div class="canvas-section">
    <div class="canvas-card-accent">
      <div class="canvas-stack">
        <div class="canvas-heading">Waiting for live discussion data</div>
        <div class="canvas-body">
          Eight conversations are connected to this project, but no active speaking or transcript text has arrived within the tracking window yet. 
        </div>
        <div class="canvas-caption canvas-muted">
          As soon as participants begin speaking, their worries, emerging themes, and key alerts for the host will appear here in real time.
        </div>
      </div>
    </div>
  </div>

  <!-- Placeholder Grid to establish stable layout for future updates -->
  <div class="canvas-section">
    <div class="canvas-grid-2">
      <!-- Left Column: What participants are worried about -->
      <div class="canvas-card">
        <div class="canvas-stack">
          <div class="canvas-eyebrow canvas-amber">Urgent Concerns</div>
          <div class="canvas-heading">Participant Worries</div>
          <div class="canvas-body canvas-muted">
            No worries or tensions detected yet. This section will highlight what participants are struggling with or anxious about as they speak.
          </div>
```

Judgement against `echo/server/dembrane/canvas/skill.md`: pass. It is a body fragment rooted at `canvas-shell`, uses only the supplied kit classes, does not fetch external resources, and is honest that the current data window has no transcript text. It is meaningful enough for the empty-data state, though the HTML comments are unnecessary and the section labels are still slightly generic; those are quality follow-ups, not integration blockers.

## Verification

- `cd echo/frontend && corepack pnpm@10 exec tsc`: passed.
- `cd echo/frontend && corepack pnpm@10 run lint`: passed.
- No Lingui command was run because no user-facing strings changed.
- No git write commands were run.
