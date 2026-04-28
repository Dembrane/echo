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

### [note] Team page and workspace cards rollup "people" differently — 4 vs 7 — Home vs Team · 2026-04-23
- Where: `/en-US/w` team hero says "7 people", `/en-US/t/<id>/overview` team heading says "4 people"
- Observed: same team Acme Research, two different counts
  - Home rollup `teams[].total_members` = count of unique user_ids across all workspaces including externals (7: Anna, Ben, Cara, Dan, Emma, Finn, Grace)
  - Team page count = team members only, excluding externals (4: Anna, Ben, Cara, Emma)
- Both are useful numbers but using the same label ("people") in both places is confusing. Suggest: home rollup should clarify "7 total" or "4 teammates + 3 guests", or both pages should agree on a definition

### [rough] Billing user sees a Projects tab with "Create" button but no projects and no explanation — Billing role · 2026-04-23
- Where: as Emma (workspace role = billing on Default), visiting `/en-US/w/<ws-id>/projects`
- Observed: renders "All projects" heading + "Create" button + search box, with an empty list — **no projects are shown** (Default has 2 projects)
- Expected per matrix: billing "sees usage, invoices, and payment. Doesn't touch projects." — so either
  - (a) hide the Projects route entirely for billing and redirect them to `/settings/billing` (Usage and Tier), OR
  - (b) if the route must exist, show a friendly empty-state: "Billing accounts don't see projects. Head to Usage and Tier for invoices." and hide the Create button
- Current state is the worst of both: they see a tab that offers nothing + a Create button that will 403 them
- Screenshot: qa/\_shots/23-emma-billing-projects.png

