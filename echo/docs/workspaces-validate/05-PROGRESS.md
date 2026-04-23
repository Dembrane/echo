# Progress

Rolling status. Most recent entry on top. Update after every commit or at phase boundaries.

---

## 2026-04-23 — session start

**Branch:** `workspaces` at `cfa758e`. Dirty working tree (see Q4).

**Phase:** A (orient) complete → B (first sync gate with Sameer).

**Shipped this session:**
- `00-DOC-AUDIT.md` — inventory + Repo conventions header
- `02-DELTA.md` — matrix vs code gap pass (all 11 matrix sections + 7 canonical screens + 15 flows)
- `04-QUESTIONS-FOR-SAMEER.md` — 8 pending (Q1–Q8, Q1/Q2/Q3/Q4 blocking)
- `00-PLAN.md` — phase sequence A→G
- `03-DECISIONS.md` — D1–D6
- This file

**Code changes:** none. No commits.

**Blocked on:**
- Sameer first-gate sync (Q1 billing role, Q2 visibility schema, Q3 hour meter, Q4 uncommitted tree)

**Next action on resume:**
- If Sameer has answered Q1–Q4: start Phase C (canonical screen specs).
- If not: nothing useful to do yet; sit.

## 2026-04-23 — Q1–Q8 answered + validation plan approved

**Answers locked into D7–D14** (`03-DECISIONS.md`). Summary:
- Q1 billing role → ship in schema
- Q2 visibility → add enum, drop old booleans + sticky_removed (not in prod)
- Q3 hours → derive from `conversation.duration` via `/v2/workspaces/:id/usage`
- Q4 uncommitted tree → commit as one, exclude doc folders from code commits going forward
- Q5 viewer → remove, no migration, error-handle strays
- Q6 webhooks → gate at changemaker+
- Q7 M1 tool → defer
- Q8 upgrade inbox → `upgrades@dembrane.com` everywhere

**Validation plan** — `06-VALIDATION-PLAN.md`, ledger at `06-AUDIT-LEDGER.md`. Four axes (security / human-first / brand / copy), three cadences (spec / build / phase-boundary).

**Next action on resume:** commit in-flight work per D10 (excluding the two doc folders), then Phase C (canonical screen specs) in parallel with the derivation-walkback flow (D8, prerequisite for flows 1/4/6).

## 2026-04-23 — First build batch shipped

**Commits landed:**
- `bc3310c` — in-flight polish (notifications unification, email templates, auth copy, dead-code sweep of announcements)
- `ec67257` — default upgrade inbox → `upgrades@dembrane.com` (D14)
- `b9c0b48` — backfill script for direct-membership walkback (S0, dry-run default)

**Docs written this batch** (all uncommitted per D10):
- `flows/derivation-walkback.md` — the full S0 backend spec (backfill → resolver simplification → settings purge → new endpoints)
- 7 canonical screen specs: `screens/feature-locked.md`, `status-banner.md`, `request-submitted.md`, `destructive-confirm.md`, `manage-list.md`, `empty-state.md`, `readonly-data.md`
- `06-VALIDATION-PLAN.md` + `06-AUDIT-LEDGER.md`

**Backfill dry-run on dev:** 2 proposed rows across 2 orgs, 2 workspaces (each a "Default" workspace where an org member lacks a direct row). Clean run. Not applied. Production run is deferred per Q7 (deployment thinking later).

**Next batch — in order:**
- #12 Remove `viewer` preset + add `billing` preset (D7, D11) — small, policies.py only
- #10 Schema pass: `workspace.visibility` enum, `workspace:webhooks` policy, billing role literal (D7, D8, D12)
- #13 `/v2/workspaces/:id/usage` — derive hours from `conversation.duration` (D9)
- #14 Pilot hard-block (depends on #10 + #13)

Validation-subagent dispatches: none yet. First full build-time dispatch will land when #13's endpoint is ready (security + design + copy relevant; brand n/a until UI).

## 2026-04-23 — Second build batch shipped

