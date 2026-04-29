# Delta — matrix v1.1 vs code + checklist

Gap pass over every section of `matrix.md`, each canonical screen pattern, and each flow. **Status key:**

- `✅ built` — code matches matrix; no action
- `⚠️ partial` — code exists but diverges from matrix in a specific way
- `❌ missing` — not in code yet
- `🧹 walkback` — in code today but matrix v1.1 says remove

Code pointers are to `workspaces` branch `cfa758e`. Checklist refers to `docs/workspaces/release-checklist.md`.

---

## Matrix §1 — Tier × capacity

| Row | Status | Notes |
|---|---|---|
| Tier names (pilot→guardian) | ✅ built | `policies.py:17` |
| Per-tier taglines ("Pilot — one month to try it", etc.) | ❌ missing | Brief requires every tier-name surface to pair a tagline. Needs a central i18n table. |
| Price display | ❌ missing | Matrix specifies €349 / €200 / €500 / €1500 / €5000. Not surfaced in product. Needs a single source for matrix + modal. |
| Seat overage rates | ❌ missing | €25 / €30 / €60 per seat. Not in code. |
| Included hours | ❌ missing | 10 / 25 / 50 / 100. Not tracked (no usage meter enforcing hour cap). |
| Hour overage rates | ❌ missing | €5 / €4 / €3. Not surfaced. |
| Guest cap | ❌ missing | 2 / 5 / 20 / 50 / unlimited. Not enforced. |
| Training included | ❌ missing | Informational only — surface in upgrade modal copy. |
| Capacity matrix visible on billing tab + upgrade modal | ❌ missing | Brief: "must be visible on the workspace billing tab AND in the upgrade-request modal." S8 not built. |

## Matrix §2 — Tier × feature

Most tier gates live via `TIER_REQUIRED_FOR_POLICY` in `policies.py`. Comparison:

| Matrix feature gate | Code policy | Tier in code | Match? |
|---|---|---|---|
| Private projects (✓ innovator+) | `project:set_private` | `innovator` | ✅ |
| Private workspaces (✓ innovator+) | `workspace:set_private` | `innovator` | ✅ |
| Data export (✓ innovator+) | `workspace:export` | `innovator` | ✅ |
| Private project sharing (✓ innovator+) | `project:share` | `innovator` | ✅ |
| Whitelabel (✓ changemaker+) | `workspace:whitelabel` | `changemaker` | ✅ |
| API access (✓ changemaker+) | `workspace:api_access` | `changemaker` | ✅ |
| Webhooks (✓ changemaker+) | *no policy* | open | ❌ missing — matrix says changemaker+; needs new policy + gate |
| All 7 languages (open to all) | n/a | n/a | ✅ open |
| Agentic chat (open to all) | `chat:use` | pilot | ✅ |
| Library/analysis views (invite-gated) | n/a | n/a | ✅ open |
| Projects/conversations/chat/reports core | various | pilot | ✅ |

## Matrix §3 — Downgrade behavior

| Row | Status | Notes |
|---|---|---|
| Freeze-by-default, revert for whitelabel | ⚠️ partial | `tier_downgrade.py` implements map + `apply_downgrade_effects()`. Whitelabel revert branch lives there. Needs verification each gate (API, private) freezes correctly. |
| Confirmation dialog listing frozen + reverted features | ❌ missing | S8 UI work. Backend has `preview_downgrade()` per autonomous-run notes. |
| In-workspace banner for 7 days post-downgrade | ❌ missing | New requirement — persists in `workspace.settings` with dismissal tracking + auto-return-on-frozen-feature-attempt. |
| Post-downgrade email to admins + billing | ⚠️ partial | Notification `TIER_DOWNGRADED` exists in severity map, emit site TBD; no email template. |

## Matrix §4 — Role × capability

**Conflict with code — needs decision.** Matrix: `Admin / Billing / Member / Guest`. Code: `owner / admin / member / viewer` (+ `is_external` for Guest).

