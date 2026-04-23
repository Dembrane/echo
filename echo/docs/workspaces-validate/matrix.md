# dembrane workspaces — capacity, permissions, migration

Single source of truth for the workspaces + teams + tiers release.
Engineering builds from this. Design references it. Sales quotes from it.

Version 1.1 · Slack-style discovery model (replaces derivation); workshop pass 2026-04-23.

---

## 1. Tier × capacity matrix

| | Pilot | Pioneer | Innovator | Changemaker | Guardian |
|---|---|---|---|---|---|
| **Price** | €349 one-time | €200/mo | €500/mo | €1500/mo | €5000/mo |
| **Duration** | 1 month | ongoing | ongoing | ongoing | ongoing |
| **Included seats** | 2 | 3 | 10 | 20 | unlimited* |
| **Seat overage** | — | €25/seat | €30/seat | €60/seat | — |
| **Included hours** | 10 | 25 | 50 | 100 | unlimited* |
| **Hour overage** | **hard block** | €5/hr | €4/hr | €3/hr | — |
| **Guest cap** | 2 | 5 | 20 | 50 | unlimited |
| **Training included** | 2 people | — | — | — | negotiable |

*Guardian unlimited subject to trained technical personnel and adequate AI infrastructure.*

Tier names ship as-is (Pilot / Pioneer / Innovator / Changemaker / Guardian). Every surface that shows a tier name in the product must pair it with a short descriptive tagline — the aspirational names aren't self-explanatory. Examples: "Pilot — one month to try it." "Pioneer — for your first real engagements." "Innovator — privacy and data portability." "Changemaker — your brand, your integrations." "Guardian — enterprise scale."

The tier capacity matrix (this section) must be visible inside the product at minimum on the workspace billing tab and in the upgrade-request modal. Customers should never have to leave the app to understand what each tier gets them.

## 2. Tier × feature matrix

| | Pilot | Pioneer | Innovator | Changemaker | Guardian |
|---|---|---|---|---|---|
| Projects, conversations, chat, reports | ✓ | ✓ | ✓ | ✓ | ✓ |
| Agentic chat | ✓ | ✓ | ✓ | ✓ | ✓ |
| Library / analysis views | invite-gated | invite-gated | invite-gated | invite-gated | invite-gated |
| All 7 languages | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Private projects** | ✗ | ✗ | ✓ | ✓ | ✓ |
| **Private workspaces** | ✗ | ✗ | ✓ | ✓ | ✓ |
| **Data export** | ✗ | ✗ | ✓ | ✓ | ✓ |
| **Whitelabel (custom logo)** | ✗ | ✗ | ✗ | ✓ | ✓ |
| **API access** | ✗ | ✗ | ✗ | ✓ | ✓ |
| **Webhooks** | ✗ | ✗ | ✗ | ✓ | ✓ |
| Support | email | email | dedicated | dedicated | account owner |
| EU hosted, GDPR, ISO 27001 | ✓ | ✓ | ✓ | ✓ | ✓ |

## 3. Downgrade behavior (per feature)

Default rule: **freeze, don't revert.** One exception: whitelabel.

| Feature | Behavior on downgrade |
|---|---|
| Private projects | Existing stay private. Cannot create new private projects. |
| Private project sharing | Existing shares keep working. Cannot add new shares. |
| Private workspaces | Existing stay private. Cannot create new private workspaces. |
| Data export | Already-downloaded exports unaffected. New exports blocked. |
| API tokens | Existing tokens keep working. No new tokens, no rotation. |
| Webhooks | Existing webhooks keep firing. No new webhook configs. |
| **Whitelabel** | **Reverts.** Custom logo cleared, dembrane wordmark restored. Warn on downgrade dialog. |

**Downgrade comms (required across every downgrade, whether freeze or revert):**

1. **Confirmation dialog** before the downgrade is executed. Lists every feature that will freeze and every feature that will revert, with plain-language impact ("your custom logo will be removed", "you won't be able to add new private project shares"). Admin or staff must acknowledge explicitly.
2. **In-workspace banner for 7 days post-downgrade.** "This workspace was downgraded to [Tier] on [date]. Some features are limited. [Learn more]" The banner is dismissible but auto-returns if the admin tries a frozen feature.
3. **Post-downgrade email** to every admin + billing-role user on the workspace. Summarizes what changed, what's now limited, and what remains available. Sent within 1 minute of the downgrade.

Clarity is the job. Don't try to soften freeze-vs-revert with vague copy — users need to know exactly what they can and can't do.

## 4. Role × capability matrix

Four roles. Apply at workspace level. Team-level admin/billing mirror workspace-level for team operations.

