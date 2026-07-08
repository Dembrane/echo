# Wave 18 Canvas Header 2 Report

## Summary

- Moved the canvas brand mark from the bottom of the iframe document to the top, using the full `dembrane-logo-new.svg` fallback and preserving whitelabel data-URI support.
- Updated iframe auto-height so page mode has no max cap and can shrink below the previous viewport height; fullscreen keeps viewport-height behavior.
- Reworked the canvas route controls: fullscreen is now a visible icon button, freshness settings live beside the freshness indicator in a popover, and the overflow menu keeps chat, pause/resume, and refresh actions.
- Replaced the iframe `title` attribute with `aria-label` so the native "Canvas preview" tooltip no longer appears over the header text.

## Files Changed

- `echo/frontend/src/components/canvas/CanvasFrame.tsx`
- `echo/frontend/src/components/canvas/kit.ts`
- `echo/frontend/src/components/canvas/kit.css`
- `echo/frontend/src/routes/project/canvas/CanvasRoute.tsx`
- `echo/frontend/src/locales/*.{po,ts}` from `lingui extract && lingui compile --typescript`

## Notes

- The overflow menu was kept because it can still contain contextual chat creation, pause/resume, and refresh without crowding the header. Fullscreen moved out of the menu because it affects the frame presentation directly, and freshness settings moved into the freshness cluster because they configure that status.
- The height reporter now measures the body/content box instead of `documentElement.scrollHeight`; the latter reports at least the iframe viewport height and prevented short canvases from shrinking after a taller render.

## Validation

- `./node_modules/.bin/tsc --noEmit`: passed
- `./node_modules/.bin/biome lint . --diagnostic-level=error`: passed
- `./node_modules/.bin/lingui extract && ./node_modules/.bin/lingui compile --typescript`: passed
- Playwright harness screenshots written to `wave18-shots/`:
  - `header-cluster.png`
  - `auto-height-long.png`
  - `auto-height-short.png`
  - `metrics.json`

## Playwright Caveat

I started Vite locally and attempted to screenshot the real authenticated canvas route with mocked auth/workspace/canvas responses, but the app redirected to `/en-US/login` before the canvas route rendered. Because no seeded `E2E_EMAIL`/`E2E_PASSWORD` credentials were available in this shell, I used a focused Playwright harness for the iframe sizing checks and a static header-cluster capture. The harness confirmed: long iframe content height `1370px` for `1368px` scroll height, short iframe content height `322px` for the `320px` minimum, no `title` attribute, and `aria-label="Canvas preview"`.
