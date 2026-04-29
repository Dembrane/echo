# Workspaces Release — Master Checklist

> **Target release:** end of the week of 2026-04-20
> **Status doc:** this file. Tick items as they land.
> **Companion docs:** `workspaces-prd-v3-final.md`, `execution-plan-final.md`, `designer-return.html`, `designer-brief.md`, `designer-brief-v2.md`, `inheritance-rules.md`

## Progress gauges

```
Schema           [██████████] 100%
Soft delete      [██████████] 100%
Core API         [███████░░░]  65%
Frontend route   [██████████]  95%
Settings UI      [█████░░░░░]  50%
Project polish   [██░░░░░░░░]  20%
Emails           [████░░░░░░]  40%
Internal tools   [░░░░░░░░░░]   0%
────────────────────────────────────
Feature total    [██████░░░░]  ~65%
```

---

## Session 1 — EXPLORE  `[██████████] 100%`
- [x] Codebase exploration report
- [x] PRD v3 final + reconciliation
- [x] Execution plan, architecture review, failure analysis

## Session 2 — SCHEMA  `[██████████] 100%`
- [x] `app_user` collection (6f34b48)
- [x] `org` + `org_membership` (31ab178)
- [x] `workspace` + `workspace_membership` (9492e65)
- [x] `workspace_invite` + `project_membership` (686a81a) — `project_membership` replaces PRD's `project_user`
- [x] `project.workspace_id` / `visibility` / `deleted_at` (705e1a9)
- [x] `deleted_at` on conversation / project_chat / project_report (1128430, 948890c)
- [~] `usage_event` — intentionally removed (35281fe); revisit post-release

## Session 3 — SOFT DELETE  `[██████████] 100%`
- [x] `AsyncDirectusClient` for FastAPI (0466d6f)
- [x] Conversation soft delete (6d23381)
- [x] Project soft delete (bee6bfc)
- [x] Chat soft delete (43e2d16)
- [x] Report soft delete (2b5e4e2)
- [x] Webhook soft delete (54afb0b)
- [x] Tag soft delete (25cb4e8)
- [x] `deleted_at IS NULL` on all reads (bb02811)
- [x] DELETE permissions removed from Basic User (24b94f9)

## Session 4 — CORE API + ONBOARDING  `[███████░░░] 65%`

**Built**
- [x] `get_workspace_context` middleware + policy system (1925651)
- [x] `GET/POST /v2/workspaces`
- [x] Workspace settings CRUD (get, update, remove member, change role, resend/cancel invite)
- [x] `POST /v2/workspaces/:id/invite` (HMAC token, rate-limited)
- [x] Workspace-scoped projects: list/create/move (0d3ba76, 1637c85)
- [x] `/v2/me` (get/update/pending invites/accept/decline/accept-by-hash)
- [x] `/v2/onboarding/complete` (idempotent, auto-accepts pending invites)
- [x] Inherited org admins auto-added on workspace create
- [x] Tier policies enforced server-side

**Decision: skip migration script.** Auto-onboarding covers the new-user case. Existing-user migration lives in the onboarding flow itself (see "Onboarding split" below).

**Missing**
- [ ] Org API: `GET /v2/orgs`, `GET /v2/orgs/:id/members`, `PATCH/DELETE /v2/orgs/:id/members/:uid`
- [ ] Org admin promotion → inherited workspace memberships (verify + wire)
- [ ] `PATCH /v2/workspaces/:id/tier` (staff-only; see Internal tools below)
- [ ] `DELETE /v2/workspaces/:id` (soft delete; blocked if projects exist)
- [ ] `POST/DELETE /v2/projects/:id/members` (private project sharing, innovator+)
- [ ] Staff guard: `is_staff` check on directus_users; `/v2/me` returns `is_staff` flag
- [ ] `POST /v2/workspaces/:id/suspend` + `unsuspend` (staff-only, blocks all access)

## Phase 3 — Frontend routing + selector  `[██████████] 95%`
- [x] `/:locale/w/:workspaceId/...` routing (bb5c8f3)
- [x] Workspace selector + last-used memory (cac5561)
- [x] Post-login router + onboarding redirect
- [x] Topbar workspace switcher
- [x] 403 stale-state handling (5aa191b)
- [ ] Progressive solo experience (hide "workspace" language for 1-ws users)
- [ ] Selector polish per designer Ask 5: organisation hero card on top, per-row `⚙ manage` on hover, externals in quieter section

## Phase 4 — Frontend settings + management  `[█████░░░░░] 50%`

**Built**
- [x] Workspace settings page (756aecc) — one-page layout
- [x] Member role change, remove, resend/cancel invite (b4a77d9)
- [x] Create workspace (single-step form)
- [x] User settings + `PATCH /v2/me` (eae799d)