**Commits landed (continuing from first batch):**
- `28ff732` — S6 roles: viewer retired, billing preset added, upgrade:request policy wired, invite + change-role endpoints use member/billing/admin/owner hierarchy. Legacy role normalization at middleware context build.
- `a815f15` — S10a: `workspace.visibility` enum (`open_to_team | private`). First slice of matrix §6. Backfilled from `settings.inherit_team_admins`. Directus snapshot pulled.

**Still open from matrix §6 walkback** (blocked on backfill --apply in prod per Q7 deferred):
- Simplify `inheritance.user_can_access` to direct-only
- Drop `settings.inherit_team_admins / inherit_team_members` flags
- Purge `settings.sticky_removed` tombstones
- Add new endpoints: join / access-requests / approve / reject
- Add notifications: `MEMBERSHIP_REQUESTED`, `MEMBERSHIP_REQUEST_APPROVED` (rejection silent per matrix)

**Next batch:**
- #13 `/v2/workspaces/:id/usage` endpoint (D9) — self-contained, derives from `conversation.duration` with `deleted_at` filter + current-calendar-month bound. Role-differentiated response: raw numbers for members; overage forecast + tier recommendation for admin/billing.
- #14 Pilot hard-block — depends on #13. Read-time check against 10h cap before host-side endpoints. Participant portal exempt. Banner + modal via `screens/status-banner.md`.

**Validation status:** no subagent dispatches this session. Mental review only on the role change (security: no bypass; copy: brand-compliant). For #13 I'll dispatch the full build-time axes (security + design + copy) before committing — new endpoint, new attack surface.

## 2026-04-23 — Third build batch shipped

**Commits landed (continuing):**
- `e734319` — S13: GET `/v2/workspaces/:id/usage` + `tier_capacity` canonical matrix module. Security subagent dispatched on this; four findings (F1 missing view_usage on member preset → fixed; F2 Pilot fallback NULL → fixed; F3 elevated-role guest logging → fixed; F4 billing-as-seat → false positive, kept per matrix §7). Logged in `06-AUDIT-LEDGER.md`.
- `21e666f` — S14: Pilot hard-block. New `require_no_pilot_block(ctx)` FastAPI dep; wired to `POST /v2/workspaces/:id/projects`. Matrix-§8 verbatim 402 copy with participant-reassurance line.

**Validation this batch:** Security subagent on #13 (four findings, three fixed same-commit, one kept). #14 got mental review only — small scope, follows pattern laid down in #13, participant portal untouched.

**Still to wire for full §8 coverage (follow-up):** chat / agentic / transcript-view / report-generate / data-export endpoints — all v1 routes that don't take a `WorkspaceContext`. A `require_no_pilot_block_for(workspace_id)` variant lands with those.

**Session end-state:**
- 7 commits on `workspaces` past `cfa758e`: `bc3310c`, `ec67257`, `b9c0b48`, `28ff732`, `a815f15`, `e734319`, `21e666f`.
- `docs/workspaces-validate/` complete with audit, delta, 7 canonical screens, derivation-walkback flow spec, validation plan, audit ledger, progress, decisions, questions.
- Backfill script dry-runs clean on dev (2 proposals); not applied — stop condition per Q7.

**Blockers that did NOT land:**
- Pilot hard-block on v1 host-side endpoints (chat / agentic / transcript / report / export).
- Derivation walkback resolver simplification + settings purge (deferred to prod-backfill session).
- Request-to-join + team-admin-join endpoints (matrix §6).
- Downgrade confirmation dialog + 7-day banner (matrix §3).
- Honesty disclosure on private-workspace create (matrix §6).
- Workspace creation wizard (S9).
- Settings tab split (flow 8).
- Team admin page expansion to matrix ⇄ list ⇄ projects (S7).
- Frontend wiring for the usage endpoint + Pilot-block UI banner.

These remain release blockers. Next session should pick from this list in dependency order — usage-frontend + downgrade-dialog are tightest coupling to what shipped this session.