| Capability | Admin | Billing | Member | Guest |
|---|:---:|:---:|:---:|:---:|
| **Projects & content** | | | | |
| Create projects | ✓ | | ✓ | |
| Edit own projects | ✓ | | ✓ | ✓¹ |
| Edit any project in workspace | ✓ | | ✓ | |
| Delete projects | ✓ | | | |
| Move projects across workspaces | ✓ | | | |
| Make projects private (tier-gated) | ✓ | | | |
| Share private projects (tier-gated) | ✓ | | | |
| **Conversations** | | | | |
| Record, upload, edit conversations | ✓ | | ✓ | ✓¹ |
| Delete conversations | ✓ | | ✓ | |
| **Analysis** | | | | |
| Run chat / agentic | ✓ | | ✓ | ✓¹ |
| Generate reports | ✓ | | ✓ | ✓¹ |
| Publish reports | ✓ | | ✓ | |
| **Workspace management** | | | | |
| Invite members | ✓ | | | |
| Invite guests | ✓ | | | |
| Change member roles | ✓ | | | |
| Remove members | ✓ | | | |
| Change workspace settings (name, visibility, branding) | ✓ | | | |
| View usage & overage | ✓ | ✓ | ✓ | |
| **Billing** | | | | |
| See invoices | ✓ | ✓ | | |
| Update payment method | | ✓ | | |
| Request tier upgrade | ✓ | ✓ | | |
| **Destructive** | | | | |
| Delete workspace | ✓² | | | |
| Transfer workspace (between teams) | staff only | | | |

¹ Guest permissions are identical to member within the workspaces they're invited to. Difference is they have no team-level presence and are tier-capped, not billed.

² Delete workspace requires confirmation. Last admin cannot demote self or be removed.

## 5. Team-level roles

Same names as workspace roles: **Admin / Billing / Member** (no team-level Guest — guests exist only at the workspace level). Scope disambiguated by UI context ("Team admin" vs "Workspace admin").

| Capability | Team admin | Team billing | Team member |
|---|:---:|:---:|:---:|
| Invite people to the team | ✓ | | |
| Create workspaces | ✓ | | |
| See every workspace in team (open + private) | ✓ | ✓ | Open only |
| Join any team workspace explicitly | ✓ (becomes Admin) | — | Request access to open WS only |
| View team-level usage rollup | ✓ | ✓ | Raw numbers only (no €) |
| Change team settings | ✓ | | |
| Delete team | ✓² | | |

**Team-level access is direct-only. No derivation.** Being a team admin does not automatically make you an admin on every workspace — it just lets you *discover and join* them. Every join is an explicit action and writes a `source='direct'` membership row. Last-admin protection applies at both the team level and the workspace level.

## 6. Workspace visibility & discovery (Slack-style)

Every workspace has a `visibility` field: `open_to_team` | `private`.

- `open_to_team` — **UI label: "Open to team"**. Visible in discovery to all team members and team admins.
- `private` — **UI label: "Private"** (tier-gated: innovator+). Visible in discovery only to team admins. Completely invisible to team members.

**Who sees what in team discovery:**

| Viewer | Open workspace | Private workspace | Default action |
|---|---|---|---|
| Team admin | ✓ visible | ✓ visible | "Join" button — auto-grants Admin role |
| Team billing | ✓ visible | ✓ visible | View-only (usage); cannot join unless explicitly added |
| Team member | ✓ visible | ✗ hidden | "Request access" on open WS — approval writes Member row |
| Guest | Only WS they were invited to | Only WS they were invited to | No discovery — no team-level visibility |

**Honesty disclosure when creating private workspaces:** the create-workspace flow must show the creator a clear line: "Team admins can still discover and join this workspace." Private protects from team members, not from team admins. Don't hide this.

**Request-to-join approval (open workspaces only, members only):**

- A team member clicks "Request access" on an open workspace.
- Notification fires to every workspace admin on that workspace AND every team admin. Either can approve.
- On approval, the member gets a `source='direct'` Member row on the workspace.
- Rejection is silent from the member's perspective (no explanation surfaced).

**Team admin joining a workspace:**

- Team admin clicks "Join" on any workspace (open or private).
- Immediately gets a `source='direct'` Admin row. No approval gate.
- They can leave the workspace at any time — like Slack, joining and leaving are explicit and reversible.

**Sticky removal is retired.** If a person is removed from a workspace and later rejoins the team or discovers the workspace again, they rejoin normally by explicit action. No tombstones.

**Default for a new workspace:** `open_to_team`. Private is a deliberate, tier-gated choice.

## 7. Seats & billing

**Seat = active workspace access.** One seat per person per workspace, for members, admins, and billing.

- Same person in 3 workspaces = 3 seats.
- Guests are not billed but count against tier's guest cap.
- Team membership alone is not billable — only workspace access is.

