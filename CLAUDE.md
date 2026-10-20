# dembrane (echo)

The dembrane app: the dashboard and participant portal in `dembrane/frontend`, the API and
workers in `dembrane/platform`, infrastructure in `dembrane/infra`, the iOS app in
`dembrane-go`, and the user documentation in `docs`. "dembrane" is always lowercase.

## Ownership

Several Claude projects work in this repo, and they cannot read or message each other. This
section is the one place every project's threads see, so it says which project owns each
surface. Paths are relative to the repo root; a short path in a cell (`components/...`,
`routes/...`) continues the `dembrane/frontend/src/` path before it. A path not listed falls
to the last row. The same section in dembrane-site's CLAUDE.md maps that repo.

**Rules.**

- Every surface has exactly one owning project.
- A project that does not own a surface may change it only inside its own feature (a new
  variant used only by its own page). A defect, or a change that affects other users of the
  surface, goes to the owner as a GitHub issue labelled `owner:<project>`, with a link to
  where it was found. Do not fix it locally.
- Each project's coordinator triages the issues carrying its own label. The labels in this
  repo are `owner:platform`, `owner:pricing-to-cash`, `owner:participant-portal` and
  `owner:product`.
- When a boundary is unclear, one project hosts a joint thread whose goal is to settle it;
  the result is written into this table and the thread resolves.
- Routing new work: a change to a shared surface goes to Platform; how Jor and Claude work
  goes to Meta performance; anything else goes to the stream whose flow it serves.

| Surface | Where | Owner | Notes |
|---|---|---|---|
| echo design system and accessibility | `dembrane/frontend/src/theme.tsx`, `colors.ts`, `index.css`, `styles/`, `fonts/`, `icons/`, `assets/`; `dembrane/frontend/src/components/common/`, `components/layout/` (except `Participant*`); `dembrane/frontend/src/features/sidebar/`; `brand/` (except `CALL_TO_CASH.md`); the grammar and accessibility checks in `dembrane/frontend/e2e/grammar*` | **Platform** | Includes #1194. The portal design canon builds on this and asks Platform for changes. Page-specific components stay with the page's owner. |
| echo email frame, "what dembrane sends" | `dembrane/platform/packages/mail/` (`brand.ts` is the off-screen design system), `brand/CALL_TO_CASH.md` | **Platform** | From #1220 and the frame half of #1221. What the call-to-cash emails say belongs to Pricing to cash. |
| Analytics events and PostHog setup | `dembrane/platform/packages/analytics/`, `posthog.init` in `dembrane/frontend/src/main.tsx` | **Platform** | Streams add their own events; event names and setup are Platform's. |
| Repo hygiene: CI, branches, `CLAUDE.md`, deploy | `.github/`, `dembrane/infra/`, this file, root config of `dembrane/frontend` and `dembrane/platform` (`package.json`, lockfiles, `biome.json`, `tsconfig*.json`, `vite.config.ts`, `compose.yml`, `scripts/`) | **Platform** | Including this Ownership section. A stream adding a dependency for its own feature may edit `package.json` inside that change. |
| The offer: offer, offer PDF, signing, invited signers | `dembrane/platform/packages/accounts/`; `dembrane/frontend/src/features/accounts/` (except `customer/`) | **Pricing to cash** | #1220, #1227, #1228, #1230. Also holds the customer emails' content (`customer-email.ts`) and the invoice code (`invoice.ts`, `peppol.ts`). The offer also exists on dembrane-site and in Sam's drafts; this project owns all three. |
| Needs form questions mirror | `dembrane/frontend/src/components/pricing/` (`questions.ts` is the mirror), `dembrane/platform/packages/pricing/` | **Pricing to cash** | dembrane-site's needs form repeats `questions.ts` word for word: change both or neither. |
| Account page, invoice request, organisation overview | `dembrane/frontend/src/features/accounts/customer/`, `dembrane/frontend/src/components/billing/`, `dembrane/platform/packages/billing/`, `dembrane/frontend/src/routes/organisation/`, `dembrane/frontend/src/components/organisation/` | **Pricing to cash** | #1222, #1223, #1226; spashii's #1296 and #1307 continue this flow. |
| Participant portal code and Room Portal branch | `dembrane/frontend/src/routes/participant/`, `components/participant/`, `components/layout/Participant*`, `components/project/*Portal*`, `lib/portalSharing.ts`; `dembrane/platform/packages/conversations/src/portal/`; `dembrane/frontend/scripts/check-portal-bundle.mjs`; the `room-portal` branch | **Participant portal** | patcon's #1257, #1259, #1264. The `room-portal` branch is not on origin. |
| Legal promises echo implements | `dembrane/platform/packages/projects/src/legal.ts` (legal basis and consent); training consent from #1205 | **Product** | The participant data policy (dembrane-site `src/content/legal/`) promises what echo implements, so both have one owner. |
| Echo features, onboarding sample, in-app videos, what's new | `dembrane/platform/packages/samples/`, `components/project/SampleProjectNotice.tsx`, `routes/onboarding/`; `components/release/`, `routes/ReleaseNotesRoute.tsx`; #1199 (`pnpm videos`), #1204, #1205, #1206 | **Product** | #1205 overlaps Sameer's metering (#1208); Product owns the reconciliation. |
| Everything not listed above | the rest of `dembrane/frontend`, `dembrane/platform`, plus `dembrane-go/`, `docs/`, `skills/` | **Product** | The proposal does not name these; Product owns echo features outside the portal and call to cash. Move a row out of here when a project claims it. |