**Designer-locked directions (from `designer-return.html`)**
- [ ] **Ask 1 — Organisations admin page** `/org/:orgId/members`: list ⇄ matrix view switcher on same URL. Organisation section (inherited to all workspaces) + External section separate. Row menu: change role / view workspaces / remove. Matrix hidden ≤768px with "switch to list" toast.
- [ ] **Ask 2 — Tier management** on workspace settings `?tab=billing`: feature-matrix comparison, current tier highlighted, "Request upgrade" CTA (email-based). **Staff-only inline block** with Set tier dropdown + internal reason field + confirm dialog. No separate `/admin` route.
- [ ] **Ask 4 — Upgrade prompts**: 4B hatched overlay for feature surfaces (Whitelabel, API, Data export); 4C modal per feature. **Role-aware**: admin/owner see "Request upgrade" primary; member sees "Ask an admin" ghost — same modal opens.
- [ ] **Ask 5 — Selector polish**: organisation hero card (name, 3 workspaces, 12 people, tier agg, "Manage organisation" CTA), workspaces list with hover `⚙ manage`, external section with "guest of X" pill.
- [ ] Settings tab split (General / Members / Branding / Legal / Billing) — currently one page
- [ ] Delete workspace UI
- [ ] Migration onboarding modal ("your projects moved to [workspace]")

## Phase 5 — Project changes + polish  `[██░░░░░░░░] 20%`

**Designer-locked directions**
- [ ] **Ask 3.1 — "Shared with" strip** on project overview page (under header, above content). Shows Private pill + avatars + "+N more" + "Manage →". When public: "Visible to everyone in [workspace] · Make private".
- [ ] **Ask 3.2 — "Who can see this project?" modal**: user list with `can edit` / `can read` dropdowns. Only users already in workspace (no cross-workspace). "Everyone else in [workspace]" = no access. Link sharing off. Verb labels, not nouns. Gated innovator+.
- [ ] Visibility toggle (workspace ↔ private)
- [ ] Tier-gated empty states with upgrade CTAs

## Queued design directions (2026-04-21)

Handed over by Sameer with the inbox spec. Each lives as its own
session — rewires below land where they map to an existing section.

### Home (per organisation) `[░░░░░░░░░░] 0%`

Organisation-scoped landing page (one per organisation the viewer belongs to):
- Thin organisation strip: avatars + viewer role chip + "Manage organisation" link
- Admin-only notice bar: pending access requests
- Workspace cards grid — every workspace in the organisation
- Discoverable list — admin sees `Join`, member sees `Request access`
- Pending requests section (member-only, own requests in flight)
- `+ New workspace` button — admin-only

Replaces the current single-list selector as the per-organisation default. Global
selector survives for cross-organisation switching.

### Workspace settings — tabbed `[░░░░░░░░░░] 0%`

Current single-page → tabbed layout:
- **General** — name, description, logo
- **Members** — list with source pills (`inherited` / `direct` / `external`);
  destructive actions in `⋯` menu; raw permissions behind a disclosure
- **Access** — two-state radio `Shared / Private`; privacy defaults
- **Billing** — tier compare matrix + upgrade-request + staff inline block
  (folds in Ask 2 + 2s)
- **Danger zone** — delete workspace

### Workspace create — multi-step `[░░░░░░░░░░] 0%`

Replaces the one-step form with `Details → Visibility → Invite → Review`.
One primary action per step.
- `Visibility=Shared` shows a dry-run preview: "organisation members auto-inherit."
- `Invite` step picks from organisation roster OR enters email for externals.
- Review step shows everything before create.

Supersedes the earlier "full multi-step flow" bullet — this is the concrete
step list.

### Project sharing — list view `[░░░░░░░░░░] 0%`