## 8. Hours & usage

**Hour = one hour of recording** (live OR uploaded — same meter).

- Counted per workspace.
- Reset on the **calendar month boundary** (first day of the month, workspace-local to the subscription record).
- Overage: billed at tier rate (Pioneer €5, Innovator €4, Changemaker €3).
- Pilot: **hard block on host-side operations** at 10 hours (see below). Upgrade required to continue working with the data.
- No other tier hard-blocks — Pioneer and above bill overage and keep going.

**Hard block at Pilot limit — host-side only.** The participant portal never blocks. Recording keeps working. Audio continues uploading and transcribing. What blocks is host-side operations: chat / agentic analysis, viewing transcripts, generating or updating reports, exporting data, creating new projects. The upgrade screen must explicitly reassure: "Recording keeps working — your participants are unaffected."

**Usage rollups shown at three levels:**

1. **Project level** — hours consumed by conversations in this project, current cycle.
2. **Workspace level** — total hours + seat count + guest count, current cycle, per-project breakdown, overage warnings.
3. **Team level** — rollup across all workspaces in the team. Shows which workspaces are over, which tier each is on, aggregate spend.

**Visibility by role:**

- **Members** see raw usage numbers (hours, seats, projects) at every level. They do not see euro amounts or overage cost forecasts.
- **Admins and Billing** see everything members see, plus billing implications: euro overage forecasts, projected monthly cost, tier recommendations.

Member transparency on raw numbers is intentional — members should be able to gauge their own contribution to quota consumption without having to ask an admin.

## 9. New workspace defaults

- **Tier:** Pilot.
- **Visibility:** `open_to_team`.
- Admin on create: the creator gets a `source='direct'` Admin row. No other rows are written at creation time. Other team members and admins discover the workspace through the Slack-style discovery model (Section 6).
- Tier upgrade requires explicit request (admin or billing → staff).
- **Exception:** seeded workspaces (migration, internal demo, staff-created special cases) bypass this — tier set at creation by staff per M1.

## 10. Partner-client model

**Subscription ownership during engagement:**
- Partner creates the workspace and pays the subscription.
- Workspace billing attribution: `billed_to_team_id` (partner) + `effective_client_team_id` (nullable, filled post-handoff).

**Handoff:**
- Clean subscription transfer. Partner initiates → client accepts → billing attribution flips.
- Workspace stays at its current tier. No re-tiering on transfer.
- Partner retains no operational access unless explicitly retained as guest.

**Referral kickback:**
- 20% of the workspace's monthly tier cost, paid monthly to the partner.
- Tracked per-workspace in `referral_ledger` table.
- Each ledger entry has optional `expires_at` — no global default. Expiry set per deal or globally later.
- Partner can offer additional discount to client (funded from partner's share or at partner's cost — their call).

**Ledger fields (at minimum):**
```
referral_ledger
  id
  workspace_id
  partner_team_id
  partner_kickback_percent (default 20)
  starts_at
  expires_at (nullable)
  notes
  created_by_staff_id
```

## 11. Upgrade flow

- **Requesters:** admin or billing on a workspace.
- **Executors:** staff with the `staff:can_set_tier` policy. This is a new policy, narrower than Directus Administrator — not every Directus admin has pricing authority. Add to policies.py alongside existing staff policies.
- **Mechanism:** `POST /v2/workspaces/:id/upgrade-request` → email to upgrade inbox.
- **Upgrade inbox:** `upgrades@dembrane.com`. Configured via `UPGRADE_REQUEST_INBOX` env var. Set up before cutover.
- **The upgrade-request modal must show the full tier capacity matrix** (Section 1). Customers should never have to guess what a tier includes when deciding to upgrade.
- **Members see:** "Ask one of your team admins to upgrade." No CTA, no mailto, no admin list. The friction is the gate, not a missing button.

---

# Migration strategy

Applies to existing customers, existing projects, and existing partner relationships at cutover.

## M1. Tier mapping for current customers

Map each current customer to a tier at cutover. Criteria:

| Current customer profile | Map to |
|---|---|
| Active engagement, has private projects or exports in use | Innovator (seeded, not Pilot) |
| Active engagement, uses whitelabel or API | Changemaker (seeded) |
| Enterprise commitment in place | Guardian (seeded) |
| Pilot / evaluation / unclear status | Pioneer (seeded, NOT Pilot — avoid hour block on existing users) |
| Inactive >90 days | Pioneer (seeded), flag for churn review |

**Rule:** existing customers never get dropped onto Pilot by the migration. Pilot is new-customer-only. Pioneer is the safe floor.