## 2026-04-23 — Fourth build batch shipped

**Commits (continuing):**
- `b49c30d` — S3a post-downgrade tracking + email to admin+billing audience (matrix §3). `workspace.downgraded_at` + `downgraded_from_tier` fields; email template `tier_downgraded.{html,txt}`; new `audience_workspace_admins_and_billing` helper.
- `c8fae01` — S6 Slack-style discovery (matrix §6). `access_request` collection + CRUD; `POST /workspaces/:id/join` (team admin self-join); `POST /workspaces/:id/access-requests` (member request); approve + reject (silent rejection); `GET /orgs/:id/discoverable-workspaces`. Notifications `MEMBERSHIP_REQUESTED` / `MEMBERSHIP_REQUEST_APPROVED`.
- `385bf8f` — S14b Pilot hard-block extended to v1 chat + agentic (`POST /api/chat/{id}`, `POST /api/agentic/runs`, `POST /api/agentic/runs/{id}/messages`). New `check_no_pilot_block_for_project` helper.
- `1feb963` — Set `workspace.visibility` on create + honesty disclosure on Private in `CreateWorkspaceRoute.tsx`.

**Session end-state:**
- 11 commits on `workspaces` past `cfa758e`: `bc3310c`, `ec67257`, `b9c0b48`, `28ff732`, `a815f15`, `e734319`, `21e666f`, `b49c30d`, `c8fae01`, `385bf8f`, `1feb963`.
- Schema steps 10 (visibility), 11 (downgrade tracking), 12 (access_request) all applied + snapshot synced.
- Audit ledger has F1–F5 logged; 4 fixed, 1 false-positive.

**Still not landed** (release-relevant):
- Derivation walkback execution (prod backfill → resolver simplification → settings purge) — Q7-deferred.
- Report / export endpoints Pilot-block (S14c follow-up).
- Workspace creation wizard (S9) — single-form + honesty disclosure is tactical minimum.
- Settings tab split (flow 8).
- Team admin 3-view (S7).
- Frontend wiring for: usage endpoint rendering, Pilot-block level-3 modal, 7-day downgrade banner, home discovery section, access-requests list.
- Tier capacity matrix UI surface (billing tab + upgrade modal — backend done via `tier_capacity.py`, frontend TBD).

Backend for matrix §3 + §6 + §8 + §11 is largely in. Frontend is the next big chunk.

## 2026-04-23 — Fifth build batch shipped (same-day continuation)

**Commits (continuing):**
- `c403b8c` — matrix §6 approve/reject guard widened to accept team admins without direct workspace membership; legacy `inherit_team_admins` / `inherit_team_members` writes dropped on create; resolver prefers `workspace.visibility` enum; UI drops retired members-inherit checkbox.
- `c59b681` — matrix §3 downgrade email moved to Dramatiq network-queue actor (`task_send_downgrade_email`). Staff PATCH returns immediately.
- `f90ab7b` — matrix §3 + §8 frontend surfaces: `PilotBlockModal` (level-3 canonical, matrix-§8 verbatim copy + participant-reassurance line); `DowngradeBanner` (7-day, dismissable per-session); global `pilotBlock` signal bus wired through QueryClient MutationCache + QueryCache onError handlers.
- `f1b7e30` — matrix §6 frontend: `DiscoverableWorkspaces` section on the home page (inside each team group); `AccessRequestsList` on workspace settings (pending-only). Closes the discovery → request → approve loop end-to-end.
- `58d462f` — matrix §8 frontend: `UsageCard` on workspace settings. Role-differentiated display (members raw, admin/billing overage forecast + next-tier hint); progress bars with traffic-light colouring; "At limit" / "Approaching limit" badges.

**Backfill run (D1 in audit ledger):** `scripts/backfill_direct_memberships.py --apply` ran on dev Directus. 2 proposals written, re-run `--dry-run` shows 0. Prod execution still pending Q7.

