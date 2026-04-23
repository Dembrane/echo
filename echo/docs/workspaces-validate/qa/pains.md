# QA Pains

Format per entry:

```
### [tag] short-title — module · yyyy-mm-dd
- Where: URL / component
- Expected:
- Observed:
- Repro:
- Screenshot: qa/_shots/<file>.png
```

Tags: `[block]` blocks the flow · `[hurt]` causes user harm / data risk · `[rough]` rough edge, UX/polish · `[note]` observation worth capturing

---

### [rough] No "resend email" / "wrong address?" on Check-your-email step — Onboarding · 2026-04-23
- Where: `/en-US/register` step 3 (after Create account)
- Expected: A "Didn't get it? Resend" action and/or "Used the wrong email? Go back" affordance — this is the dead-end screen if the mail never arrives
- Observed: Only a static heading "Check your email" + "We sent a verification link to <email>. Click the link to finish setting up your account." No resend, no back, no support link
- Repro: Register a new account and land on step 3
- Screenshot: qa/\_shots/01-register-verify.png

### [block→fixed] 500 on `POST /api/v2/onboarding/complete` — signature mismatch, fixed during session — Onboarding · 2026-04-23
- Where: server — `echo/server/dembrane/api/v2/onboarding.py:308-312` calls `on_workspace_created(workspace_id=…, creator_app_user_id=…, inherit_team_admins=True, inherit_team_members=False)` but the target function in `inheritance.py:315` only accepts `workspace_id` and `creator_app_user_id`. The `inherit_team_*` kwargs were retired per matrix v1.1 §6 ("No settings-flag writes anymore … The inherit_team_members concept retired") but this caller wasn't updated.
- Symptom: `POST /api/v2/onboarding/complete` returns `500 Internal Server Error`, solo onboarding is completely blocked, user stuck on onboarding page with no feedback.
- No client-side toast / inline error on the 500 — just silent failure + re-enabled button. That's a secondary `[rough]`.
- Sameer patched this mid-session in the devcontainer, re-testing after fix.

### [rough] Joining a workspace doesn't refetch the list — Invitations & access · 2026-04-23
- Source: Sameer flagged during live QA
- Symptom: after a user accepts a workspace invite (or the server side completes a join — e.g., team admin one-click join, access request approval), the `/w` home doesn't refetch; the newly-joined workspace doesn't appear until a manual page reload
- Likely cause: missing `queryClient.invalidateQueries` on the mutation that completes the join. Candidates to inspect: `useAcceptInvite`, `useRequestAccess`, and whatever drives the team-admin "join workspace" button on `/w`
- I'll verify the exact trigger points during the Invitations & access module tonight and add repro steps here

### [block] Home page `/en-US/w` shows "No workspaces yet" for a user who just completed onboarding — Onboarding · 2026-04-23
- Where: `/en-US/w` (Workspaces home) after finishing onboarding as solo `solo1`
- Expected: One card showing the "Default" workspace under team "Sameer's Team" with an owner chip + pioneer tier badge, per the watch list ("Home page: 2–3 workspaces, pinned, role chip, tier badge")
- Observed: Empty hero: **"Workspaces" / "No workspaces yet. Create your first one to get started."** with no "Create" CTA button visible. Direct URL `/en-US/w/<ws-id>/projects` still works so the workspace *exists*
- Root cause (verified via API + code read):
  - `GET /api/v2/me` returns `orgs: [{name: "Sameer's Team", role: "owner"}]` and `onboarding_completed: true`
  - `GET /api/v2/workspaces` returns `{workspaces: [], teams: []}`
  - Listing logic at `echo/server/dembrane/api/v2/workspaces.py:165-192` queries `workspace_membership` rows for the caller and short-circuits to empty when none exist. The creator's `workspace_membership` row was never written.
  - Why it wasn't written: during my first attempt the 500 bug above crashed after `org`, `org_membership`, and `workspace` rows were already created but before `on_workspace_created` wrote the `workspace_membership`. On retry, the onboarding code at `onboarding.py:279-345` takes the "workspace already exists" branch (line 295-296), skipping the `on_workspace_created` call that lives inside the `else` at line 297-318. Result: partial-state users are permanently stuck.
- Two bugs stacked:
  1. **Onboarding is not idempotent across a partial failure** — if `workspace_membership` was never inserted, a retry silently leaves it missing. Fix candidates: always upsert `workspace_membership` on the existing-workspace branch, or move the membership write out of the `else` into an unconditional block.
  2. **Workspace list short-circuits when orgs exist but memberships don't** — a team-owner with zero `workspace_membership` rows gets an empty `teams: []` response and can't see or reach their team. Fix candidate: fall through to build `teams` from `org_memberships` independently of workspace rows, so at minimum the team rollup renders.
- Screenshot: qa/\_shots/06-home-empty.png
- Also: no visible "Create workspace" button on the empty state, so a user in this broken state can't even create a new one to un-stick themselves

### [rough] Onboarding page layout — illustration feels orphaned, "Use default" is a redundant button — Onboarding · 2026-04-23
- Where: `/en-US/onboarding`
- Observed:
  - Decorative illustration sits in the top-left corner, visually detached from the form card below — large vertical gap between them makes it look like a header that got left behind
  - Form card is left-aligned in a wide viewport — most of the right side and everything below is empty beige space, so the page reads as half-finished rather than minimal
  - "Use default" sits next to "Get started" with near-equal visual weight but it's a no-op when the input is already pre-filled with the default ("Sameer's Team"). It doesn't feel like a real option — feels like a button that does nothing until you've edited the field
- Suggest:
  - Either center the form card and pull the illustration into its header, or put the illustration as a full-width banner / on the opposite side of a 2-col layout
  - Drop "Use default" entirely and show a subtle "Reset" link only after the user has dirtied the input (or just trust the pre-fill and remove the button)
- Screenshot: qa/\_shots/04-onboarding-team-full.png

### [rough] Post-verify redirect drops user at generic login, `?new=true` ignored by UI — Onboarding · 2026-04-23
- Where: `/verify-email?token=…` → redirects to `/en-US/login?new=true`
- Expected: A success banner / heading tailored to the just-verified user ("You're in — log in to continue.") and/or pre-filled email field
- Observed: Same generic "Welcome! / Please login to continue." as any un-verified visitor. The `?new=true` query param is present but the login page reads exactly like the anonymous state — the "Email verified" toast fired on the previous page and died during navigation
- Minor, but first-run polish opportunity: either keep the toast alive across nav, or drive a one-off banner from `?new=true`
- Screenshot: qa/\_shots/02-post-verify-login.png

### [note] `/verify-email` is the only route without an `/en-US/` locale prefix — Onboarding · 2026-04-23
- Where: `http://localhost:5173/verify-email?token=…`
- Everywhere else: `/en-US/login`, `/en-US/register`, `/en-US/w`, `/en-US/request-password-reset`
- Likely intentional so tokens work regardless of the recipient's browser locale, but worth verifying the redirect chain respects their language preference (I landed on English — is that the default or was it inherited?)

### [note] Tab title stays "Register | dembrane" on the "Check your email" screen — Onboarding · 2026-04-23
- Where: `/en-US/register` step 3
- Expected: Title update to something like "Verify your email | dembrane"
- Observed: Title unchanged from step 1/2
- Minor — purely a browser-history / tab-switcher polish issue