| Matrix role | Code analog | Gap |
|---|---|---|
| Admin | `owner` ∪ `admin` in code | Matrix collapses to one role. Code has two tiers; ~all admin-only capabilities are already given to `admin` preset except `workspace:delete` + `*`-wildcards → `owner` only. |
| Billing | — | **Not in code.** Needs either a new preset + DB value OR a flag. |
| Member | `member` | ✅ match |
| Guest | `is_external=true` + `member` role | Matrix says guest permissions are identical to member within their workspaces. Code already mirrors member preset when external. Verify: currently no separate preset, so externals get the same `WORKSPACE_ROLE_PRESETS[role]`. Project `delete conversations` flag differs per matrix (guest can't delete, member can) — partially matches since externals aren't blocked from `conversation:delete`. Needs audit. |
| `viewer` in code | no matrix equivalent | Matrix drops viewer. Used anywhere in prod? Checklist lists it. Decide whether to collapse. |

Key mismatches vs matrix §4 role table:
- **Matrix: Member can delete projects = ✗; code: `member` preset *lacks* `project:delete`** → ✅ already aligned (good).
- **Matrix: Billing can update payment method, see invoices, request upgrade** — zero of these exist in code.
- **Matrix: Guest cannot delete conversations** — code has `conversation:delete` in `member` preset; externals run member preset ⇒ ⚠️ mis-gated.
- **Matrix: Last admin cannot demote self or be removed.** Partial enforcement in code (`workspace_settings.py` has some guards) but not audited end-to-end for the collapsed role model. Per brief stop condition.

## Matrix §5 — Organisation-level roles

| Row | Status | Notes |
|---|---|---|
| Organisation Admin / Organisation Billing / Organisation Member | ⚠️ partial | Code has `org` table with `owner / admin / member`. Matrix collapses `owner → admin` at organisation level and adds `billing`. |
| **Organisation-level access is direct-only. No derivation.** | 🧹 walkback | Current code derives organisation-admin access to all open workspaces via `inheritance.py`. Matrix retires this. Backfill + drop `inherit_organisation_admins`. |
| Being organisation admin does not auto-admin every workspace | 🧹 walkback | Same as above. |
| Last-admin protection at organisation + workspace | ⚠️ partial | Workspace has partial guard; organisation-level not confirmed. Audit. |
| "View every workspace in organisation (open + private)" for organisation admin | ⚠️ partial | Today: organisation admin *auto-has* access. Matrix: organisation admin can *discover + join*, but join is an explicit action. |

## Matrix §6 — Workspace visibility & discovery (Slack-style)

This is the single biggest backend walkback.

| Row | Status | Notes |
|---|---|---|
| `workspace.visibility` enum (`open_to_organisation | private`) | ❌ missing (as single enum) | Today modelled as two booleans (`inherit_organisation_admins`, `inherit_organisation_members`). Decide: rename schema, or map UI to existing booleans. |
| UI labels "Open to organisation" / "Private" | ❌ missing | Copy + chip. |
| Organisation admin sees all (open + private) + "Join" CTA | 🧹 walkback → rebuild | Currently *auto-has*. Matrix: explicit Join → writes `source='direct', role='admin'`. |
| Organisation billing sees all (view-only, no join) | ❌ missing | No billing role. |
| Organisation member sees open only + "Request access" | ❌ missing | Need new flow: request → admin approval → write direct row. |
| Guest — no discovery | ✅ built | Externals have no org membership; no derivation reaches them. |
| Honesty disclosure on private creation | ❌ missing | Create wizard must show "Organisation admins can still discover and join this workspace." |
| Request-to-join approval | ❌ missing | Needs new endpoint + notification audience (workspace admins + organisation admins) + approve/reject flow. |
| Organisation admin "Join" immediate, reversible | ❌ missing | New endpoint; writes direct row on click. |
| Sticky removal retired | 🧹 walkback | `workspace.settings.sticky_removed` in code; purge as part of walk-back. |
| Default visibility = `open_to_organisation` | ✅ built | Default in code is `inherit_organisation_admins=true`. |

**Subtasks for walkback** (ordered):

1. Add `workspace.visibility` enum (Directus schema via `create_schema.py`) OR redefine: use `settings.inherit_organisation_admins` as the visibility bit (private=false). Recommend the former for clarity.
2. Backfill: for every user whose current access depends on `user_can_access` derivation, write an explicit `source='direct'` `workspace_membership` row with the derived role. Dry-run + show Sameer row count before apply (stop condition).
3. Simplify `user_can_access` to direct-row lookup only. Remove organisation-admin / organisation-member derivation branches.
4. Remove the `sticky_removed` tombstone logic (read + write sites in `workspace_settings.py` member removal path).
5. Add endpoints: `POST /v2/workspaces/:id/join` (organisation admin self-join), `POST /v2/workspaces/:id/access-requests` (organisation member request), `POST /v2/workspaces/:id/access-requests/:id/approve|reject`.
6. Add notification events: `MEMBERSHIP_REQUESTED`, `MEMBERSHIP_REQUEST_APPROVED`, `MEMBERSHIP_REQUEST_REJECTED`.
7. Update `policies.py`: retire `workspace:set_private` policy name → migrate to `workspace:set_visibility` (or keep; UI only flips enum).
8. Remove `on_organisation_member_removed` / `on_external_became_internal` / `on_internal_became_external` helpers or simplify — direct rows don't need reconciliation hooks.

## Matrix §7 — Seats & billing

| Row | Status | Notes |
|---|---|---|
| Seat = active workspace access (member/admin/billing) | ❌ missing | No seat counter. `workspace_membership` rows exist; count is easy but no billing surface exists. |
| Guests not billed, count against guest cap | ❌ missing | Guest cap not enforced. |
| Organisation membership alone is not billable | ✅ implicit | No billing on organisations. |

## Matrix §8 — Hours & usage

| Row | Status | Notes |
|---|---|---|
| Hour meter per workspace | ❌ missing | No hour counter. Checklist §Schema Session 2 shows `usage_event` was intentionally removed. Matrix requires it back in some form. |
| Calendar-month reset | ❌ missing | — |
| Overage billing per tier | ❌ missing | — |
| **Pilot hard block at 10h — host-side only** | ❌ missing | Core blocker. Blocks chat/analysis/transcripts/reports/exports/new-project creation. Participant portal exempt. |
| Usage rollups — project/workspace/organisation levels | ❌ missing | Flow `usage-rollup` — no backend surface. `WorkspaceSelectorRoute.tsx` shows `usage.audio_hours` per workspace; source TBD. |
| Raw numbers for members; €-forecasts for admin+billing | ❌ missing | Design decision; depends on above. |

## Matrix §9 — New workspace defaults

| Row | Status | Notes |
|---|---|---|
| Default tier = pilot | ⚠️ partial | Needs verification in `POST /v2/workspaces`. Checklist decision says pilot is new-customer-only; existing migrates to Pioneer minimum (M1). |
| Default visibility = open_to_organisation | ✅ built | |
| Creator gets `source='direct', role='owner'` | ✅ built | Audit fix `15c7d1a` ensures this. Matrix says `role='admin'` (collapsed). Role-rename scope. |
| No other rows on create | ✅ built (after 94cf40d + audit passes) | Inheritance retired the fan-out already. |
| Seeded workspaces bypass Pilot default | ❌ missing | Migration tooling (M1). |

## Matrix §10 — Partner-client model

| Row | Status | Notes |
|---|---|---|
| `billed_to_team_id` on workspace | ❌ missing | Schema add. |
| `effective_client_team_id` on workspace (nullable) | ❌ missing | Schema add. |
| Handoff flow: partner initiate → client accept → billing flip | ❌ missing | New endpoints + notifications. |
| Workspace stays at current tier on transfer | ⚠️ implicit | Will be ✅ once handoff ships without tier mutation. |
| `referral_ledger` collection | ❌ missing | Schema add. Fields per matrix: id, workspace_id, partner_team_id, partner_kickback_percent (default 20), starts_at, expires_at (nullable), notes, created_by_staff_id. |
| Partner retains no operational access unless retained as guest | ✅ implicit | Depends on membership not being auto-created on handoff. |

## Matrix §11 — Upgrade flow

| Row | Status | Notes |
|---|---|---|
| Requesters = admin or billing | ⚠️ partial | Code admin-only (`workspaces.py:702` emit). Add billing role first. |
| `staff:can_set_tier` policy | ❌ missing | New policy. Today `PATCH /v2/workspaces/:id/tier` is gated on `auth.is_admin`. Narrow it. |
| `POST /v2/workspaces/:id/upgrade-request` | ✅ built | `workspaces.py:627+`. |
| Upgrade inbox `upgrades@dembrane.com` | ⚠️ default wrong | Currently `sameer@dembrane.com`. Change default + create shared inbox. |
| Capacity matrix in upgrade modal | ❌ missing | Surface work. |
| Member CTA = "Ask one of your organisation admins to upgrade" (no button) | ⚠️ partial | FeatureGate exists; confirm member variant matches. |

---

## Canonical screen patterns (brief §"The 7 canonical screen patterns")

| # | Pattern | Status |
|---|---|---|
| 1 | Manage entity list + edit | ⚠️ partial — settings pages exist but not templated; no shared pattern file yet |
| 2 | Feature locked (role-aware) — hatched overlay + modal | ⚠️ partial — `FeatureGate.tsx` + `UpgradeModal` exist (S11). Confirm role-aware copy per matrix §11. |
| 3 | First encounter / empty state | ⚠️ partial — empty states exist ad-hoc; no shared pattern |
| 4 | Request submitted — waiting (request-to-join, upgrade) | ❌ missing |
| 5 | Confirm destructive action | ⚠️ partial — delete-workspace confirmation exists; type-to-confirm for deletion TBD |
| 6 | Status banner (3 intrusion levels) | ❌ missing — no inline/banner/modal shared component for quota states |
| 7 | Read-only data view (usage rollup, referral ledger, member list, audit log) | ⚠️ partial — organisation page matrix is close; no usage-rollup, no ledger, no audit log |

Write specs for all 7 in `screens/` before instantiating flows.

---

## Flow list (brief priority order)

| # | Flow | Status | Notes |
|---|---|---|---|
| 0 | derivation-walkback | ❌ missing | **Backend work. Prerequisite for 1, 4, 6.** Backfill = stop condition. |
| 1 | upgrade-request | ⚠️ partial | Backend + FeatureGate exist. Missing: participant-reassurance copy, tier capacity matrix in modal, pilot hard-block surfacing. |
| 2 | onboarding-invited | ⚠️ partial | `OnboardingRoute.tsx` handles invite path. Verify workspace-guest variant. |
| 3 | onboarding-solo | ⚠️ partial | Checklist "new user path" deferred — auto-create organisation + Pilot workspace on signup. |
| 4 | home-per-organisation | ⚠️ partial | `WorkspaceSelectorRoute.tsx` has organisation hero + workspace cards + guest section (S12 done). Missing: discovery section per matrix §6, request-access CTA. |
| 5 | usage-rollup | ❌ missing | Core blocker — requires hour meter (see §8). |
| 6 | invite-and-join | ✅ built | HMAC invite + accept flow exists. Confirm billing role variant. |
| 7 | workspace-creation (S9) | ❌ missing | Multi-step wizard not built. `CreateWorkspaceRoute.tsx` is single-step. |
| 8 | admin-workspace-settings (S12 settings tab split) | ⚠️ partial | 893-line one-page file. Needs General / Members / Access / Billing / Danger split + downgrade confirmation + tier matrix on billing tab. |
| 9 | admin-organisation-settings (S7) | ⚠️ partial | `OrganisationRoute.tsx` matrix view exists. Missing: list ⇄ matrix ⇄ projects 3-view switcher + bulk project delete. |
| 10 | role-change-flow | ⚠️ partial | Notifications emit (`WORKSPACE_ROLE_CHANGED`, `ORGANISATION_ROLE_CHANGED`). Missing: downgrade banner + admin-summary email. |
| 11 | tier-gated-click | ✅ built | Via FeatureGate. |
| 12 | private-project-sharing (S10) | ✅ built | Backend + UI shipped (`001ef0a`, `a85d2fe`). |
| 13 | guest-experience | ⚠️ partial | Externals are correctly scoped today; need audit pass. |
| 14 | billing-role-flow | ❌ missing | Needs billing role first. |
| 15 | referral-ledger-view | ❌ missing | Schema + partner-portal view + staff edit. |

---

## Matrix-defined additions that are NOT in the checklist at all

These are matrix requirements the checklist doesn't yet track — raise in first sync.

- Per-tier taglines on every tier surface
- Tier capacity matrix rendered inside product (billing tab + upgrade modal)
- Billing role (schema, policies, preset, UI chip, organisation-level too)
- Slack-style discovery (retire derivation, add join + request-access endpoints)
- `workspace.visibility` enum migration (schema)
- Honesty disclosure on private creation
- Downgrade confirmation dialog listing every frozen/reverted feature
- 7-day in-workspace downgrade banner (auto-return on frozen-feature-attempt)
- Post-downgrade admin email
- Hour meter + calendar-month reset + Pilot hard-block
- Guest cap enforcement per tier
- Usage rollups at project / workspace / organisation with role-differentiated views
- `referral_ledger` schema + partner view
- `billed_to_team_id` / `effective_client_team_id` schema + handoff flow
- `staff:can_set_tier` policy
- Upgrade inbox switch to `upgrades@dembrane.com`
- Migration CSV tool (M1)
- Member raw-usage visibility + admin/billing €-forecast differentiation

---

## Matrix-invariant items explicitly deferred

Per brief — do not build this session:
- Invite reminder cron
- Trash/restore UI (post-release)
- `usage_event` reinstatement ← **conflicts with §8 hour meter.** Unless "usage_event" is the specific table name being deferred and a different mechanism meets §8, this blocks §8. Open question.
- Org billing rollup page
- Audit log UI
- Customer pricing page
- Suspend/unsuspend (`workspace.suspended_at`) — explicitly out per matrix reconciliation

---

## Open conflicts that belong in 04-QUESTIONS-FOR-SAMEER.md

1. Role rename scope — can we add `billing` role or is it UI-only? (DB: `billing` doesn't map to existing enum, so UI-only is impossible.)
2. Visibility schema — new `workspace.visibility` enum vs keep booleans + rename at UI?
3. Hour meter — §8 requires it; checklist defers `usage_event`. Which wins?
4. Uncommitted working tree — resume or revert? (~1221 line delta across notifications + emails + scripts + auth routes)
5. Viewer role — collapse (matrix has no viewer) or keep?
6. Webhooks gate — matrix says changemaker+; code leaves open. Enable the gate?
7. Existing-customer role mapping for M1 — cross-reference current DB rows vs matrix role set before cutover.