Replaces matrix with a list:
- Inherited-from-workspace rows shown read-only
- Direct grants editable
- Source pills: `workspace member` / `organisation member (project-only)` / `external`
- Soft warning at 10+ collaborators ("consider opening the project to the
  whole workspace")

Supersedes Ask 3.2's modal-as-matrix direction.

---

## Onboarding split (designer fix)  `[░░░░░░░░░░] 0%`

Current `OnboardingRoute` is a **migration prompt** that new users shouldn't see. Split into two paths:

- [ ] **New user path**: add optional "Organisation name" field to signup form. On submit → auto-create organisation (fallback `"{firstName}'s organisation"`), default workspace, land in `/w/:id/projects` empty state. No separate onboarding route.
- [ ] **Existing user path**: keep current screen, re-copy as migration. Show only if `user.createdAt < workspaces-launch-ts` AND no organisation membership yet.

---

## Internal tools — "how do we block access?"  `[░░░░░░░░░░] 0%`

Three levers:

1. **Tier downgrade** — staff sets `workspace.tier` via inline billing-tab control (designer Ask 2s). Policy layer blocks innovator+/changemaker+/guardian features automatically. Best for "stop letting them use feature X".
2. **Workspace suspend** — new `workspace.suspended_at` field. Middleware checks it in `get_workspace_context` → returns 403 with friendly "This workspace is paused — contact your admin". Best for "block all access" (non-payment, abuse, GDPR).
3. **Membership removal** — existing soft-delete path. Blocks a specific user. Best for individual offboarding.

Deliverables:
- [ ] `workspace.suspended_at` field + middleware 403 + frontend friendly page
- [ ] `is_staff` boolean on `directus_users` (or role check); surfaced in `/v2/me`
- [ ] Staff-only inline block on workspace billing tab:
  - [ ] Set tier (dropdown + reason field + confirm dialog)
  - [ ] Suspend / Unsuspend (toggle + reason)
  - [ ] Internal notes field (free text, staff-only visible)
- [ ] Staff-only inline block on org admin page:
  - [ ] View all members across all org workspaces (matrix already handles this)
  - [ ] Export CSV of members
- [ ] Audit log of staff actions (lightweight `staff_action` collection — append-only, `{actor, action, target, reason, created_at}`)

---

## Emails  `[████░░░░░░] 40%`

Exists: `workspace_invite.html`, `workspace_added.html` — basic, brand-updated.

**Polish**
- [ ] Shared layout partial (header/footer de-duplicated; consider MJML)
- [ ] Proper logo header, typography scale, Royal Blue accent
- [ ] Preview text (`<preview>`) for inbox preview lines
- [ ] Footer: help link, company address, unsubscribe (where applicable)
- [ ] Plain-text fallback for both templates (currently HTML-only → spam risk)
- [ ] Inviter name + avatar/initial; workspace name prominent
- [ ] Test rendering: Gmail / Outlook / Apple Mail / dark mode

**New templates (this release)**
- [ ] Welcome email after first signup (post-onboarding)
- [ ] Role changed notification ("You are now admin of X")
- [ ] Removed from workspace notification (GDPR-friendly wording)

**Deferred to post-release**
- [ ] Invite reminder (24h before expiry — cron)
- [ ] Org admin promoted notification
- [ ] Workspace suspended/unsuspended notifications (tie to internal tools)

---

## Decisions locked

- **Inheritance semantics (2026-04-20):** **rule-of-system (option a)** — every *open* workspace in a organisation always includes every current + future organisation owner/admin as an inherited admin. Private workspaces (`workspace.settings.inherit_organisation_admins = false`) never auto-include. No time dimension. ⚠️ **Must be ratified by the organisation before release.**
- **Derived inheritance (2026-04-20):** inherited admin/member access is **computed at query time, not stored.** No `workspace_membership` rows with `source='inherited'`. One resolver (`user_can_access`) is the single source of truth. Sticky removal lives as JSON tombstones in `workspace.settings.sticky_removed`. Full spec + migration plan in `inheritance-rules.md`. Replaces the earlier trigger/fan-out codification (now gone from the doc).
- **Access buckets in the creation wizard (2026-04-20):** two booleans stored in `workspace.settings` — `inherit_organisation_admins` (default true, shown as a checked-disabled row) + `inherit_organisation_members` (default false, shown as an optional checkbox). Dropped "external" as a bucket — externals never inherit (their presence on a workspace is always an explicit `source='direct'` row). Show step 2 of the wizard even for solo organisations; dry-run reads "0 organisation admins will inherit."
- **Billing for private (2026-04-20):** **innovator+ tier at both workspace and project level** (designer's lean, accepted). Matches the existing gate on private-project sharing — one mental model: privacy is an innovator-tier capability. Solo users (organisation of 1) still see the option; it just has no behavioral effect.
- **30-day soft-delete SLA (2026-04-20):** accept the principle — rows with `deleted_at` older than 30 days are eligible for hard-delete. **Purger + Trash/Restore UI deferred to post-release.** Soft-delete alone is sufficient for ship.
- **Tier lives on the workspace (2026-04-20):** `workspace.tier` stays. Partner-client handoff model needs per-workspace flexibility — a partner might run three client workspaces on different tiers (one client on Guardian for whitelabel, another on Pioneer during pilot). Moving tier to the organisation would collapse that flexibility. Selector "mixed tier" display stays a real state and gets handled in UI. Ask 2 "Tier management" stays on the workspace billing tab per designer's v5 assumption.
- **Workspace-level configuration (2026-04-20):** whitelabel (logo + branding), trash / retention settings, and (future) custom prompts are **workspace-scoped**, not org-scoped. Storage: `workspace.logo_url` (already present) + `workspace.settings` JSON (already present) carry these. Org-level defaults may bubble down later (inheritance pattern for configuration, not access) — but the per-workspace override is always authoritative.
- **"Request upgrade" CTA (2026-04-20):** **real endpoint.** `POST /v2/workspaces/:id/upgrade-request` sends a styled email via SendGrid + returns a toast confirmation. Target inbox is configurable via env var `UPGRADE_REQUEST_INBOX` (default `sameer@dembrane.com` for now). Swap to a shared inbox at workshop. **Admin-role only.**
- **Member-role upgrade prompt (2026-04-20):** **no CTA.** Gate copy reads "This feature requires [tier]. Ask one of your organisation admins to upgrade." No button, no mailto, no admin-name list. Members can find admins via the members tab. The real friction is the gate, not a missing button; adding a CTA would be hollow flow.
- **Access-blocking levers:** tier downgrade + soft-delete workspace + membership removal. No `suspended_at` field this release.
- **`is_staff`:** derived from `auth.is_admin` (Directus Administrator role). No new schema.
- **Private workspace / private project flags:** stored in existing JSON/enum columns (`workspace.settings.inherit_organisation_admins`, `project.visibility`). No new columns.
- **Migration script:** skipped. Auto-onboarding + onboarding-split covers it.
- **Creation wizards (2026-04-20):** **full multi-step flow (option 2).** Dedicated routes (`/w/new`, `/w/:id/projects/new` — verify naming during S9), progress indicator, step-back, reviewable summary before create, cancel at each step. Applies to workspace creation and project creation. Designer to deliver Ask 6 wires for both.
- **Delete workspace (2026-04-20):** **option A — must be empty.** `DELETE /v2/workspaces/:id` returns 409 if any non-deleted projects exist. UI error message links to the organisation-page project surface (below) so admins can bulk-clean without walking into every workspace.
- **Organisation page — project management surface (2026-04-20):** Ask 1 expands to cover project-level actions across all organisation workspaces. Exact UI is open (see designer-brief-v2 Ask 1 follow-up). Goal: from the organisation admin page, an owner/admin can see every project in every workspace in the organisation and soft-delete any of them, so winding down a workspace is one page, not twenty.
- **Tier downgrade behavior (2026-04-20):** **Option A — freeze**, with **one hybrid exception: whitelabel is cleared on downgrade**. Existing premium artifacts (private shares, exports, API tokens) remain usable after downgrade but can't be added to; new attempts are gated. Whitelabel branding reverts to dembrane logo on downgrade — the confirmation dialog explicitly lists "your custom logo will be removed" before staff/admin proceeds. Generalizable rule: freeze by default, explicit-revert only where leaving state visible would brand-misrepresent the tier.
- **Tier gate auto-wiring in `has_policy()` (2026-04-20):** **included in S6.** `has_policy()` will look up `TIER_REQUIRED_FOR_POLICY[policy]` and deny if the workspace's current tier falls below. Removes the per-endpoint `ctx.require_tier()` requirement and closes the silent-gap risk flagged in `policies.py:21`.

## Tier + role gating matrix

Two independent axes. To use a feature you need the minimum tier **AND** the minimum role (within the workspace or org). Source: `server/dembrane/policies.py` + PRD + `docs/workspaces/reference.md` feature tree.

### Tier gates (workspace.tier)

| Feature | Min tier | Policy | Downgrade behavior |
|---|---|---|---|
| Projects + conversations + chat + reports (core) | pilot | — | — |
| Data export (transcripts / CSV / report download) | innovator | `workspace:export` | Freeze — existing files keep working; can't trigger new export |
| Private project sharing (add people to a private project) | innovator | `project:share` | Freeze — existing shares stay; no new shares can be added |
| Private project creation (`visibility='private'`) | innovator | `project:set_private` (new) | Freeze — stays private; can't newly mark private |
| Private workspace (opt out of organisation inheritance) | innovator | `workspace:set_private` (new) | Freeze — stays private; can't newly mark private |
| Whitelabel branding (custom logo) | changemaker | `workspace:whitelabel` | **Revert** — custom logo cleared, dembrane logo restored; downgrade dialog must explicitly warn |
| API / integration access | changemaker | `workspace:api_access` | Freeze — existing tokens keep working; no new tokens; rotation blocked |
| Webhooks | pilot *(current)* | none | Keep — free for all tiers today. Organisation Q: bump to changemaker with API? |
| Library / analysis views | pilot *(current, invite-gated)* | none | Organisation Q: should this be tier-gated at innovator+? |
| Agentic chat mode | pilot *(current BETA)* | none | Organisation Q: post-BETA, gate at innovator+? |

### Role gates (workspace_membership.role)

| Policy | viewer | member | admin | owner |
|---|:-:|:-:|:-:|:-:|
| project:read, conversation:read, report:view | ✓ | ✓ | ✓ | ✓ |
| project:create, project:update | — | ✓ | ✓ | ✓ |
| conversation:delete, chat:use, report:generate | — | ✓ | ✓ | ✓ |
| project:delete, project:share, project:move | — | — | ✓ | ✓ |
| report:delete | — | — | ✓ | ✓ |
| member:invite, member:manage | — | — | ✓ | ✓ |
| settings:manage, workspace:view_usage | — | — | ✓ | ✓ |
| workspace:export (+ innovator) | — | — | ✓ | ✓ |
| workspace:whitelabel (+ changemaker) | — | — | ✓ | ✓ |
| workspace:api_access (+ changemaker) | — | — | ✓ | ✓ |
| workspace:delete *(needs policy, owner-only)* | — | — | — | ✓ |
| upgrade-request submission | — | — | ✓ | ✓ |

### Org-role gates (org_membership.role)

| Policy | member | admin | owner |
|---|:-:|:-:|:-:|
| org:view | ✓ | ✓ | ✓ |
| org:manage_users, org:manage_settings, org:manage_billing | — | ✓ | ✓ |
| org:create_workspace, org:view_all_workspaces, org:view_usage | — | ✓ | ✓ |
| `*` (everything, transfer ownership) | — | — | ✓ |

### Staff gates (`auth.is_admin`, i.e. Directus Administrator)

| Action | Non-staff | Staff |
|---|:-:|:-:|
| View any workspace in Directus admin | — | ✓ |
| `PATCH /v2/admin/workspaces/:id/tier` | — | ✓ |
| Future: workspace audit log, suspend, force-transfer | — | ✓ |

### Enforcement pattern

- **Role** checks via `ctx.require_policy("...")` (middleware does the work; see `server/dembrane/api/v2/middleware.py`).
- **Tier** checks via `ctx.require_tier("innovator")` at the endpoint (explicit, auditable).
- **Staff** checks via `auth.is_admin` on the session object (JWT claim `admin_access`).
- **Gaps to close in S6:** wire `TIER_REQUIRED_FOR_POLICY` into `has_policy()` so tier gates fire automatically, not per-endpoint. Currently each tier-gated endpoint must call `ctx.require_tier()` by hand (`policies.py` has a TODO comment on this).

## Questions for the organisation (workshop)

> Sameer is running a workshop with the organisation to ratify these before release. Each item needs a call, not more discussion.

### Access & inheritance
- [ ] **Inheritance rule-of-system (a) vs time-based (b).** Locked at (a). Confirm partners expect this when adding a new organisation admin retroactively. Sensitive past workspaces must be flipped to private *before* the admin joins — is that workflow acceptable, or do we need a smarter default?
- [ ] **Sticky removal across organisation re-join.** If person A is removed from workspace W (inherited) and later leaves the organisation and rejoins as admin, do they get auto-added to W again? PRD says no ("sticky"). Keep sticky forever, or expire it (e.g. 90 days)?
- [ ] **Last-admin protection.** What happens if the last owner of a organisation tries to leave or is removed? Block, or auto-promote someone? Who?
- [ ] **Cross-organisation membership.** Can a single user be an admin of two organisations at once? Technically yes. Product: do we want the UI to encourage this or nudge against it?

### Tier
- [ ] **Tier gating matrix.** Confirm the matrix above matches the product strategy. Specific open gates:
  - **Webhooks** — currently free. Promote to changemaker alongside API access?
  - **Library / analysis views** — currently invite-gated. Move to tier-gated innovator+, or keep invite-gated?
  - **Agentic chat mode** — post-BETA, does it stay free or gate at innovator+?
- [ ] **Downgrade behavior list.** Freeze is default; whitelabel reverts on downgrade. Any other feature that should revert rather than freeze? Candidates: portal editor "custom finish text", transcript anonymization (probably keep as compliance).
- [ ] **Quota/seat gates.** Tiers currently gate *features*. Do we also want to gate *quantities* (projects per workspace, audio hours per month, members per workspace)? Not in scope this release unless essential.
- [ ] **New workspace starting tier.** Always `pioneer`, or does it inherit the organisation's highest-active tier?
- [ ] **Upgrade request inbox.** `sameer@dembrane.com` for now. When do we switch to a shared inbox, and what's the address?
- [ ] **Staff definition.** Is "Directus Administrator role" the right population for set-tier + audit? Any non-Administrators we want to include, or any Administrators we want to exclude?

### Billing & seats
- [ ] **Billable seat count.** Does a seat = direct members only, or direct + inherited? Affects how partners think about cost of adding organisation admins.

### Copy & UI
- [ ] **External vs Guest.** Designer uses "guest of [organisation]", PRD uses "External". Pick one for all UI.
- [ ] **Role names.** owner / admin / member / viewer — keep or soften (e.g. "editor" instead of "member")?
- [ ] **Tier names.** pilot / pioneer / innovator / changemaker / guardian — friendly enough for partners, or rename for clarity?

## Sessions ahead

Each session = one focused Claude Code conversation that lands a coherent batch of commits. We extend the original 4-session pattern (EXPLORE → SCHEMA → SOFT DELETE → CORE API). Sessions 1–4 completed on workspaces branch prior to 2026-04-20.

```
✓ S1  EXPLORE — codebase + PRD reconciliation
✓ S2  SCHEMA — org/workspace/membership/invite collections
✓ S3  SOFT DELETE — project/conversation/chat/report/webhook/tag + read filters
✓ S4  CORE API v1 — workspace CRUD, invites, /v2/me, onboarding-complete
─────────────────────────────────────────────────────────────────────────
○ S5  ORGS + STAFF — /v2/orgs endpoints; is_staff in /v2/me (derived from auth.is_admin); answer access-inheritance semantics
○ S6  ACCESS RULES — workspace.settings.inherit_organisation_admins respected in: create-workspace, organisation-invite, org-admin promotion; tier PATCH (staff-only); upgrade-request endpoint; delete-workspace endpoint
○ S7  ORGANISATIONS ADMIN PAGE — Ask 1 list ⇄ matrix ⇄ projects (3-view switcher); row menu; Invite-to-organisation; project delete across organisation
○ S8  TIER MANAGEMENT UI — Ask 2 compare matrix + Ask 2s inline staff controls on billing tab
○ S9  CREATION WIZARDS — workspace + project creation wizards with dry-run preview; privacy toggle
○ S10 PRIVATE PROJECT SHARING — Ask 3 "Shared with" strip + "Who can see" modal + visibility toggle
○ S11 UPGRADE PROMPTS — Ask 4 4B hatched overlay + 4C modal, role-aware copy
○ S12 SELECTOR + SETTINGS POLISH — Ask 5 organisation hero + per-row manage + settings tab split
○ S13 ONBOARDING SPLIT — new-user organisation-name-at-signup vs migration screen
○ S14 EMAILS — shared layout partial, plain-text fallbacks, welcome/role-changed/removed templates
○ S15 BUG BASH + RELEASE — smoke tests across roles (owner/admin/member/external/staff); deploy testing → main
```

Dependencies: S7 depends on S5; S8 depends on S6 tier PATCH; S9 depends on S6 access-rule wiring; S10 depends on S9's visibility plumbing.

---

## Release blockers (must ship)

1. Organisations / Org admin page + org API (Ask 1)
2. Tier set/change via inline staff controls (Ask 2s) — **replaces "internal tools" migration story**
3. Workspace suspend/unsuspend (access-blocking primitive)
4. Delete workspace endpoint + UI
5. Onboarding split (new user vs migration)
6. Email polish + plain-text fallback

## Deferred (post-release OK)

- Private project sharing UI (Ask 3) — strongly prefer this week if time allows; designer is ready
- Workspace usage detail page
- Org billing rollup page
- Invite reminder cron
- `usage_event` reinstatement
- Staff action audit log (can start as simple log lines, formalize later)

---

## Changelog for this doc

- **2026-04-20**: initial master checklist; incorporated designer v2 directions; dropped migration script in favor of auto-onboarding + onboarding split; added internal tools / access-blocking track.

## Session status — autonomous run 2026-04-20 (~2h)

Commits landed on `workspaces` branch (not pushed):

| # | Hash | Commit |
|---|---|---|
| 1 | 94cf40d | feat: derived inheritance module + tier auto-wire in has_policy |
| 2 | 818c774 | feat: surface is_staff in /v2/me |
| 3 | 9736a2c | feat: /v2/orgs endpoints for organisation management |
| 4 | (docs) | docs: workspaces release sources of truth |
| 5 | 4141262 | feat: tier mgmt, upgrade-request, delete workspace, downgrade effects |
| 6 | e26d725 | refactor: shared email layout + auto plain-text fallbacks |
| 7 | c51a7e0 | feat: private project sharing API — /v2/projects/:id/members CRUD |
| 8 | e66c483 | feat: onboarding split — differentiate new vs legacy users |

### What landed

- **S5 Orgs + staff** `[██████████] 100%` — `dembrane/inheritance.py` (derived resolvers + helpers), `/v2/orgs` CRUD + members, `is_staff` in `/v2/me`, middleware delegates to `user_can_access`, workspace creation no longer fans out inherited rows.
- **S6 Access rules + tier + delete + downgrade** `[█████████░] 95%` — `has_policy()` auto-enforces tier gates via `TIER_REQUIRED_FOR_POLICY`; `PATCH /v2/workspaces/:id/tier` (staff-only, reason required); `POST /v2/workspaces/:id/upgrade-request` (admin-only, configurable inbox via `UPGRADE_REQUEST_INBOX`); `DELETE /v2/workspaces/:id` (owner-only, blocked if projects); `dembrane/tier_downgrade.py` with `DOWNGRADE_EFFECTS` map + `preview_downgrade()` / `apply_downgrade_effects()`; privacy flags (`inherit_organisation_admins` / `_members`) accepted on create + patch.
- **S10 Private project sharing API** `[████░░░░░░] 40%` — backend complete (`/v2/projects/:id/members` CRUD, innovator+ gated, no cross-workspace). Frontend UI (strip + modal) blocked on design wires.
- **S13 Onboarding split** `[████████░░] 80%` — backend flag `has_legacy_projects` on `/v2/me`; `OnboardingRoute` copy splits three ways (invite / legacy / new). Hasn't been visually verified in a browser — the copy changes are additive and don't touch layout.
- **S14 Emails** `[███████░░░] 70%` — shared `_layout.html` partial, brand-compliant; existing `workspace_invite` + `workspace_added` refactored to extend; plain-text `.txt` fallbacks auto-picked by `send_email`; multipart/alternative wiring correct (plain first, html second). New templates (welcome, role-changed, removed) deferred until their endpoints need them.

### What I did NOT touch (needs design wires before I can start)

- **S7 Organisations admin page** (Ask 1 list ⇄ matrix ⇄ projects) — backend (`/v2/orgs/:id/members`) is ready, UI not.
- **S8 Tier management UI** (Ask 2 compare matrix + Ask 2s staff inline block) — backend ready.
- **S9 Creation wizards** (workspace + project, full multi-step with dry-run preview) — backend accepts the flags; UI blocked on wizard wires.
- **S10 frontend** — the strip on project overview + the share modal.
- **S11 Upgrade prompts** — backend gates fire correctly; UI component (hatched overlay + 4C modal, member-role = no CTA) blocked on wires.
- **S12 Selector polish** — designer has wires; retargeting needs attention to Ask 5's organisation hero + per-row manage. Not touched here.

### Judgment calls made while you were out

Tracked as `# Note:` comments in code at the decision site. Summary:
- Tier-gate auto-wire: added `workspace_tier` kwarg to `has_policy()` and resolve via `TIER_REQUIRED_FOR_POLICY`. Made `policies.py:24-25` include `workspace:set_private` + `project:set_private` so privacy is gated uniformly (matches designer's S1 assumption).
- Organisation-invite endpoint (`POST /v2/orgs/:id/members`) deliberately not built — reused the existing workspace-invite flow with `include_org_membership=true` targeting the organisation's default workspace. Saves a collection + keeps the invite email template single-source.
- `accessible_workspace_count` rollup in `/v2/orgs/:id/members` uses `user_can_access` per (user × workspace) pair — O(U × W) round-trips per list call. Fine at current scale; noted a TODO in-line to batch when a organisation grows past ~50 workspaces.
- Downgrade-effect: `revert` currently only clears `logo_url`. Any new tier-gated feature marked `"revert"` must add its clear-on-downgrade branch to `apply_downgrade_effects()`.
- Email multipart: SendGrid `.add_content()` requires plain-first, html-second order. Wired that way; `_build_message` verified via a unit-style sanity check.
- Onboarding split terminology: used "organisation" in user-facing copy (`Welcome, {name} · Set up your organisation`). "Organisation admin" / "admins follow organisation access" phrasing is consistent with Q6's accepted rename, though the global sweep across older docs hasn't happened yet.

### Things I want your eyes on

1. **Run the local stack and hit the new endpoints** — I didn't start the devcontainer to curl them. The code compiles and imports cleanly; behavior-testing is yours.
2. **Q6 terminology sweep** — I used "follow organisation access" phrasing in new code + comments. Older docs (`inheritance-rules.md`, `workspaces-prd-v3-final.md`) still say "inherit". Low-risk but inconsistent until swept.
3. **Legacy inherited rows migration** — `inheritance-rules.md` specifies a cleanup pass for any `source='inherited'` rows that might exist from older code paths. I didn't run it because nothing today writes those rows anymore (the fan-out code in `POST /v2/workspaces` is gone). If any legacy rows linger they'll just be ignored by derivation. Easy to script later if you want them archived.
4. **Frontend onboarding split** — browser-verify the three copy branches render correctly. Code compiles; visual verification is TODO.

### Still blocked on you / workshop

- 12 questions in "Questions for the organisation (workshop)" section above — all of them still open.
- Design wires for S7/S8/S9/S10-frontend/S11/S12 — the designer's v5 is the dependency.

## Security + correctness audits

Three parallel audit rounds ran against the workspace release. Summary of what landed and what's open.

### What the audits shipped (as code)

- **Upgrade-request XSS hardened.** Staff inbox was receiving raw f-string HTML — rewrote as an autoescaping Jinja template (`upgrade_request.html`), added per-user 5/hr rate limit, strip CR/LF from subject fields.
- **Whitelabel + logo URL validation.** Changing a workspace or organisation logo now fires `require_policy("workspace:whitelabel")` and validates the URL scheme (http/https only, 2048-char cap).
- **Role preset correction.** Admin preset didn't grant any tier-gated policy — only owner (`*`) could. Admins now have `project:set_private`, `workspace:set_private`, `workspace:whitelabel`, `workspace:api_access` — tier still auto-enforced via `has_policy`.
- **Derived model invariants.** Onboarding now writes creator rows as `source='direct'` (was `'inherited'`). Organisation-owner carve-out in `user_can_access` — owners always derive admin on their organisation's workspaces even when private. `DELETE /workspaces/:id/members/:uid` now writes a `sticky_removed` tombstone when the removed user would re-derive access.
- **Null-safety.** `workspace.settings=NULL` on legacy rows no longer 500s — normalised to `{}` before dict ops.
- **Migration.** `scripts/migrate_inherited_to_derived.py` dry-run-by-default, per-host lockfile against concurrent `--apply`, `script_start_iso` cutoff so re-runs don't false-tombstone just-archived rows, defensive handling of corrupted `sticky_removed` JSON.
- **Private-project email leak.** `GET /v2/projects/:id/members` now strips email from non-admin readers on private projects.
- **Gate doesn't mount gated children.** `FeatureGate` previously used `pointer-events: none` which left keyboard-level listeners firing inside the subtree. Now renders a pure placeholder.
- **Upgrade modal double-fire guard.** `disabled={sending}` + early return guard + defensive `detail` stringification.
- **Visibility PATCH pattern match.** `PATCH /v2/projects/:id/visibility` rejects externals, uses the shared access resolver.

### Private-project read enforcement

**Partially closed.** The list → click → open path is genuinely gated now. Enforced at:

- `GET /v2/workspaces/:id/projects` — filters private projects the caller can't see
- `GET /v2/projects/:id` — returns 404 (not 403) on no-access so we don't confirm existence
- `PATCH /visibility` — tier-gated + rejects externals
- Frontend `ProjectAccessGuard` wraps the project detail tree

**Open follow-up:** conversation / chat / report / library fetches go through the **Directus SDK** directly and don't know about visibility. A deep-linked URL to a specific chat or conversation of a private project will still resolve. Fix scope: tighten Directus permissions on `project` / `conversation` / `project_chat` / `project_report` reads to respect `visibility` + `project_membership`. Tracked as its own session.

### Architecture verdict across rounds

All rounds agreed: no auth bypass, no IDOR, no JWT forgery, no cross-tenant leakage. Core derivation + tier wiring is sound.

### Deploy runbook

1. Push Directus schema to prod (`directus/sync.sh push`) so `project.visibility` + `workspace.settings.sticky_removed` fields exist.
2. Dry-run the migration against prod, spot-check ~5 affected rows, then `--apply` **before** merging `workspaces` → `main`.
3. Merge + deploy server + frontend.
4. Set `SENDGRID_API_KEY`, `UPGRADE_REQUEST_INBOX` in prod env before first upgrade-request is triggered.
5. Re-run migration `--apply` once after deploy to post-verify: zero live `source='inherited'` rows.

### Known-and-accepted

- `_rollup_workspace_access` is O(users × workspaces) in the organisations page — fine at current scale, batch-refactor when a organisation passes ~50 workspaces.
- Tier PATCH + concurrent feature use has a sub-second window where a new share can slip in under the old tier. Acceptable for manual-billing; revisit when automated billing lands.
- `on_workspace_created` is two non-transactional Directus writes. Acceptable.
