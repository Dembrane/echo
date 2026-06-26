# dembrane go

Native iOS / watchOS app to record conversations anywhere, transcribe them on
dembrane, and ask your conversations questions. See [DESIGN.md](DESIGN.md) for
the product + design spec, [FEATURE_PARITY.md](FEATURE_PARITY.md) for the
frontend→app parity audit, and [TESTFLIGHT.md](TESTFLIGHT.md) for shipping.

> Always write **dembrane** lowercase. Never use "ECHO" in user-facing copy.

## Status — feature-complete vs. the echo web frontend (non-server) ✅

- Apple-native iOS 26 (Liquid Glass). Tabs: **Home · Record · Conversations · Ask**
  (Record is an armed action; while recording it's replaced by a Now-Playing-style
  accessory bar). Settings opens from the Home avatar.
- Clean, warning-free build; **31** `DembraneCore` unit tests passing.
- Delivery: installed to device over **USB on-demand** (default) and shipped to
  **TestFlight on request** (`fastlane beta`; latest = build 27).

## Features

**Capture / recording**
- Tap Record → armed **Start** (capture never begins by surprise) → live screen.
- Now-Recording: big timer, **live metered waveform**, pause/resume, mic picker.
- **30s chunked upload** during capture (crash-safe) + background/locked recording.
- **Live Activity / Dynamic Island** (logomark + timer + waveform glyph).
- **Location-based naming** (Voice Memos style; optional + graceful if declined).
- **Save-confirmation banner** ("Saving… → Saved to *project*") after you stop.
- **Haptics** on start/stop, pause/resume, send, delete, and save.
- **Share Extension** — import audio from Voice Memos / Files (source `GO_SHARE`).
- **"Start Recording" App Intent** → Action Button, Siri, Spotlight, Shortcuts.
- **Apple Watch** capture → WatchConnectivity transfer → phone upload (`GO_WATCH`).

**Conversations**
- List: full-width project header, relative time + duration, summary, tags on rows.
- Search + disk **cache & reconcile** (instant load, refreshes in the background).
- Detail: summary (markdown) + per-chunk transcript with timestamps, copy, share.
- **Edit screen**: name + summary editor with Regenerate + inline tags.
- Delete · Move to project · Tags (view / assign / create).
- Summarize / Generate title / Re-transcribe from the detail menu.
- **Multi-select** → Ask / Share / Tag / Delete; long-press **Photos-style** context menu.
- Swipe actions; native empty / error / no-results states (`ContentUnavailableView`).

**Ask (chat)**
- New chat → add context (specific conversations / auto-select / **select-all**) → stream.
- **Markdown** answers + cited sources; auto-adds the in-progress recording.
- Context multi-select picker; resumable chat history.
- Workspace + built-in **prompt-template** chips; keyboard dismisses interactively.

**Projects / workspaces**
- Cross-workspace flat picker (cached), create, switch.
- Default **"Go Recordings"** project (auto-created, remembered across launches).
- First-run **"choose a workspace"** onboarding.
- Settings → open the project's portal editor on the dashboard.

**Auth & settings**
- Login (email/password via Directus), 3-step Register, forgot-password (web).
- Session restore (Keychain on device / UserDefaults on simulator), sign out.
- Settings: account, default project, source link, version.

**System integration (Apple)**
- App Intent / App Shortcut, Action Button, Siri, Spotlight.
- Live Activity / Dynamic Island, Share Extension, App Groups.
- iOS 26 Liquid Glass throughout; Icon Composer app icon (logomark).

## Notes — not yet in the app (gaps vs. the web frontend)

**Server-dependent (need echo backend work):**
- **In-app audio playback** — needs a signed-playback-URL endpoint (`merged_audio_path`
  is a raw S3 key, not directly playable).
- **Tags in the conversations-list payload** — would let rows batch-load tags
  instead of the current lazy per-row fetch.
- Server-side **GO source attribution** + **training opt-in** persistence.

**Desktop-shaped (intentionally out of the mobile capture app for now):**
- Library / Views / Aspects / Insights.
- Reports (+ scheduling / public links) and the verification-artefacts workflow.
- Project settings / portal editor (tags, flow, feature toggles, anonymize),
  access & visibility, clone, usage, webhooks.
- Workspace member management / invites; admin / billing.
- Chat modes (overview / deep-dive / agentic) and agentic research runs.

## Roadmap / future

- **Embed + ship the Apple Watch app** — code is committed and compiles standalone,
  but the target is shelved: this machine has no watchOS *simulator runtime*, so the
  combined archive is unverified (re-enable in `project.yml` once a runtime / paired
  watch is available).
- **Home Screen + Lock Screen widgets** (recent conversations, quick-record) and a
  **Control Center** "Start Recording" control (extends the existing App Intent).
