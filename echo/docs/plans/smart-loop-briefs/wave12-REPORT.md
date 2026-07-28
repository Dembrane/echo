# Wave 12 Canvas Polish Report

## Summary

Implemented the canvas polish pass across the kit, QR assembly, freshness controls, navigation, and tracking docs.

## What Changed

- Canvas kit now inlines the bundled DM Sans WOFF2 into iframe CSS and uses DM Sans Variable with brand stylistic sets.
- Canvas kit palette tokens were reconciled with the brand guide: parchment, graphite, royal blue, cyan, spring green, mauve, lime cream, golden pollen, and cotton candy.
- Canvas documents now get an assembler-owned quiet brand mark below the generated content. The shell uses the existing whitelabel logo context when available, fetched and converted to a data URI for the iframe CSP, with the dembrane wordmark fallback.
- Added assembler-side `canvas-qr` support. Generated `<div class="canvas-qr" data-url="...">` placeholders are replaced with inline SVG QR codes only when the URL matches the current project portal route on the configured portal origin; foreign URLs are removed.
- Documented the QR primitive and the actually supported participant query parameters: `skipOnboarding=1`, `tags`, `tag_id_list`, `theme`, and `utm_source`.
- Added direct frontend dependency on `qrcode-generator` because the canvas assembler now uses it outside `react-qrcode-logo`.
- Added editable canvas freshness controls: the chip now includes day-aware expiry copy, shows cadence in plain language, and opens a popover for 8 hours / 24 hours / 3 days / custom plus 5 / 15 / 60 minute cadence.
- Added `PATCH /api/v2/bff/canvases/{canvas_id}/loop` and shared service logic to update mandatory bounded expiry and cadence, reset failures, and requeue active loops.
- Canvas breadcrumbs now include `Library > <canvas name>`, and the Library sidebar item is active on `/canvases/*`.
- Added v1.5 tracking lines for live monitor canvas embeds and latest-conversations via SSE/no polling.

## Validation

- `./node_modules/.bin/tsc --noEmit` passed.
- `./node_modules/.bin/biome lint ... --diagnostic-level=error` passed on touched frontend files.
- `./node_modules/.bin/lingui extract && ./node_modules/.bin/lingui compile --typescript` passed.
- `./node_modules/.bin/vite build` passed.
- `./.venv/bin/ruff check dembrane/api/v2/bff/canvases.py dembrane/canvas/service.py tests/api/test_bff_canvases.py` passed.
- `./.venv/bin/pytest -q tests/api/test_bff_canvases.py tests/test_canvas_sanitize.py tests/test_canvas_ticks.py` passed: 19 tests.

## Notes And Gaps

- `pnpm` was not directly on PATH. `CI=true corepack pnpm install --frozen-lockfile` linked the new dependency but exited nonzero because this workspace requires build-script approval for some packages; the subsequent TypeScript and Vite build checks passed.
- I did not run Playwright screenshot coverage or produce `wave12-shots/`; the local task did not have a seeded app/session fixture ready for the canvas route.
- I did not implement new participant portal parameters. The existing supported params are documented and used as the QR boundary.
