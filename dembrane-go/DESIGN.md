# dembrane go — product & design spec

> Status: draft v0.1 · Branch: `worktree-dembrane-go` · Target env: echo-next
> Always write **dembrane** lowercase. Never use "ECHO" in user-facing copy.

A native iOS / iPadOS / watchOS app to record conversations anywhere — locked phone,
iPad, wrist, or shared in from Voice Memos — transcribe and summarize them on
dembrane, and ask your conversations questions. Capture is the whole point, so
capture is one tap from anywhere.

---

## 0. TL;DR

- **Platforms:** iPhone + iPad + Apple Watch, SwiftUI, deployment target iOS/iPadOS 26, watchOS 26.
- **Nav:** bottom Liquid Glass tab bar — **Record · Conversations · Ask · Settings** — with a floating glass recording mini-bar accessory above the tabs while capturing.
- **Auth:** Sign in with Apple (primary) + email/password fallback, against echo-next Directus. Apple SSO is net-new backend (see §8).
- **Data model:** a recording is a *conversation* under a *project* in a *workspace*. First run picks your default workspace and auto-creates a project named **go**; both changeable in Settings.
- **Trust is a feature:** source available · ISO 27001 · no training on your data without explicit opt-in · based in the Netherlands (EU). Surfaced in onboarding, Settings, and the App Store listing — see §9.
- **Hard parts:** background/locked recording, Dynamic Island Live Activity, resilient background upload, a Share Extension, and a Watch recorder.

---

## 1. Concept & positioning

dembrane's core belief: **people know how.** dembrane go is the pocket capture tool
for that — it gets out of the way so you can record a real conversation, then helps
you make sense of it. Archetype: 80% Everyman + 20% Explorer (IKEA meets Patagonia):
reliable, unpretentious, with a spark of purpose.

Voice: warm, direct, a trusted colleague. Never "Successfully", "Please be advised",
"Click here". Empty states invite: *"No conversations yet. Start your first one."*

**Why someone uses it**
- Capture a meeting, interview, field note, or voice memo without fiddling — even with the phone locked.
- Get it transcribed and summarized automatically.
- Come back later and *ask* across everything they've recorded.
- Trust that their audio stays theirs (see §9).

---

## 2. Brand application

Source of truth: `echo/brand/STYLE_GUIDE.md` + `echo/brand/colors.json`.

| Token | Value | Use |
|---|---|---|
| Parchment | `#f6f4f1` | default background / canvas |
| Graphite | `#2d2d2c` | primary text, dark surfaces |
| Royal Blue | `#4169e1` | primary action, links, emphasis, record affordance |
| Cyan / Spring Green / Mauve / Lime | `#00ffff` / `#1effa1` / `#ffc2ff` / `#f4ff81` | accents, the logomark, waveform tint |
| Golden Pollen | `#ffd166` | warning (e.g. near free-tier cap) |
| Cotton Candy | `#ff9aa2` | error |