**Session end-state:**
- 18 commits on `workspaces` past `cfa758e`.
- Matrix §3 + §6 + §8 have both backend + first-pass frontend wiring landed.
- Frontend: `WorkspaceLayout` now hosts the banner + modal; `WorkspaceSelectorRoute` shows discovery; `WorkspaceSettingsRoute` shows usage + access-requests.

**Still not landed** (next-session candidates):
- Derivation walkback execution in prod + post-backfill resolver simplification + settings-flag purge — Q7-deferred.
- Report / export endpoint Pilot-block (S14c) — explicitly deprioritised per user "UI should make it clear" direction.
- Workspace creation wizard (S9 multi-step).
- Settings tab split (flow 8) — bigger refactor; usage + access-requests + billing all currently on one page.
- Team admin 3-view (S7) — Ask 1 projects view on /t/:orgId.
- Tier capacity matrix UI (full matrix render; currently only the next-tier hint on UsageCard).

## 2026-04-23 — Sixth build batch shipped (caching + HCD fixes)

**Caching + loop-closing commits:**
- `5de8891` — Redis cache on `/v2/workspaces/:id/usage` (30-min TTL + `?refresh=true`). UI refresh button. Cache busts on tier PATCH. Broken `?tab=billing` anchors dropped across UsageCard / PilotBlockModal / DowngradeBanner.
- `35b1705` — FeatureGate → DowngradeBanner auto-return on frozen-feature-attempt (matrix §3 finally fully honored).

**HCD audit + converged fixes:**
- Four-role audit dispatched in parallel (Admin+TeamAdmin / Member+TeamMember / Billing+TeamBilling / Guest+Staff). Raw findings synthesised in `07-HCD-AUDIT.md` across 15 concerns, clustered into Tier 1 / 2 / 3 fix lists.
- `893be3f` — Tier 1 (pattern + copy): shared `TierBadge` component + `lib/tiers.ts` tagline map (matrix §1 honored on every tier surface); raw policy badges dropped from "Your access"; Privacy & defaults hidden for non-admins; TeamSettings "owners" → "team admins"; TeamRoute derivation footer rewritten per matrix §5/§6; team-level Guests filter + count retired (matrix §5).
- `7139a30` — Tier 2 (action affordances): Request-upgrade button on UsageCard for admin/owner/billing; Leave-workspace button for every role ("Your access" section, with a clear consequence-spelled-out confirm modal + last-admin protection in the backend); Guest chip + UsageCard hidden when is_external=true.

Tier 3 HCD items deferred: Private-radio tier-gating in settings, team-level usage rollup, invoices/payment UI (no backend anyway), staff "global workspaces" route, matrix-cell click routing on TeamRoute, invite-as-guest path, admin chips for members, silent-rejection pending TTL.

**Session totals:** 25 commits past `cfa758e`. Backfill `--apply` complete on dev. All matrix §3 / §6 / §8 / §11 contract items now have both backend + user-visible frontend. HCD audit consumed + most universal concerns closed.

## 2026-04-23 — Seventh build batch (HCD follow-through + matrix §1 surfaces)

