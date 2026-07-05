# App Review — rejection response (submission daec16d2, v1.0 build 30)

Status of each point and the draft reply to paste in App Store Connect.

## What changed in the app (ships in build 32)

- **Guideline 4 (browser sign-in/register)** — "Create an account" now opens the
  native in-app registration flow (`RegisterView`); sign-in was already native.
  Forgot-password and legal links open in an in-app `SFSafariViewController`
  sheet instead of Safari.
- **Guideline 5.1.1(v) (account deletion)** — Settings → Delete account now
  deletes in-app: confirmation dialog → authed `DELETE /api/user-settings/account`
  → signed out. The account is suspended immediately (login blocked) and
  permanently purged within 30 days; the dialog says so.

## Before resubmitting (checklist)

1. **Deploy the backend endpoint to production** — `DELETE /api/user-settings/account`
   (commit 5dda1e07) must be live before review, or the reviewer's deletion
   attempt fails. Backend prod deploys only on release tags.
2. **Record the background-audio video** (guideline 2.5.4) on a physical device:
   start a recording in dembrane Go → go to Home Screen → show the Dynamic
   Island / red status indicator with recording continuing → return and stop.
   Attach it in App Review Information → Notes.
3. Upload build 32 via `fastlane beta`, attach the reply below.

## Draft reply

> **Guideline 4 — Design**
> Fixed in build 32. Sign-in has always been fully native in the app
> (email/password against our own backend). Account registration is now also a
> fully native in-app flow; no step opens the system browser. The remaining web
> links (password reset, terms, privacy) are displayed inside the app with
> SFSafariViewController.
>
> **Guideline 2.5.4 — Background audio**
> dembrane Go is an audio recording app: its core feature is recording
> conversations (workshops, interviews, consultations) that routinely last an
> hour or more, during which users lock the device or switch apps. The "audio"
> background mode is required to keep the microphone capture session running
> while the app is in the background. A screen recording made on a physical
> device showing a recording continuing from the Home Screen (with the system
> microphone indicator and our Live Activity visible) is attached in the Notes
> field of App Review Information.
>
> **Guideline 5.1.1(v) — Account deletion**
> Fixed in build 32. Settings → "Delete account" now completes deletion
> entirely inside the app: the user confirms, the app calls our authenticated
> deletion API, the account is disabled immediately, and the account and all
> its data are permanently deleted within 30 days (stated in the confirmation
> dialog). No website visit, no re-entering credentials, no customer service
> contact is required.
>
> **Guideline 2.1(b) — Business model**
> 1. dembrane is a B2B service for organizations (municipalities, researchers,
>    facilitators) that record and analyze group conversations. App users are
>    members of those organizations, plus individual professionals on our free
>    tier.
> 2. Organizations purchase workspace subscriptions on our website through our
>    sales team. Nothing can be purchased in the app, and the app contains no
>    links or calls to action to purchase.
> 3. A signed-in user can access the workspaces and projects their organization
>    already has: recording, transcription, and analysis of their own
>    conversations, with capacity determined by the organization's plan.
> 4. No content or features are unlocked by payment inside the app. The app is
>    a free companion to the web dashboard; every signed-in user gets the same
>    app functionality. When an organization's plan limit is reached, the app
>    shows an informational notice only, with no purchase link.
> 5. Our services are sold to organizations/teams (multi-user, B2B), not to
>    consumers or for family use. Individuals can also use the free tier at no
>    cost.
