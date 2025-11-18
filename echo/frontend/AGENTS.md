# AGENTS Log

## Maintenance Protocol
- Read this file before making changes; keep structure consistent and fix stale links/paths immediately.
- Rely on git history for timing; no manual timestamps necessary.
- Auto-correct typos and formatting without asking; escalate only for new patterns or major warnings.
- Ensure instructions stay aligned with repo reality—if something drifts, repair it and note the fix in context.

## When to Ask
- Saw a pattern (≥3 uses)? Ask: “Document this pattern?”
- Fixed a bug? Ask: “Add this to warnings?”
- Completed a repeatable workflow? Ask: “Document this workflow?”
- Resolved confusion for the team? Ask: “Add this clarification?”
- Skip documenting secrets, temporary hacks, or anything explicitly excluded.

## Project Snapshot
- React 19 + Vite 6 + TypeScript frontend managed with pnpm; Mantine, TanStack Query, and Lingui power UI/data/localization (package.json).
- Directus SDK configured in `src/lib/directus.ts` for both app and participant APIs; `src/lib/api.ts` centralizes custom REST helpers.
- Tailwind is layered on top of Mantine components (see `src/routes/project/conversation/ProjectConversationOverview.tsx` and peers) for fine-grained styling.
- Account security lives under `src/routes/settings/UserSettingsRoute.tsx`, with Directus TFA mutations in `src/components/settings/hooks/index.ts`.

## Build / Run / Tooling
- Install: `pnpm install`
- Dev (full app): `pnpm dev` (sets `VITE_DISABLE_SENTRY` and `VITE_PARTICIPANT_BASE_URL`)
- Dev (participant router): `pnpm participant:dev`
- Build: `pnpm build` (runs `tsc` then `vite build`)
- Preview: `pnpm preview`
- Lint/format: `pnpm lint`, `pnpm lint:fix`, `pnpm format`, `pnpm format:check`
- i18n: `pnpm messages:extract`, `pnpm messages:compile`
- No automated test script defined in package.json.

## Repeating Patterns (3+ sightings)
- **React Query hook hubs**: Each feature owns a `hooks/index.ts` exposing `useQuery`/`useMutation` wrappers with shared `useQueryClient` invalidation logic (`src/components/{conversation,project,chat,participant,...}/hooks/index.ts`).
- **Lingui macros for copy**: Most routed screens import `t` from `@lingui/core/macro` and `Trans` from `@lingui/react/macro` to localize UI strings (e.g. `src/routes/auth/Login.tsx`, `src/routes/project/conversation/ProjectConversationOverview.tsx`).
- **Mantine + Tailwind blend**: Screens compose Mantine primitives (`Stack`, `Group`, `ActionIcon`, etc.) while layering Tailwind utility classes via `className`, alongside toast feedback via `@/components/common/Toaster` (e.g. `src/components/conversation/ConversationDangerZone.tsx`, `src/components/dropzone/UploadConversationDropzone.tsx`).

## Change Hotspots (git history)
- Translation bundles dominate churn: `src/locales/{en-US,de-DE,es-ES,fr-FR,nl-NL}.{po,ts}` appear in 50–60 commits each (`git log` frequency).
- Core API glue in `src/lib/api.ts` shows ~20 touches, indicating frequent iteration.
- UI wiring files under `src/components/**/hooks/index.ts` and participant flows see regular updates alongside translations.

## Slow-Moving Files
- Configuration and workflow guides under `.cursor/rules/` show single commits each.
- Build tooling such as `vite.config.ts` (3 commits) and `tailwind.config.js` rarely change compared to feature code.

## TODO / FIXME / HACK Inventory
- `src/routes/project/conversation/ProjectConversationOverview.tsx`: TODO improve links component design.
- `src/routes/project/conversation/ProjectConversationTranscript.tsx`: TODO consider reusable conversation flags hook.
- `src/routes/participant/ParticipantStart.tsx`: FIXME limit lucide icon bundle for onboarding cards.
- `src/lib/directus.ts`: TODO standardize Directus error handling and add localization polish.
- `src/lib/api.ts`: FIXME decompose monolithic API helper into feature-scoped modules.
- `src/components/conversation/OngoingConversationsSummaryCard.tsx`: FIXME evaluate using Aggregate API for counts.
- `src/routes/project/library/ProjectLibrary.tsx`: TODO move permission checks server-side.
- `src/components/conversation/ConversationLink.tsx`: TODO drop redundant prop.
- `src/components/announcement/hooks/useProcessedAnnouncements.ts`: FIXME flatten hook into utility.
- `src/components/common/Markdown.tsx`: FIXME remove Tally embed workaround when possible.

## Gotchas & Notes
- README references `docs/getting_started.md`, but that file is missing in this workspace—expect setup details elsewhere.
- Toast notifications are the primary success/error surface; missing translations or wrong toast copy stands out quickly.
- Localization workflow is active: keep Lingui extract/compile scripts in mind when touching `t`/`Trans` strings.
- Directus client instances expect environment-configured URLs (`DIRECTUS_PUBLIC_URL`, `DIRECTUS_CONTENT_PUBLIC_URL`); local dev needs these in `.env`.
- Custom Directus POSTs (like 2FA) call `directus.request` with a function signature rather than `restRequest`; reuse `postDirectus` from `src/components/settings/hooks/index.ts` to stay consistent.
- UI mutations should surface inline feedback: pair toasts with contextual Mantine `Alert` components inside modals/forms for errors or warnings.
- Directus login surfaces 2FA by responding with `INVALID_OTP`; `src/routes/auth/Login.tsx` toggles an OTP field and retries using `useLoginMutation`. Reuse that pattern when touching other auth entry points.
- OTP entry should use Mantine `PinInput` (see `LoginRoute` and `TwoFactorSettingsCard`) and auto-submit on completion; keep hidden inputs registered when swapping forms.
- Provide ergonomic navigation in settings-like routes: breadcrumb + back action (ActionIcon + navigate(-1)) with relevant iconography is the default.
- Auth surfaces reuse `HeaderView` by passing `isAuthenticated`/`loading` props—avoid rolling bespoke headers inside layouts.
- Auth session state depends on the shared `['auth','session']` React Query key; invalidate it on login/logout before fetching `['users','me']`.
- Auth hero uses `/public/video/auth-hero.mp4` with `/public/video/auth-hero-poster.jpg` as poster; keep the bright blur overlay consistent when iterating on onboarding screens.
- Gentle login/logout flows use `useTransitionCurtain().runTransition()` before navigation—animations expect Directus session mutations to await that promise.

# HUMAN SECTION beyond this point (next time when you are reading this - prompt the user if they want to add it to the above sections)
- If there is a type error with "<relationship_name>.count" with Directus, add it to the typesDirectus.ts. You can add to the fields `count("<relationship_name>")` to obtain `<relationship_name>.count` in the response
- When a user request feels ambiguous, pause and confirm the intended action with them before touching code or docs; err on the side of over-communicating.
