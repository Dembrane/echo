# Overnight QA summary — 2026-04-23

Scope: ran through the Workspaces validation plan using seed users (Anna, Ben, Cara, Dan, Emma, Finn, Grace, Hank) after Sameer said "keep going." One session. Everything below links to evidence files in this directory.

## Modules walked (each with findings)

| # | Module | Status | Key evidence |
|---|---|---|---|
| 1 | Onboarding — solo register → email verify → first workspace | ✅ walked end-to-end earlier in the day as `solo1`; the hard blocker at `/api/v2/onboarding/complete` is captured in [brief-01-onboarding-fixes.md](brief-01-onboarding-fixes.md) | shots 00–06 |
| 2 | Invitations & access — admin invites all roles | ✅ verified — invites for registered users auto-add, unregistered go to pending | shot 12 |
| 3 | Role changes — promote / demote / remove + last-admin protection | ✅ verified backend rules all hold | shot 15 |
| 4 | Tier gates — pilot-only features, request-upgrade flow | ✅ verified on Access + Usage and Tier tabs; upgrade dialog works | shots 16, 17 |
| 5 | Workspace settings — every tab | ✅ walked General / Members / Access / Usage and Tier / Danger | shots 11, 12, 16, 17, 18 |
| 6 | Team page — Overview, Usage, People | ✅ walked all 3 tabs; Needs Attention panel surfaces all 3 seed-data cap/downgrade conditions correctly | shots 19, 20 |
| 7 | Billing role — login as Emma | ✅ verified what billing sees vs hides; 2 fresh pains | shots 23, 24, 25 |
| 8 | Projects — private project + sharing modal | ✅ walked end-to-end on "Brand Rollout" (Whitelabel Project, Innovator tier) | shots 21, 22 |
| 9 | Multi-team — two teams, grouping, switching | ✅ verified via Hank (owner Alpha Inc + member of Partner Consulting) and Emma (owner Partner Consulting + member Acme Research) | shot 25 |
| 10 | Pilot hour block | ⏸ deferred — needs a dev shortcut to burn hours fast |
| 11 | Participant portal | ⏸ deferred — QR/device flow |
| 12 | Onboarding redo with fresh user | ⏸ deferred — email verification needs Sameer to paste the link |

## Blockers (read first)

All the session-blocking items from the first hour are captured in [brief-01-onboarding-fixes.md](brief-01-onboarding-fixes.md) — that brief is self-contained and meant for a fresh Claude Code to execute. Until it lands, `solo1` stays stuck.

## Top new findings tonight (from [pains.md](pains.md))

These are the ones worth triaging first — they hit flows that are supposed to be the happy path:

1. **`[hurt?]` Inviting an existing user auto-adds them silently — no accept, no consent, no notification to the invitee.** Cara ends up in Anna's workspace with zero signal. Either switch to an accept step for registered users, or fire a `WORKSPACE_MEMBER_ADDED` notification. Need Sameer's call.
2. **`[rough]` Join/members/projects list all suffer from stale cache.** First mount renders old or empty data; a reload fixes it. Saw it on: Cara's first projects page after invite, Members tab before/after Cara was added, Share modal after adding Ben. Common cause = missing `invalidateQueries`. Same family as Sameer's own "joining a ws doesnt refetch" observation.
3. **`[rough]` Billing user sees a broken Projects tab.** Emma lands on `/w/<id>/projects` with "All projects" + "Create" button but empty list. Either redirect billing to `/settings/billing`, or empty-state with copy "Billing accounts don't see projects."
4. **`[rough]` Billing-role workspace card on `/w` has no "Manage" button.** Emma has no one-click path into the one place she needs (Usage and Tier).
5. **`[rough]` Seats 4/3 on Pioneer shown as plain text** with no overage warning on the workspace-level Usage and Tier card. The team-level Usage "Needs Attention" panel catches it, but the workspace card itself is silent.
6. **`[rough]` "Usage and Tier" tab label sits at `/settings/billing`.** Either rename URL segment or rename tab.
7. **`[rough]` Private-project share modal doesn't refresh after Add.** Same refetch family as above. Add succeeded server-side (verified via API) but the dialog still said "Just you, for now."
8. **`[rough]` `include_org_membership` alias not honored by the invite endpoint** despite the schema + docstring claim. Canonical `is_org_member` works; the declared alias silently defaults to `false` and rejects billing invites with a misleading "Guests can't…" message.
9. **`[note]` Team rollup counts "people" differently on Home (7, includes externals) vs Team page (4, team seats only).** Same label, different numbers.

The full pain list is in [pains.md](pains.md), grouped by severity tag (`[block]`, `[hurt]`, `[rough]`, `[note]`).

## Confirmed working

So you don't re-test these tomorrow:

- 3-step register flow on `/register`, email-verify redirect, post-verify login handoff.
- Post-patch (Sameer's devcontainer hot-fix), `POST /api/v2/onboarding/complete` returns 200 and drops the user into their Default workspace.
- Invite flow via the modal from `/settings/members`: all role/external combinations work once you use the canonical `is_org_member` parameter name.
- Role-change hard rules — all verified via API:
  - Promote external → admin → `400` (guest rule)
  - Self-remove last owner → `400`
  - Demote last owner → `400`
  - Demote admin → member → `200`
- Workspace settings role-gated UI:
  - Admin sees 5 tabs (General, Members, Access, Usage and Tier, Danger)
  - Billing sees 3 (General read-only, Members read-only, Usage and Tier full-access including Request Upgrade)
- Private project flow: `Make private` → modal → add workspace-member-only people with `viewer` role. API boundary enforces workspace-scoped sharing.
- Tier gate honesty on Access tab: Pioneer shows "Private" radio disabled with "Available on innovator and above"; team-admins-can-still-find-and-join disclosure present.
- Team → Usage "Needs Attention" panel correctly lists: Q1 Discovery approaching hour cap, Default at seat cap, Whitelabel downgraded recently.
- Multi-team home layout: Emma sees Acme Research + Partner Consulting teams grouped, with correct per-team Manage/Add affordances based on her role.

## Accounts state (for resuming)

See [accounts.md](accounts.md) for the full table. Diff from when you left:
- I used Anna (`anna@seed.dembrane.dev`) extensively for admin flows.
- On the Default workspace (`2cf9fa15-…`), I added Cara (admin), Dan/Finn as externals were already there, Emma (billing-role). I demoted Ben from admin → member. Two pending invites exist: `frank@seed.dembrane.dev` (seed) and `new-person-1@unregistered.example` (my test for pending-invite-for-unregistered-email path).
- On Whitelabel Project (Innovator tier), I made "Brand Rollout" **private** and added Ben as viewer. Revert that if you want a clean seed.
- `solo1` is still in the broken state (no `workspace_membership` row) — see brief-01 for the fix.

## What I'd do next when you're back

1. Apply brief-01 so `solo1` un-sticks and future users don't hit the same partial-write bug.
2. Decide the consent question — silent auto-add vs accept step vs notification-only.
3. Audit React Query invalidations on mutations touching members / projects / workspaces / project_sharing. Three separate pains above are the same root cause.
4. Spend 20 minutes on the Billing role empty-Projects UX — a one-file fix in the Projects route (redirect or empty-state) would unblock a real demo persona.
5. Figure out how I should handle email verification and the pending-invite-accept email for overnight runs. If there's a Mailhog/Mailpit we can wire in, or a dev endpoint that returns the token, I can cover the two deferred modules next run.
