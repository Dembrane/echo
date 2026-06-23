# Analytics instrumentation: implementation plan

Engineering companion to the team-facing `docs/plan.md`. That doc is the "what
and why" for a non-technical audience. This one is the "how" for whoever picks
up the build. Nothing here is built yet; this is the agreed shape.

## Goal

Capture the business and product moments we currently can't see, and make the
numbers trustworthy by (a) surviving ad blockers and (b) recording
source-of-truth moments on the server where the browser can't be blocked.

## Foundations

### A. Reverse proxy (client events survive ad blockers)

PostHog's prescribed default is a **managed reverse proxy** (CNAME a subdomain to
a PostHog-provided host; they run it on Cloudflare, free for Cloud users). The
self-hosted options are for cost or compliance cases.

For us the deciding factor is **EU data residency** (civic/PII tool, EU PostHog
projects, EU SendGrid). None of the options is automatically clean:

| Option | Effort | Residency | Notes |
|---|---|---|---|
| Managed CNAME (`e.dembrane.com`) | Lowest | Cloudflare EU edge, "not strictly guaranteed", not HIPAA | PostHog's default. Needs DNS + privacy sign-off. |
| Self-host in our ams3 cluster (nginx/Caddy) | Highest | Best, fully ours | Uses existing `echo-gitops` infra. We own maintenance. |
| Vercel `vercel.json` rewrites (`/i`) | Low | Transits Vercel edge | Ship-today stopgap. PostHog won't troubleshoot. Vercel data-transfer fees (small since portal is event-only). |

Decision is open (see below). The Vercel `/i` stopgap, if used, is the EU config
below. Three rules, in order, **above** the catch-all `/(.*) -> /` rewrite:

```json
{
  "rewrites": [
    { "source": "/i/static/:path(.*)", "destination": "https://eu-assets.i.posthog.com/static/:path" },
    { "source": "/i/array/:path(.*)",  "destination": "https://eu-assets.i.posthog.com/array/:path" },
    { "source": "/i/:path(.*)",        "destination": "https://eu.i.posthog.com/:path" }
  ]
}
```

SDK (`frontend/src/main.tsx` + `config.ts`): `api_host: "/i"`,
`ui_host: "https://eu.posthog.com"`. The `/array/` rule is required (SDK config +
flags); without it things break silently. `vite.config.ts` `server.proxy` is
local-dev only and does nothing in production (Vercel rewrites do prod). Local
capture is off anyway, so the vite proxy is optional parity.

CSP in `frontend/vercel.json` must be updated; the requests become same-origin.
This touches security, so run `/security-review` on the proxy change.

### B. Server-side capture

Reuse `server/dembrane/analytics.py` `capture_event` (fire-and-forget, never
raises, env-gated to prod + echo-next). `distinct_id = email or app_user_id`, as
the existing onboarding event does.

### Naming convention

- Server-originated events get a `server_` prefix (e.g. `server_workspace_created`).
- Exception: where a client and server event are two ends of one funnel
  (registration), keep a shared base name + a `source: "server" | "client"`
  property so PostHog's funnel tool can relate them.
- Keep the existing `snake_case` past-tense style and funnel-pair pattern.

## Phase 1: Server-side business events

| Event | Endpoint |
|---|---|
| `server_user_created` | `POST /v2/auth/register` (`auth.py:274`) |
| `server_workspace_created` | `POST /v2/workspaces` (`workspaces.py:633`) |
| `server_tier_changed` | `PATCH /v2/workspaces/{id}/tier` (`workspaces.py:976`) |
| `server_invite_sent` / `server_invite_resent` | `invites.py:110`, `invite_actions.py:124` |
| `server_invite_accepted` / `server_member_joined` | accept + join endpoints in `access_requests.py` |
| `server_workspace_join_requested` / `_approved` / `_denied` | `access_requests.py:199/288/498` |
| `server_training_requested` | `training.py:251` |

`invite_sent` fires when we hand the email to SendGrid (we control it). True
`delivered`/`opened` need a SendGrid event webhook; deferred.

## Phase 2: Portal journey + source attribution (frontend)

- **Source attribution**: extend `useProjectSharingLink(project, source)` to append
  `utm_source` (PostHog auto-captures `utm_*`). Tag the surfaces: the QR's encoded
  `value` vs its clickable `href` get different tags (splits scan vs click);
  `copy_link`, `qr_download`, `host_guide`, `report`, `portal`. Migrate the
  hand-built `/start` URLs (`ProjectReportRoute.tsx:796`, participant-side,
  `config.ts:171`) onto the hook so nothing ships untagged.
- **Journey funnel** (client, participant routes): `portal_landed` ->
  `consent_given` -> `recording_started`/`upload_started` -> `conversation_finished`
  -> `report_viewed`.
- **Recording errors**: promote the `captureException` at
  `ParticipantConversationAudio.tsx:334` to a first-class
  `portal_recording_error {stage, mime_type, device}` so we get a rate.
- **Privacy gate**: no session recording on the portal; participants are
  anonymous (no `identify`). Sign-off before shipping.

## Phase 3: App-health events

- `server_conversation_finished {method: "explicit" | "auto"}` — tag where
  `is_finished` is set: user finish endpoint = explicit, L1 catch-up in `tasks.py`
  = auto.
- `server_summary_generated {duration_seconds, conversation_type}` — piggyback on
  the finalization task that runs when the summary lands. Duration from the
  transcribed/finish timestamp to now (confirm a timestamp exists to diff).
- `verify_used` / `verify_regenerated` — participant verify flow (`VerifyArtefact.tsx`).
- `explore_used {mode}` (piggyback on existing `chat_mode_selected`) /
  `explore_rate_limited` (where the 429 surfaces).

## Phase 4: Website + Tally (needs coordination, outside this repo)

- Confirm the marketing site runs the same PostHog project so the cross-subdomain
  cookie actually stitches website visitor -> signup.
- Wire Tally's native PostHog integration (or capture on submit).

## Recommended build order

1. Proxy foundation (recovers all client-side events).
2. Portal journey + source attribution (biggest blind spot).
3. App-health events (cheap, mostly server-side piggybacks).
4. Server-side business events.
5. Website + Tally (waits on DNS/marketing/privacy).

## Open decisions (for the team / Sameer)

1. **Proxy home**: managed CNAME vs self-host in ams3 vs Vercel `/i` stopgap.
   Hinges on EU residency tolerance and who owns DNS/infra.
2. PostHog MCP connection (audit live events before building to avoid duplicates).
   Connect manually: `claude mcp add posthog --transport http https://mcp.posthog.com/mcp`
   then `/mcp` to authenticate (the `npx @posthog/wizard` TUI can't run headless).
3. Confirm the marketing site shares our PostHog project.
4. Dashboards/insights are owned by analytics and must be created in **both** EU
   projects (production 160282 and echo-next 197841), never just one.