### [rough] Billing-role workspace card on `/w` has no "Manage" affordance — Billing role · 2026-04-23
- Where: Emma's `/en-US/w` home. The Default card (where Emma is billing) has initials + stats but **no "Manage" button**, while Client Beta / Client Alpha (where she's admin) DO show "Manage"
- Result: Emma can't click into Default's Usage and Tier tab from the home grid — she has to remember the direct URL `/settings/billing`. This undermines the point of a billing user who's there specifically to see usage.
- Fix candidates: keep Manage visible but route it to `/settings/billing` (billing's read-only landing tab) instead of `/settings/general`.
- Screenshot: qa/\_shots/25-emma-home.png

### [note] Billing user's workspace-settings surface is correctly gated — Billing role · 2026-04-23
- Where: `/en-US/w/<id>/settings` as Emma (billing)
- Observed correctly:
  - Only 3 tabs: General, Members, Usage and Tier. Access + Danger are hidden.
  - General: read-only with "Only workspace admins can change these settings. Ask an admin if something needs updating."
  - Members: can see the list but no "Invite member" button, no role dropdowns, no "Remove member" controls. Has "Leave workspace" under "Your access".
  - Usage and Tier: full view including "Request upgrade" button (matches `upgrade:request` policy on billing role).
- Screenshot: qa/\_shots/24-emma-billing-members.png

### [rough] Private-project "Who can see this project?" modal doesn't refetch after Add — Projects · 2026-04-23
- Where: Project Settings → `Make private` → modal "Who can see this project?"
- Repro:
  1. On Whitelabel Project (Innovator tier), open "Brand Rollout" → Project Settings → Make private → toast "Private. Add people to share it."
  2. Modal re-opens with "Just you, for now." + email field + role "can read"
  3. Type `ben@seed.dembrane.dev`, click Add
  4. Server returns 200 (verified via `/api/v2/projects/<id>/members` listing — Ben is present with role `viewer`)
  5. Modal still shows "Just you, for now." and the email field retains `ben@seed.dembrane.dev`. No refresh.
- Impact: user thinks Add failed, tries again → gets "already shared" error, looks broken
- Same refetch family as earlier bugs — likely missing `invalidateQueries` on the sharing mutation

### [note] Project sharing uses `viewer` / `editor` enum, UI shows "can read" / "can edit" — Projects · 2026-04-23
- Where: `POST /api/v2/projects/<id>/members`
- API enforces `role: Literal["viewer","editor"]`. UI dropdown label is "can read" (mapping to viewer, presumably). Not a bug, just noting the internal-vs-display divergence for future debugging.

### [note] Project sharing scoped to workspace members only — good boundary — Projects · 2026-04-23
- Where: sharing modal copy reads: "Only people already in this workspace can be added. Invite them to the workspace first if they aren't here yet."
- Matches the matrix model — you can't share a private project with a stranger, they must be workspace members first. Boundary enforced by API too.

### [note] Team page Usage panel is the right home for cap warnings — Team · 2026-04-23
- Where: `/en-US/t/<id>/usage` has a "NEEDS ATTENTION" panel with live entries: "Q1 Discovery near pioneer hour limit (22.2/25h) [Review]", "Default at seat cap (4/3) [Upgrade]", "Whitelabel Project was downgraded recently — verify limits [Review]"
- This answers the earlier pain about missing cap/downgrade indicators on home workspace cards — the info isn't missing, it just lives at team level. But the home still offers no breadcrumb to it. Suggest a small "3 issues" badge on the team hero card linking to `/t/<id>/usage`
- Screenshot: qa/\_shots/19-team-usage.png

### [rough] Workspace cards don't surface "approaching cap" or "downgraded" state — Home / Workspaces list · 2026-04-23
- Where: `/en-US/w` workspace cards
- Observed: Anna's seed team "Acme Research" has:
  - **Q1 Discovery**: 22.2/25 hrs (88.8%) — API returns `approaching_cap: true`, `hours_pct: 0.888` — card shows "22.2 h total" but no visual warning chip/bar/color
  - **Whitelabel Project**: `downgraded_from_tier: "changemaker"`, current `tier: "innovator"`, `downgraded_at: "2026-04-20T14:00:07.186Z"` — card shows "Innovator" tier label but nothing indicates it was recently downgraded (user lost changemaker features)
- Expected per matrix §8 / §9: visual signal on cards that are near caps or just-downgraded so users know before they try to record
- Screenshot: qa/\_shots/10-anna-home.png
- Not sure what's intended spec — flag for Sameer's design call. Could be: subtle chip ("Near cap", "Downgraded"), or a different border color, or a footnote on the card

### [rough] Avatar initials — `AN` shown instead of `AB` for Anna Bakker — Home · 2026-04-23
- Confirmation of the brief-01 change #2 bug I already filed for `SA` vs `SS`. Same code path (`UserAvatar.tsx:17`).
- Anna's display_name = "Anna Bakker", avatar initials render as "AN" (= first_name.slice(0,2))

### [rough] Search bar shown always on `/w`, even with 1-2 workspaces — Home · 2026-04-23
- Where: `/en-US/w` above the workspace cards
- Observed: `Search workspaces...` textbox is rendered unconditionally
- Minor: if `workspace_count <= ~4`, the search bar is noise. Some apps hide it until a threshold. Not sure this is worth fixing.

### [rough] Invitee sees stale/empty Projects page on first load right after being added — Invitations & access · 2026-04-23
- Where: logging in as a just-added invitee (Cara), landing on `/en-US/w/<ws-id>/projects`
- Observed: first render shows the fresh-workspace empty-state hero: "Your workspace is ready. Projects are where conversations happen — create your first one to get started." A page reload then correctly shows the 2 existing projects ("Kickoff Interviews" + "P2 f")
- Likely cause: same stale-cache family as the Members tab bug — on first mount the Projects query returns cached empty (or some default) data, then doesn't refetch until navigation/reload
- Repro:
  1. As Anna, invite Cara as admin on Default (auto-adds because she's registered)
  2. Log out, log in as Cara
  3. Cara lands on Default's Projects page — empty hero, not the real projects
  4. Reload — projects appear
- Screenshot: qa/\_shots/13-cara-lands-empty.png (first render), and the snapshot after reload shows the real state
- Impact: Every new user experiences a false "nothing here" moment on their first post-invite login. They may click "Create project" thinking they have nothing, and create duplicates.

### [rough] Invitee receives no personal notification when added — Invitations & access · 2026-04-23
- Where: `/api/v2/me/notifications` after being auto-added as an invitee
- Observed: Cara's `/api/v2/me/notifications` returns `[]` and `unread-count` returns `{"unread":0}` after Anna added her as admin to Default. No email equivalent checked. Cara's inbox badge shows "1" but that's an **announcement** (the "What's new in dembrane" release post), not a personal notification.
- Related pain: the `[hurt?]` about silent auto-add above. If the current product decision is "auto-accept for registered users", the absence of a personal notification makes that decision worse — the user has no breadcrumb back to "how did I get into this workspace?"
- Suggest: fire an in-app notification `TEAM_MEMBER_ADDED` / `WORKSPACE_MEMBER_ADDED` to the invitee (similar to `INVITE_ACCEPTED` that's sent to the inviter per `onboarding.py:166`). Use the same `action: NAVIGATE_WORKSPACE_SETTINGS` pattern

### [note] `/me.orgs` doesn't include orgs reached via `is_external=false` workspace memberships — Invitations & access · 2026-04-23
- Where: `GET /api/v2/me` for user `hank@seed.dembrane.dev`
- Observed: Hank's `me.orgs` returns only `[{name: "Alpha Inc", role: "owner"}]`. But `/api/v2/workspaces` returns a workspace `Client Beta` in org `Partner Consulting` with `is_external: false` on Hank's membership — meaning he IS a team member of Partner Consulting per the workspace row, yet that org is absent from `/me.orgs`
- Reading the schema: `is_external: false` seems to imply org_membership exists, but in this seed there's no `org_membership` row for Hank in Partner Consulting. Either (a) the seed data is inconsistent, (b) the schema treats `is_external: false` as "implicitly an org member" without requiring the row, or (c) the `/me` endpoint is missing a backfill query
- Need Sameer to confirm the intended invariant between `workspace_membership.is_external` and `org_membership`

### [note] Multi-team home `/w`: "Add workspace" button under a team where the user isn't a team admin — Invitations & access · 2026-04-23
- Where: `/en-US/w` as user Hank (workspace admin of Client Beta in Partner Consulting, but **not a team admin of Partner Consulting**)
- Observed: The Partner Consulting section on Hank's `/w` shows his one accessible workspace card plus an **"Add workspace"** dotted card alongside it
- Expected: A non-team-admin shouldn't see the "Add workspace" affordance for that team. They can only add workspaces under teams they admin (e.g., Hank's own Alpha Inc team)
- Could also be: server rejects the create anyway (TypeError 403), so the UI is optimistic. Either way UX is misleading — they see an action they can't actually do
- Haven't tested the POST yet to see if the server actually accepts it

### [rough] `include_org_membership` alias not honored by the invite endpoint — Invitations & access · 2026-04-23
- Where: `POST /api/v2/workspaces/<ws-id>/invite`
- Schema (`echo/server/dembrane/api/v2/schemas.py:154-172`) declares `is_org_member` with `validation_alias=AliasChoices("is_org_member", "include_org_membership")` and a docstring saying it takes either name. Comment even says that was added "because the 'Guests can't be …' error was the root cause of testing the billing role"
- Observed: posting `{"email": "...", "role": "billing", "include_org_membership": true}` is rejected with `400 "Guests can't be admins, owners, or billing. Invite them as a team member first, or choose member."` — as if `is_org_member` defaulted to `false`
- With canonical `is_org_member: true` the same request succeeds (`status: "added"`)
- Either the dev server wasn't restarted after the schema change, or Pydantic's `populate_by_name=True` + `AliasChoices` doesn't actually map `include_org_membership` on incoming requests. The frontend probably uses the canonical name and is unaffected — so the bug only bites API-direct callers and anyone writing a doc that follows the DB column name
- Easy verification: try both names against a fresh server boot. If the alias fails, either fix the schema or drop the dual-name promise from the docstring.
- Note: the UI invite modal correctly uses `is_org_member` and works end-to-end for all role choices including billing (verified by creating Emma).

### [rough] "Usage and Tier" tab label doesn't match its URL segment `/settings/billing` — Workspace settings · 2026-04-23
- Where: `/en-US/w/<ws>/settings/billing` route, but the tab shows "Usage and Tier"
- Inconsistency: the label was moved away from "Billing" (likely because true billing = team-level now), but the URL stayed on the old `/billing` segment. Either rename the URL segment to `usage-and-tier` / `tier` and redirect old one, or rename the tab back to "Billing"
- Screenshot: qa/\_shots/17-ws-usage-tier.png

### [rough] Seats 4/3 on Pioneer shown as plain text with no overage signal — Workspace settings · Usage and Tier · 2026-04-23
- Where: `/en-US/w/<ws>/settings/billing` on Anna's Default workspace
- Observed: the Seats metric renders as "4 / 3" in the same style as any other stat — same color, no chip, no warning icon. A reasonable admin wouldn't notice that 4 > 3 until they read both numbers
- Expected: over-cap metric should be visually loud — red/warn color, a "+€25/mo" chip, or a sentence like "1 seat over your plan — billed at +€25/mo"
- Also: the "How seats work" explainer mentions overage pricing for the matrix below, but the **card itself** doesn't tie the current overage to the money being added. Without that link the seat breach feels like a typo, not a billing event.
- Screenshot: qa/\_shots/17-ws-usage-tier.png

### [note] Access tab's Private radio is correctly gated by tier — Workspace settings · Access · 2026-04-23
- Where: `/en-US/w/<ws>/settings/access`
- On Pioneer: "Private" radio is disabled with the hint "Available on innovator and above." No separate "Request upgrade" button on this tab (the upgrade path lives on Usage and Tier). Copy is honest: "Only invited participants. Team admins can still find and join." — matches the matrix-honesty rule.
- Screenshot: qa/\_shots/16-ws-access.png

### [note] Role protection rules verified working — Role changes · 2026-04-23
All tested via `PATCH /api/v2/workspaces/<id>/members/<membership_id>` as Anna (owner):
- Promote external → admin: `400 "Guests can't be admins, owners, or billing. Add them to the team first (via invite with is_org_member=true), then promote."` ✓
- Self-remove last owner: `400 "Cannot remove the last owner. Transfer ownership first."` ✓
- Self-demote last owner: `400 "Cannot demote the last owner. Promote someone else first."` ✓
- Demote another admin → member: `200 success`, WORKSPACE_REMOVED / role-change notification emitted per code
- Invite billing role + team seat: `200 "added"` (after fixing the alias issue above)

The backend rule set is in good shape. UI-side, the role dropdown didn't trigger a confirmation dialog on demote admin→member — if matrix v1.1 §4 expects confirmation for that change, it's missing. If only *cross-team* role changes need confirmation, this is fine as-is (need Sameer's call).

### [rough] Members list may be stale until full navigation — Invitations & access · 2026-04-23
- Where: `/en-US/w/<ws-id>/settings/members`
- Observed:
  1. First visit to Default's Members tab showed "3 members · 1 pending" with Anna, Grace, Ben visible
  2. Invited Cara via modal → UI optimistically showed "4 members · 1 pending" with Cara appended
  3. After re-login and re-navigating to same tab, the list now shows **6 members · 2 pending** — Dan Eriksen and Finn Garcia are ALSO in the workspace (both `is_external: true`, `role: member`, `source: "direct"`) but were invisible in the initial render
  4. `/api/v2/workspaces/<id>/settings` consistently returns all 6 members across both views
- Likely cause: the React Query key for members-on-this-tab isn't being invalidated/refetched when the tab mounts, so the first render uses a cached partial list from a prior state. Only after a full-page navigation (re-login) does it show the truth.
- Related to Sameer's top-level "joining a workspace doesn't refetch" bug — same family of stale-cache issues

### [hurt?] Inviting an existing user adds them silently — no accept step, no consent — Invitations & access · 2026-04-23
- Where: `POST /api/v2/workspaces/<ws-id>/invite` from the Members tab → "Invite a member" modal
- Repro:
  1. Log in as `anna@seed.dembrane.dev` (admin of "Default" workspace)
  2. Click "Invite member", enter `cara@seed.dembrane.dev`, pick "Member" + Workspace role "Admin", "Send invite"
- Observed:
  - Cara is a pre-registered user. Toast reads "Member added" (not "Invite sent"). She's appended directly to the Members list with role Admin, member count jumps from 3 → 4. No `Pending invites` row is created.
  - Cara receives no notification and no email — she just *is* in Anna's workspace next time she logs in
- Expected (open question for Sameer):
  - Either: send an invite, let Cara explicitly accept (standard SaaS model — GitHub org invites work this way)
  - Or: auto-add is fine, but at minimum surface a notification to Cara so she knows ("Anna Bakker added you to Default in Acme Research")
  - Current state: silent auto-add with zero signal to the invitee feels like [hurt] (workspace additions without consent could expose shared info they didn't opt into). Asking Sameer to weigh in.
- Matrix implications: the distinction in the modal is "Member (gets a team seat)" vs "External (workspace-only)". The team-seat variant definitely implies consumption of the org's plan seats — so the inviter commits budget on Cara's behalf without Cara approving.
- Need Sameer's call on intended UX

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