- **In-app playback** once the backend signed-URL endpoint lands.
- **iPad-optimized** layout (currently iPhone device family only).
- Read-only **Reports / Insights** on mobile, if wanted.
- **Offline queue + retry surfacing** for failed chunk uploads.
- **Completion notifications** when transcription / summary finishes (needs webhooks —
  explicitly deferred for now).

## App Store compliance (verified June 2026)

- **Sign in with Apple — not required.** Guideline 4.8 only triggers when an app
  uses a third-party/social login to set up the primary account. dembrane-go uses
  only its own email/password (Directus) auth, so it's covered by the "exclusively
  uses your company's own account setup" carve-out. *Adding a social login (e.g.
  "Continue with Google") would make Sign in with Apple — or an equivalent — required.*
- **In-App Purchase — not triggered.** Nothing is sold or unlocked in-app; billing
  happens on the web dashboard (the standard multiplatform-service pattern), so 3.1.1
  doesn't apply. The `WorkspaceUsage.uploadsLocked` / `upgradeCtaTier` / `overCapActive`
  fields are unused in the UI. If a free-tier gate is ever surfaced on iOS, keep it
  **informational** (e.g. "uploads locked — manage your plan on the web") with **no
  in-app purchase button/link** — that stays compliant on every storefront without an
  External Purchase Link Entitlement (US-storefront external-payment CTAs are permitted
  post-May 2025, but the rest of the world still restricts them).

## Delivery

- **USB (default):** build for the connected device and install with `devicectl`
  (no Apple upload, no daily cap) — the day-to-day testing path.
- **TestFlight (on request):** `fastlane beta` archives Release and uploads. Apple
  enforces a per-app **daily upload cap** (error 90382, ~20/day) — see
  [TESTFLIGHT.md](TESTFLIGHT.md). Bump `CURRENT_PROJECT_VERSION` in `project.yml`
  for each upload.

## Prerequisites

- **Xcode 26.x** (iOS / watchOS 26 SDK). Verify: `xcodebuild -version`.
- **XcodeGen** — the project is generated from [`project.yml`](project.yml); a copy is
  vendored at `.tooling/xcodegen` (no Homebrew needed). The `.xcodeproj` is generated
  and git-ignored — always regenerate, never edit it by hand.

## Common commands (or use the [Makefile](Makefile))

```sh
# Regenerate the Xcode project from project.yml
.tooling/xcodegen generate            # make gen

# Fast logic tests (no simulator) — the tight feedback loop
cd Packages/DembraneCore && swift test   # make test-core

# Build the app for the iOS 26 simulator
xcodebuild build -project DembraneGo.xcodeproj -scheme DembraneGo \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -configuration Debug CODE_SIGNING_ALLOWED=NO   # make build

# Build + install on a USB-connected iPhone (find the udid: xcrun devicectl list devices)
xcodebuild build -project DembraneGo.xcodeproj -scheme DembraneGo \
  -destination 'id=<device-udid>' -configuration Debug -allowProvisioningUpdates
xcrun devicectl device install app --device <device-udid> \
  "$HOME/Library/Developer/Xcode/DerivedData/DembraneGo-*/Build/Products/Debug-iphoneos/DembraneGo.app"

# Ship to TestFlight (on request)
ASC_KEY_ID=… ASC_ISSUER_ID=… fastlane beta
```

## Layout

```
dembrane-go/
  project.yml              XcodeGen spec (source of truth for the Xcode project)
  Makefile                 gen / test-core / build / test / run / clean
  App/
    Sources/               SwiftUI app: DembraneGoApp, RootView (tabs), Features/*, Components/*, Intents/*
    Tests/                 app unit tests
  Packages/DembraneCore/   shared logic package (env, models, endpoints, SSE/AI parser, API client, AppGroup)
  Widgets/                 Live Activity / Dynamic Island
  ShareExtension/          "share audio to dembrane go" import
  Watch/                   watchOS capture app (compiles standalone; target shelved — see project.yml)
  fastlane/                beta lane → TestFlight (AuthKey.p8 git-ignored)
  .tooling/                vendored xcodegen binary (git-ignored)
```

## Note on build settings

This machine has no XcodeGen `SettingPresets`, so a few defaults XcodeGen normally
injects are set explicitly in `project.yml`: `PRODUCT_NAME=$(TARGET_NAME)`,
`ALWAYS_SEARCH_USER_PATHS=NO`, `ONLY_ACTIVE_ARCH=YES` (Debug),
`ENABLE_TESTABILITY=YES`, and the test target's `BUNDLE_LOADER=$(TEST_HOST)`.
If you run on a machine with presets available, these are harmless.
