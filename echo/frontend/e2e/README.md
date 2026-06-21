# E2E (Playwright) — partner & observer flows

Drives the local dev app (Vite `:5173` → API `:8000` → Directus) to verify the
Wave F/G partner flows in a real browser.

## Run

```bash
cd frontend
npx playwright install chromium          # once (deps: npx playwright install-deps chromium)
# unauthenticated smoke — no setup needed:
npx playwright test --config e2e/playwright.config.ts e2e/smoke.spec.ts
# authenticated flows — need a verified partner-org admin login:
E2E_EMAIL=you@dembrane.com E2E_PASSWORD=... \
  npx playwright test --config e2e/playwright.config.ts e2e/partner-flows.spec.ts
```

## Auth + seed prerequisites (why authenticated specs skip by default)

The app gates login on **email verification**, so automated registration can't
self-serve a session. Authenticated specs therefore need an existing **verified**
user provided via `E2E_EMAIL` / `E2E_PASSWORD`.

The partner specs also need that user to be an **admin/owner of a partner org**
(`org.is_partner = true`). `is_partner` is staff-set, so seed it once against the
local Directus admin API:

```
PATCH http://directus:8055/items/org/<org_id>  { "is_partner": true }
```

(or flip it from the staff admin dashboard). The "for another client" branch on
`/w/new` only appears for partner orgs.

## Coverage

| Spec | Flow | Issue |
|------|------|-------|
| smoke | app loads, auth surface renders (no auth) | — |
| partner-flows: data owner gate | create external-client workspace requires data owner + agreement | 026 |
| partner-flows: observer gating | observer role offered only for external-client workspaces | 030 |
| partner-flows: create-org CTA | external-only user sees "Set up your organisation" | 028 |

Server-side enforcement for all of these is covered by
`server/tests/test_partner_wave_fg.py` and `server/tests/test_seat_capacity.py`
(these run with no app/browser).