Build a CSV export tool (internal only):
- Customer name, current usage (last 90 days hours + seats), current feature usage (private/whitelabel/API/export), proposed tier, notes field for staff override.
- Review manually before cutover. No automated tier assignment ships without human sign-off per customer.

## M2. Team mapping

Every current customer account becomes a team at cutover.

- Existing users → team admins (their current account is effectively admin today).
- Each customer's projects → grouped into one workspace within that team by default.
- If a customer clearly has multiple distinct engagements (different clients, different contexts), staff can pre-split into multiple workspaces before cutover.
- Team name defaults to customer/org name; user can rename.

Edge case: shared accounts (multiple people using one login). Flag in the CSV. Contact directly — need to split into real accounts before workspace migration or they'll fight over admin seat.

## M3. Partner relationships

For each current partner:

1. **Identify partner-client relationships** already in play (consultancies running client engagements on dembrane).
2. **Onboard the partner to the new model:**
   - 1:1 call to explain workspaces, tiers, subscription ownership.
   - Educate on kickback mechanics, financial planning implications (monthly recurring, capped at 20%, optional expiry).
   - Agree which existing projects belong to which client — create the workspace topology with them.
3. **Seed the ledger** with current active partner-client pairings. `starts_at` = migration cutover date. `expires_at` = null unless partner negotiates otherwise.
4. **Handoff plan per workspace** — if the client is ready to take over billing, schedule the transfer. Otherwise partner continues.

## M4. Floodgate strategy

Release is not a silent deploy. Staged rollout prevents the "everyone hit with Pilot 10-hour block on Tuesday morning" scenario.

**Phase 0 (pre-cutover, -7 days):**
- Staff reviews every customer in the internal CSV tool.
- Tiers seeded per M1. Teams and workspaces created per M2.
- Partner calls completed per M3.
- Nothing user-visible changes.

**Phase 1 (cutover day):**
- New UI ships. Users see teams, workspaces, tier indicator.
- All existing customers are on their seeded tier (Pioneer or higher). **No one is on Pilot.**
- In-app announcement: "Workspaces are here. Here's what's new." Links to short doc.

**Phase 2 (cutover +7 days):**
- Monitor: usage, support tickets, upgrade requests, any hour-block hits (should be zero — existing customers are Pioneer minimum, which has €5/hr overage, not block).
- Follow-up calls scheduled for customers flagged in CSV as "tier uncertain."

**Phase 3 (cutover +14 days onwards):**
- New signups route through Pilot by default.
- Pilot hour-block hits WILL happen — this is expected and desirable, it's the upsell moment.
- Upgrade screens shown on block → sales call booking link → staff responds within 24h.

**Internal tooling needed before cutover:**
- CSV export of all customers with current usage + proposed tier.
- Directus view: workspaces approaching hour limit, current usage, tier.
- Directus view: pending upgrade requests with SLA timer.
- Flag column in customer CSV: "tier uncertain — needs review."

## M5. Comms

- **Email to all existing customers** 3 days before cutover. Plain language. "We're adding team collaboration. Nothing you do today changes. Here's what's new for you." Link to doc + video.
- **In-app banner** on cutover day for 7 days.
- **Partner-specific email** separately, with their kickback terms attached.

## M6. Rollback plan

If cutover goes sideways:
- Workspaces feature can be hidden behind a feature flag per team.
- Underlying data model is additive — no destructive migration.
- Rollback = flip the flag, users see the old UI, data remains in new structure, no loss.

---

## Open items (not blocking cutover)

- [ ] Exact guest caps for Pilot (currently 2) — revisit after first 10 Pilot signups.
- [ ] Self-serve billing (v2 — staff-executed upgrades are fine for v1).
- [ ] Decision on whether Guardian's "unlimited" has soft internal caps for capacity planning.
- [ ] Library / analysis views — stays invite-gated for now; revisit once usage patterns are clearer.

## Locked decisions reference

This document reflects decisions from:
1. Resolution doc (Q1–Q8 answered) + role model (Admin, Billing, Member, Guest — no Owner, no Viewer).
2. Pricing strategy doc (Pilot → Guardian, hours + seats primitives).
3. First follow-up pass: referral ledger with optional expiry, usage rollups at every level, migration strategy.
4. **Workshop pass 2026-04-23:** Slack-style workspace discovery replacing derived inheritance; sticky removal dropped; last-admin protection (block); cross-team admin allowed freely; downgrade comms pattern (dialog + 7-day banner + email); member raw-usage visibility; calendar-month quota reset; `upgrades@dembrane.com` inbox; new `staff:can_set_tier` policy; seats = direct members only (guests excluded); tier names ship as-is with taglines + visible capacity matrix in product; partner full-visibility on owned workspaces pre-handoff.

Changes to this document require sign-off from Sameer + Jorim.