- **Type:** DM Sans with stylistic alternates `ss01–ss06`. Ship the font in-app (don't rely on a system fallback). Sizes per guide (Display 48–64, Headline 32–40, Title 24–28, Body 20, Caption 12–15). **Never bold** — emphasize with Royal Blue or *italics*. Left-align.
- **Icons:** Phosphor (regular weight). Pair with labels where clarity matters.
- **Liquid Glass:** use the system glass materials for the tab bar, recording accessory, and toolbars. Tint the active record state Royal Blue; the live waveform uses the accent palette over glass.
- **App icon:** the dembrane logomark (concentric-arc "d") on Parchment. `echo/brand/logos/logomark-*`.
- **Imagery:** no stock, no language-model-generated images. Real, candid, warm.
- **Localization:** EN + Dutch (informal je/jij) + Italian (A2, tu). Glossary in the style guide.

---

## 3. Information architecture

```
App (iPhone/iPad)
├─ Onboarding / Auth (modal, first run)
├─ Tab bar (Liquid Glass)              ← Record · Conversations · Ask · Settings
│   ├─ Record            capture home
│   ├─ Conversations     your recordings list → Conversation detail
│   ├─ Ask               chat across your conversations
│   └─ Settings          account, recording, privacy & data, workspace/project, about
│   └─ [accessory] Recording mini-bar  ← floats above tabs while capturing
├─ Quick-capture entry points          Lock Screen widget · Action Button · Control Center · Siri/App Intent
Share Extension                        receive audio from Voice Memos → queue upload
Widget + Live Activity Extension       Dynamic Island + Lock Screen recording activity
Watch app + complication               on-wrist record → transfer/upload
```

---

## 4. Screens

### 4.1 Onboarding / Auth
- One warm screen: logomark, a single line of value (*"Record any conversation. Make sense of it."*), and **Sign in with Apple** (primary, Royal Blue) + *"use email instead"* (tertiary).
- Below the buttons, a quiet trust row (see §9): *source available · ISO 27001 · no training on your data · based in the Netherlands.*
- After auth: resolve default workspace, ensure the **go** project exists, land on Record. Re-onboarding is seamless (the brand cares about infrequent use).

### 4.2 Record (home)
- Big, calm capture button (Royal Blue). Tap to start; the screen shifts to a live state: elapsed time, a live waveform (accent palette over Parchment), pause/stop.
- Below: a short strip of recent conversations and the current target project (tap to change).
- Starting a recording immediately starts the Live Activity / Dynamic Island and the background upload session.
- Permission priming: a friendly mic + (optional) background-audio explainer before the system prompt.

### 4.3 Conversations (list)
- Chronological cards (Parchment, minimal border, generous padding, one clear action per card): title (or "Untitled conversation"), date, duration, status pill — *Recording* / *Uploading* / *Processing audio…* / done.
- Search bar (server `search_text`), filter by tag/date.
- Empty: *"No conversations yet. Start your first one."* with a record shortcut.
- Free-tier: locked conversations show a soft lock with *"Upgrade to open"* (never scary). The single unlocked one is fully readable.

### 4.4 Conversation detail
- Header: editable title, date, duration, share/export.
- Summary first (the brand leads with sense-making), then the transcript — scrubbable, tap a line to seek audio playback.
- Audio playback via a new signed-URL endpoint (§8). Mini-player uses the glass accessory.
- Tags, and an *Ask about this* shortcut that opens Ask scoped to this conversation.
- Processing state: *"Processing audio…"* with a calm progress feel, not a spinner wall.

### 4.5 Ask (chat)
- Chat across your conversations (or scoped to one/some). SSE-streamed responses (Vercel AI data-stream format).
- Source citations render as chips linking back to the conversations used.
- Suggested prompts on empty state (from `/chats/{id}/suggestions`).
- Free-tier: 1 chat, 3 user turns — show remaining turns gently; nudge to upgrade at the limit.
- Copy for the model: *"the language model"*, never "AI".

### 4.6 Settings
- **Account** — name, email, sign out; tier + usage (hours used vs free 1h cap, with upgrade CTA `upgrade_cta_tier`).
- **Recording** — default workspace, default project (the **go** project), audio quality, "keep recording when locked", "record from Watch".
- **Privacy & data** (§9) — *"Train language models on my data"* toggle, **off by default, explicit opt-in**; links to source, ISO 27001, data location (NL), privacy policy; export / delete.
- **About** — version, *source available* link, licenses (Phosphor, DM Sans, etc.), what's new.

### 4.7 Share Extension (from Voice Memos)
- Minimal sheet: shows the incoming audio file(s), a target-project picker (defaults to **go**), and *"Add to dembrane go"*.
- Writes the file into the shared App Group container and enqueues a background upload; the host app picks it up. Confirmation: *"Added. We'll transcribe it."*

### 4.8 Apple Watch
- Single screen: a record button + elapsed time; a complication for one-tap start.
- Records on the watch mic when the phone's away; transfers via `WatchConnectivity` `transferFile` (or uploads directly on cellular) → becomes a conversation in the **go** project.

### 4.9 Live Activity / Dynamic Island
- Compact: red dot + elapsed time. Minimal: dot. Expanded: elapsed time, live level, pause/stop.
- Mirrors the in-app recording mini-bar. `NSSupportsLiveActivities = YES`.

---

## 5. Core flows

**Auth (Apple).** Sign in with Apple → app gets Apple identity token → `POST /api/v2/auth/apple` (new, §8) validates it, links/creates the Directus user, returns a session → store session in Keychain (shared access group, §6) → resolve workspace + go project.

**First-run setup.** `GET /api/v2/me` → orgs. `GET /api/v2/workspaces` → pick `is_default` workspace. `GET /api/v2/workspaces/{ws}/projects` → if no **go** project, `POST` create one (name "go"). Persist default workspace + project ids locally.

**Record → conversation.**
1. Start: configure `AVAudioSession(.playAndRecord)`, begin capture, start Live Activity, start background `URLSession`.
2. Per chunk: `POST /api/participant/projects/{projectId}/conversations/initiate` (first chunk) → `POST …/get-upload-url` → S3 multipart `POST` (presigned) → `POST …/confirm-upload`. Tag `source` as `GO_IOS` (§8).
3. Stop: `POST …/finish`. End Live Activity. Conversation shows *Processing audio…* then summary + transcript.
4. Resilience: chunks queued on disk; background session survives lock/suspension/kill and resumes on relaunch.

**Share-sheet import.** Voice Memos → share → dembrane go extension → file to App Group → enqueue background upload (same participant flow, `source = GO_SHARE`) → appears in Conversations.

**Watch capture.** Record on watch → `transferFile` to phone → phone runs the upload flow (or direct upload if reachable).

**Ask.** `POST /api/v2/bff/chats` (create) → `/add-context` (scope) → `POST /api/chats/{id}` (stream SSE) → render tokens + citations.

---

## 6. Technical architecture

**Targets**
- `dembrane go` (app, iPhone + iPad).
- `ShareExtension` (audio share).
- `WidgetsExtension` (Live Activity + Lock Screen widget + Control Center control).
- `dembrane go Watch App`.
- `Shared` framework (models, API client, keychain, upload manager) used by app + extensions.

**Frameworks:** SwiftUI, AVFoundation (`AVAudioRecorder`/`AVAudioEngine`), ActivityKit (Live Activity), WidgetKit, App Intents (Action Button / Siri / Control Center), WatchConnectivity, AuthenticationServices (Sign in with Apple), Security (Keychain), BackgroundTasks + `URLSession` background config.

**Background recording:** `UIBackgroundModes = [audio]`; `AVAudioSession` category `.playAndRecord`, mode `.default`/`.spokenAudio`, options `.allowBluetooth`. Handle interruptions (calls/Siri) and route changes; resume cleanly. Record while locked is allowed for an active user-initiated recording — App Store review note required (§10).

**Background upload:** `URLSessionConfiguration.background(withIdentifier:)`, shared across app + extension (`sharedContainerIdentifier` = App Group). `isDiscretionary = false` for active recordings. Handle `urlSession(_:task:didCompleteWithError:)` and the relaunch completion handler. Chunk files persisted until confirmed.

**Auth/session storage:** session token/cookie in Keychain with an access group shared by the app, Share Extension, and Watch. `URLSession` with `HTTPCookieStorage` for the Directus session cookie. Refresh on 401 once, else route to sign-in.

**Streaming chat:** consume `text/event-stream` via `URLSession.bytes(for:)` async sequence; parse the Vercel AI data-stream lines (`0:` text deltas, `h:` references).

**Offline / sync:** local store (SwiftData) of conversations + a pending-upload queue; reconcile with server on launch and on push/foreground.

---

## 7. API mapping (verified against code 2026-06-24)

| Capability | Endpoint | Auth |
|---|---|---|
| Who am I | `GET /api/v2/me` | session |
| Workspaces (+ tier, `is_default`, usage) | `GET /api/v2/workspaces` | session |
| Workspace usage / caps | `GET /api/v2/workspaces/{ws}/usage` | session |
| List / create projects | `GET\|POST /api/v2/workspaces/{ws}/projects` | session |
| Start a recording | `POST /api/participant/projects/{projectId}/conversations/initiate` | session-scoped participant flow |
| Get presigned upload | `POST /api/participant/conversations/{id}/get-upload-url` | " |
| Upload chunk | S3 multipart `POST` (presigned) | presigned |
| Confirm chunk | `POST /api/participant/conversations/{id}/confirm-upload` | " |
| Finish recording | `POST /api/participant/conversations/{id}/finish` | " |
| List conversations | `GET /api/v2/bff/conversations?project_id=` | session |
| Conversation detail (summary, transcript) | `GET /api/v2/bff/conversations/{id}?include_chunks=true` | session |
| Update conversation (title…) | `PATCH /api/v2/bff/conversations/{id}` | session |
| Create chat | `POST /api/v2/bff/chats` | session |
| Scope chat | `POST /api/chats/{id}/add-context` | session |
| Stream chat | `POST /api/chats/{id}` (SSE) | session |
| Chat suggestions | `GET /api/chats/{id}/suggestions` | session |

Base URLs (echo-next): API `https://api.echo-next.dembrane.com/api`, Directus `https://directus.echo-next.dembrane.com`.

---

## 8. Backend dependencies (net-new work on echo-next)

These don't exist yet and block parts of the app:

1. **Sign in with Apple** — `POST /api/v2/auth/apple` to validate the Apple identity token, create/link the Directus user, and mint a session. (Or configure a Directus OAuth provider for Apple.) Until then, dev uses email/password.
2. **Signed audio playback URL** — conversations expose `merged_audio_path` as a raw S3 key; add an endpoint returning a short-lived signed URL for playback (and per-chunk audio).
3. **Training opt-in flag** — a per-user (or per-workspace) consent boolean for "train language models on my data", default off. Verify whether `me.training_status` / `onboarding_answer_json` already covers this; if not, add it. The toggle in Settings binds to this.
4. **`source` label** — add `GO_IOS` / `GO_SHARE` to the conversation `source` enum so dembrane-go captures are distinguishable (analytics + UX).
5. **(Nice to have) push** — notify when audio processing finishes so the conversation card can flip without polling.

---

## 9. Trust, privacy & compliance (a first-class feature)

dembrane is privacy-first and EU-grounded; the app should *say so* plainly, in the brand voice (no legalese). Four pillars, surfaced in onboarding (quiet trust row), Settings → Privacy & data, the About screen, and the App Store listing:

- **Source available** — *"You can read our code."* Link to the public repo.
- **ISO 27001** — *"Certified information security."* Link to the statement/certificate.
- **No training on your data** — *"We don't train language models on your recordings. If you want to help improve them, you can opt in — it's off by default."* Backed by the explicit opt-in toggle (§8.3).
- **Based in the Netherlands** — *"Your data lives in the EU."* Pairs with the EU-sovereign positioning of higher tiers.

Plus: clear export and delete, on-device transcript caching only for your own conversations, and Apple privacy-nutrition labels + `PrivacyInfo.xcprivacy` that match these claims honestly. Microphone usage string is specific: *"dembrane go records audio so you can transcribe and revisit your conversations."*

---

## 10. App Store & deployment

Mirror the `font-changer` pipeline (`spashii/font-changer`):
- **Signing:** Xcode automatic signing, Apple Team `JMCP69LCSU` (eu.tangerinetech). Bundle id `com.dembrane.go` (+ `.ShareExtension`, `.Widgets`, `.watchkitapp`). App Group `group.com.dembrane.go`, shared Keychain access group.
- **fastlane:** `deliver` manages metadata + screenshots; binary uploaded from Xcode (`skip_binary_upload(true)`). App Store Connect API key (`.p8` + key_id + issuer_id) in `fastlane/api_key.json` (gitignored — reuse or mint a new key).
- **Assets to author:** `store/APP_STORE.md` (ASO listing), `REVIEW_NOTES.md`, `PrivacyInfo.xcprivacy`, screenshots, App Privacy answers.
- **Review notes must cover:** why we record in the background / while locked (user-initiated capture, like Voice Memos); Sign in with Apple present; mic + background-audio justifications; that no language-model training happens on user data without opt-in.
- **Entitlements:** Sign in with Apple, App Groups, Keychain sharing, Background Modes (audio), Push (if §8.5), HealthKit-free.

---

## 11. Build roadmap (proposed milestones)

1. **M0 — scaffold:** Xcode project, targets, Shared framework, brand tokens (colors, DM Sans, Phosphor), API client, Keychain. App runs, shows the 4-tab Liquid Glass shell.
2. **M1 — auth + setup:** email/password sign-in (works today) → me/workspaces → ensure **go** project. Conversations list (read).
3. **M2 — recording core:** foreground record → participant upload flow → finish → see it process. Conversation detail + playback (needs §8.2).
4. **M3 — background & Dynamic Island:** background/locked recording, background upload resilience, Live Activity.
5. **M4 — Ask:** SSE chat + citations + suggestions.
6. **M5 — Share Extension:** Voice Memos import.
7. **M6 — Watch:** on-wrist capture + transfer.
8. **M7 — trust & polish:** Sign in with Apple (needs §8.1), Privacy & data screen + opt-in, localization, App Store assets, fastlane.

Backend track (parallel): §8.1 Apple SSO, §8.2 playback URL, §8.3 training opt-in, §8.4 source label.

---

## 12. Open questions

- Default project name literally **go** vs **"dembrane go"** vs date-based? (current: `go`)
- Should Watch capture require the phone, or support standalone cellular upload in v1?
- iPad: same 4-tab layout, or a sidebar (`NavigationSplitView`) on regular width?
- Do we want a one-time "import your existing Voice Memos" bulk flow, or share-sheet only?