**High-impact commits (user asked for "best impact wise"):**
- `e4387e9` — Team-level usage rollup (matrix §8 team-scope). New `GET /v2/orgs/:id/usage` aggregates hours / seats / guests / projects / €-forecast across all team workspaces with 30-min cache + `?refresh=true` + tier-change invalidation. Frontend `TeamUsageRollup` strip at top of `/t/:orgId`. Closes HCD concern #7 (biggest team-admin + team-billing gap).
- `c2c3fb1` — Full tier capacity matrix rendered in-product (matrix §1). New `GET /v2/workspaces/tier-capacities` exposes the canonical TIER_CAPACITIES data. New `TierCapacityMatrix` component renders the full table. Wired into `UpgradeModal`, replacing the pair of single-tier cards with a comparative matrix. Matrix §1 contract item finally honored in the upgrade surface.
- `963fb0b` — HCD tier-3 bundle:
  - Admin chips in FeatureGate member path (HCD #13): "ask a team admin" now renders admin avatars + names fetched from `/v2/orgs/:id/members`.
  - Private tier-gate in both settings + create (HCD #11 / matrix §2): Pioneer admin can no longer click Private and hit a cryptic 403. Disabled option + inline "Available on innovator" hint. Existing-private preserved on downgrade (matrix §3 freeze).
  - Workspace-column dead-clicks on /t/ matrix (HCD #9): non-admins see plain dimmed text instead of anchors that 403.

**Session totals: 28 commits past `cfa758e`.**

**HCD concern closure count:**
- Closed this session: #1 (tier+tagline), #2 (policy badges), #3 (Privacy hidden), #4 (Request upgrade button), #5 (shown-here-but-dead-link), #6 (derivation footer), #7 (team rollup), #8 (owners→admins), #9 (dead clicks), #10 (Guest chip + hide), #11 (Private tier-gate), #13 (admin chips), #14 (Guest role badge shown).
- Still open (tier-3 deferred):
  - #5/#12 Invoices + payment UI (no backend)
  - #12 Staff console (post-release per matrix)
  - #14 Invite-as-guest UI path
  - #15 Silent-rejection pending TTL
  - #16 Settings tab split
  - #17 S7 team admin projects view
  - #18 Workspace creation wizard multi-step

Biggest remaining wins-per-line-of-code: workspace creation wizard + settings tab split (foundation for further role-scoped landing).

## 2026-04-23 — Eighth build batch (settings tab split shipped)

- `79fc727` — Workspace settings Overview / Billing tab split. URL-driven via `?tab=`. Role-based default lands Billing-role on Billing tab, everyone else on Overview. Guest bypasses tabs entirely (matrix §4 exclusions already applied). Full `TierCapacityMatrix` rendered on billing tab with current tier highlighted — matrix §1 now honored on both the upgrade modal AND the billing tab (contract was "at minimum" both surfaces). PilotBlockModal + DowngradeBanner now route to `?tab=billing` since that's where the context lives.

**Session total: 29 commits past `cfa758e`.**

HCD concern #16 (settings tab split) closed. Remaining tier-3 items: workspace creation wizard multi-step (S9), S7 team admin projects view, invite-as-guest path. Staff console + invoices UI remain matrix-deferred (no v1 backend).

## 2026-04-23 — Ninth build batch (seat-count bug + per-workspace breakdown + S7)

**User-triggered debug + continuation:**
- `bdd16dd` — **Seat count dedup fix.** Admin reported seat count showed 5 when they expected fewer. Investigation revealed the count was actually correct (5 distinct workspace-user pairs with seat-worthy roles) but pre-walkback legacy `source='inherited'` rows were co-existing with `source='direct'` rows for the same pair. On one workspace this caused the same user to be counted twice. Fix: dedupe by (workspace_id, user_id) before seat counting, prefer direct over inherited. Applied to both `/v2/workspaces/:id/usage` and `/v2/orgs/:id/usage`. Legacy rows archived on dev via `migrate_inherited_to_derived.py --apply`; invariant #5 restored.
- `5ec8cd4` — **Team matrix direct-role visibility fix.** Matrix was only showing derivation-based access (team owner → admin everywhere; team admin → admin on open workspaces). Direct workspace memberships for non-admin team members were invisible. Fix: extend `OrgMemberResponse` with `direct_workspace_roles: dict[workspace_id, role]` (one batched read per page load). TeamRoute cells prefer the direct role, fall back to derivation, color-code by role.
- `1ff2d5a` — **Per-workspace breakdown on team usage rollup** (user ask). `/v2/orgs/:id/usage` now returns a sorted `workspaces[]` list: at-cap first, then approaching, then hours desc. TeamUsageRollup gains a collapsible table with progress bars + click-through to each workspace's billing tab. Matrix §8 team-scope now concrete for admins — they can spot hot workspaces without guessing.
- `868ffba` — **S7: team admin Projects view.** Matrix §4 wind-down workflow. New `GET /v2/orgs/:id/projects` (admin-only) returns every project across team workspaces with conversation counts. `TeamProjectsTable` with search + workspace filter + per-row delete (confirm modal with conversation-count impact). View toggle on TeamRoute: People ↔ Projects (admin-only).

**Session total: 33 commits past `cfa758e`.**

Matrix §4 delete-workspace workflow now has a proper Admin surface. Team rollups actionable. HCD concern #7 (team admin financial summary) + #17 (S7 projects view) closed.

## 2026-04-23 — Tenth build batch (wizard + invite-as-guest + role chips)

- `da70a10` — **S9 workspace creation wizard.** 3-step Stepper (Name → Access → Review) with back + cancel at each step. Review step's "What each role will experience" list covers you / team admins / team members / guests per matrix §6 Slack-style model. Private radio stays tier-gated (matrix §2 innovator+). Cancel confirms when form has content.
- `81cbb5b` — **Invite-as-guest UI path.** New "Invite as" radio (team member vs guest) above the workspace-role radio. Guest path hides the role picker (hard-rule clamp to member-equivalent per matrix §4). Modal title swaps between "Invite a member" and "Invite a guest". Backend already supported `is_org_member=false` — UI just didn't expose it.
- `31d2963` — **Home cards: role chip + tier badge side-by-side.** Matrix §2 HCD decision: role must be visible on every workspace card alongside tier. Role chip color-coded (Admin/Owner blue, Billing yellow, Member gray). Guests get a single gray "Guest" chip with no tier badge.

**Session total: 36 commits past `cfa758e`.**

HCD concerns #14 (guest identity clarity) + #15 (invite-as-guest path) + #18 (wizard) now closed. Virtually the entire tier-3 HCD list has landed — remaining deferred items are matrix-deferred (invoices/payment/staff console).

## 2026-04-23 — Eleventh build batch (Danger tab + cap-at-a-glance across home)

- `a9f45b7` — **Matrix §4 delete-workspace UI in a Danger tab.** Backend relaxed from owner-only to admin+owner (matrix §4 grants Admin ✓). Red-tinted Paper with two states: if projects exist → "Clear N first" + link to the team projects view (S7); if empty → type-to-confirm input requiring exact workspace name. Completes the matrix §4 admin capability trio (invite / manage / delete).
- `961c72b` — **Team hero health hint.** `/v2/orgs/:id/usage` data inline in each team's hero card on home: hours this cycle, €-forecast (admin/billing only, server-gated), at-limit + approaching badges when any workspace is hot. Admins spot trouble teams at a glance without clicking into /t/.
- `3602536` — **Per-workspace card cap warnings.** WorkspaceUsage schema extended with `hours_included / hours_pct / at_cap / approaching_cap`, populated server-side from tier_capacity. Cards show red "At limit" / yellow "Approaching" badges in the meta row. Matrix §8 cap info now visible at every surface users land on.

**Session total: 39 commits past `cfa758e`.**

At-a-glance cap status is consistent across three tiers: home workspace cards → team hero cards → workspace settings billing tab → team admin /t/ rollup. A user who spends 20 seconds on the app knows exactly which workspace/team is at or approaching a limit.

**Notes for future-me:**
- Brief says `workspaces-release-checklist.md`; actual path is `docs/workspaces/release-checklist.md`.
- Companion design docs live at `docs/workspaces/` (not `docs/workspaces-validate/`).
- The brief's "8 prior commits from the autonomous run (2026-04-20)" is out of date — actual commit count on this branch past `main` is ~29 (see git log in audit). The post-8 commits include S10 UI, S11 FeatureGate, S12 selector polish, audit rounds, inbox implementation, team route, etc.
- `frontend/src/components/inbox/Inbox.tsx` replaces the deleted `NotificationsDrawer.tsx`; confirm the swap is wired in `Header.tsx`.
- Upgrade inbox default is still `sameer@dembrane.com` in `settings.py:340` — matrix says `upgrades@dembrane.com`.
