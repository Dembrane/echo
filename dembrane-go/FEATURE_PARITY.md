# dembrane Go — frontend → app feature parity

Systematic map of the **echo web frontend** functions (audited from `echo/frontend/src/Router.tsx`, `components/`, `lib/api.ts`) against the **dembrane Go** iOS app. Status as of build 25 (committed; builds 24–25 pending the next TestFlight upload window).

Legend: ✅ built · � gated (needs echo backend, Sameer's OK) · 🖥️ desktop-only (out of scope for the mobile capture app) · ⏳ deferred.

## Auth
- ✅ Login (email/password) — Directus `/auth/login` → Bearer
- ✅ Register (3-step) — `/api/v2/auth/register`
- ✅ Forgot password — opens dashboard reset page (web)
- ✅ Logout · session restore (Keychain on device / UserDefaults on sim)
- � Sign in with Apple — needs a backend `POST /api/v2/auth/apple` route

## Home / navigation
- ✅ Tab bar Home · Record · Conversations · Ask (Apple-native; Record is an armed action, hidden while recording; Now-Playing accessory bar while recording)
- ✅ Home: "Welcome, <name>" + recent conversations + search bar
- ✅ Search (conversations + "Ask …"), `.searchable`

## Recording (mobile-first; richer than web)
- ✅ Tap Record → armed Start → Now-Recording (big timer, live metered waveform, pause/resume, mic picker)
- ✅ 30s chunked upload during capture (crash-safe) · background/locked recording
- ✅ Live Activity / Dynamic Island (logomark + timer + waveform glyph)
- ✅ Location-based naming (Voice Memos style, optional/graceful)

## Conversations
- ✅ List (full-width project header, relative time + duration, summary, search, cache+reconcile)
- ✅ Detail (summary as markdown + per-chunk transcript, copy, ShareLink)
- ✅ Edit screen (name + large summary editor w/ Regenerate + inline tags)
- ✅ Delete · Move to project · Tags (view/assign/create)
- ✅ Summarize / Generate title / Re-transcribe (detail menu)
- ✅ Multi-select → Ask / Share / Delete; long-press → Photos-style context menu
- ⏳ Tags shown on list rows — needs tags in the list payload (backend) to avoid per-row N+1 (the junction GET is single-conversation only)
- � In-app audio playback — needs a backend signed-playback-URL endpoint (`merged_audio_path` is a raw S3 key)

## Ask / chat
- ✅ Create chat → add-context (specific conversations) / auto-select / select-all → stream (`protocol=data`, `0:`/`h:`/`3:` parsed)
- ✅ Markdown answers + cited sources · auto-add the in-progress recording
- ✅ Context multi-select picker (summaries, select-all) · chat history (resume)
- ✅ Workspace + built-in template chips (`/api/templates/prompt-templates`)
- 🖥️ Chat modes overview/deep_dive/agentic, agentic research runs — desktop-oriented

## Projects / workspaces
- ✅ List (cross-workspace flat picker, cached) · create · switch · default "Go Recordings" (auto-create, remembered)
- ✅ First-run "choose a workspace" onboarding
- ✅ Settings → open project editor (dashboard portal-editor link)
- 🖥️ Project settings/portal-editor (tags, flow, feature toggles, anonymize), access/visibility, clone, usage, webhooks, members/invites — desktop

## Settings
- ✅ Account (email), default project, source link, version, sign out
- (removed Privacy & data per feedback)

## Cross-cutting
- ✅ Production backend default (echo-next/local selectable) · disk cache + reconcile (conversations, projects)
- ✅ Loading / error+retry states · accessibility labels
- ⏭️ Notifications/webhooks — explicitly skipped per Sameer

## Not built (intentionally) — desktop-shaped web features
Library / Views / Aspects / Insights, Reports (+scheduling/public), Verification artefacts workflow, Admin/billing, workspace member management. Flag any to bring to mobile.
