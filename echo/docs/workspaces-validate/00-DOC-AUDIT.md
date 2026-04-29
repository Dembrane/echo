# Doc audit + repo conventions

Session start: 2026-04-23. Audit of the state I inherited before doing any work.

**Read order for future-you:** `05-PROGRESS.md` → `04-QUESTIONS-FOR-SAMEER.md` → `00-PLAN.md` → this file.

---

## Repo conventions

What the code actually does today, as of branch `workspaces` @ `cfa758e`. These take precedence over anything the matrix or the checklist says — reconcile via `02-DELTA.md`, don't silently "correct" the code.

### Tier names

Match the matrix: `pilot | pioneer | innovator | changemaker | guardian`. Single source: `server/dembrane/policies.py:17` (`TIER_ORDER`). Tier gate map at `policies.py:22-29` (`TIER_REQUIRED_FOR_POLICY`). Tier lives on `workspace.tier`.

### Role names

**Code ≠ matrix.** Matrix says `Admin / Billing / Member / Guest`. Code says:
- Workspace roles: `owner / admin / member / viewer` (`policies.py:53-93`).
- Org roles: `member / admin / owner` (`policies.py:34-48`).
- Project share roles: `viewer / editor` (`policies.py:98-114`).
- "Guest" in the matrix = `workspace_membership.is_external=true` in code. No role called `guest`.
- **No `billing` role anywhere** in code. Matrix introduces it as a new axis.

Brief says rename at UI only; don't touch DB fields. That stays true for `is_external` and `owner/admin/member/viewer` enum values. `billing` role is *new* and will need schema — open question, see `04-QUESTIONS-FOR-SAMEER.md`.

### Staff

Implemented as `auth.is_admin` (Directus Administrator JWT claim), surfaced to frontend via `/v2/me.is_staff` (`server/dembrane/api/v2/me.py:40,92,142`). Matrix v1.1 introduces a narrower `staff:can_set_tier` policy — not yet in code.

### Upgrade inbox

- Env var: `UPGRADE_REQUEST_INBOX` (`server/dembrane/settings.py:337-343`).
- **Default today:** `sameer@dembrane.com`.
- Matrix v1.1 default: `upgrades@dembrane.com`. Switch default + ship inbox before cutover.

### Visibility / discovery model — the big divergence

Code stores two booleans in `workspace.settings`:
- `inherit_organisation_admins` (default true) — drives derived admin access
- `inherit_organisation_members` (default false) — drives derived member access
- `sticky_removed` — JSON tombstones in `workspace.settings`

Plus `dembrane/inheritance.py` with `user_can_access` that walks org membership to derive access at query time. Migration + audit rounds already hardened this path (see `docs/workspaces/inheritance-rules.md` and `scripts/migrate_inherited_to_derived.py`).

Matrix v1.1 retires all of this. Replacement model:
- Single `workspace.visibility` enum: `open_to_organisation | private`.
- Access is direct-only — no derivation walker.
- Organisation admins "Join" an open/private workspace via explicit action → writes `source='direct', role='admin'` row.
- Organisation members "Request access" on open workspaces → admin approves → writes `source='direct', role='member'`.
- `sticky_removed` retires; rejoins are normal explicit actions.

**Prerequisite:** backfill explicit Admin rows for anyone currently surviving on derived access. Stop-condition work — Sameer confirms affected row count before apply. See `flows/derivation-walkback.md` (to be written).

### Notification event codes (live)

Grep'd from `server/dembrane/` — emit sites across `invites.py / me.py / onboarding.py / orgs.py / project_sharing.py / projects.py / workspace_settings.py / workspaces.py / tasks.py`:

```
WORKSPACE_CREATED          WORKSPACE_ADDED             WORKSPACE_REMOVED
WORKSPACE_ROLE_CHANGED     ORGANISATION_MEMBER_ADDED           ORGANISATION_ROLE_CHANGED
ORGANISATION_REMOVED               INVITE_ACCEPTED             INVITE_DECLINED
INVITE_CANCELLED           PROJECT_NOW_PRIVATE         PROJECT_NOW_WORKSPACE
PROJECT_SHARE_ADDED        PROJECT_SHARE_ROLE_CHANGED  PROJECT_SHARE_REVOKED
REPORT_READY               REPORT_FAILED               UPGRADE_REQUEST_SENT
TIER_DOWNGRADED
```

Severity map + `emit()` flow at `server/dembrane/notifications.py`. Dual channel (inbox + email) is the established pattern; don't invent a new one.

**Matrix expects additions** (per brief "Notifications enum + in-app bell" bullet):
- `MEMBERSHIP_REQUESTED` (member → admins, request-to-join an open workspace)
- `MEMBERSHIP_REQUEST_APPROVED` / `MEMBERSHIP_REQUEST_REJECTED`
- `UPGRADE_REQUEST_ACTIONED` (approved / denied)
- `PAYMENT_FAILED` (placeholder — payments are manual this release; may log only)
- `QUOTA_AT_80` / `QUOTA_AT_95` / `QUOTA_AT_100`
- `PARTNER_HANDOFF_PENDING` / `PARTNER_HANDOFF_ACCEPTED`

Keep wiring through `emit()` / `emit_to_audience()` (`notifications.py:102-272`). Source code is mid-refactor in the uncommitted working tree (`M server/dembrane/notifications.py` ~170 lines changed) — confirm with Sameer before touching.

### Soft-delete pattern

`deleted_at IS NULL` on every read. Applies to `project / conversation / project_chat / project_report / webhook / tag / workspace / org_membership / workspace_membership`. Destructive actions set the timestamp; hard-delete permission removed from Basic User (`24b94f9`). Honor this — never `DELETE FROM`.

### Policy enforcement pattern

- Roles: `ctx.require_policy("…")` in `server/dembrane/api/v2/middleware.py`.
- Tiers: auto-enforced via `has_policy(..., workspace_tier=...)` + `TIER_REQUIRED_FOR_POLICY`. Don't add new `require_tier()` calls per-endpoint; extend the map.
- Staff: `auth.is_admin` on the session JWT.
- Downgrade effects: `dembrane/tier_downgrade.py` → `DOWNGRADE_EFFECTS` map + `apply_downgrade_effects()`. New `"revert"` branches land here.

### Frontend route shape

- `/:locale/w/:workspaceId/...` — workspace-scoped (routes under `frontend/src/routes/`)
- `/:locale/o/:organisationId` — organisation admin page (matrix view, `OrganisationRoute.tsx`, 534 lines)
- Workspace selector (home) — `WorkspaceSelectorRoute.tsx`, 442 lines. Already has organisation hero, avatar bubbles, per-row manage (Ask 5 shipped).
- Workspace settings — `WorkspaceSettingsRoute.tsx`, 893 lines, one page (tabs not yet split).
- Workspace create — `CreateWorkspaceRoute.tsx`, 271 lines, **single-step form** (wizard not yet built).
- Inbox drawer — `frontend/src/components/inbox/Inbox.tsx`, 420 lines.
- FeatureGate + UpgradeModal — `frontend/src/components/workspace/FeatureGate.tsx`, 318 lines (S11 shipped).
- Onboarding — `frontend/src/routes/onboarding/OnboardingRoute.tsx`.

### i18n

`@lingui/core/macro` with `<Trans>` + `t\`\`` template. Locales at `frontend/src/locales/` for en-US / nl-NL / de-DE / fr-FR / es-ES / it-IT. Flow: `pnpm messages:extract` → edit .po → `pnpm messages:compile`. Dutch is informal (je/jij).

### Branch state

Current branch: `workspaces`. Unpushed. Commits ahead of `main` since autonomous run:

Autonomous baseline (per checklist "Session status" section):
`94cf40d 818c774 9736a2c 43f8649 4141262 e26d725 c51a7e0 e66c483 00613dd`
+ audit/security passes `15c7d1a 2f543ac ff93e68 0120a72 f2bfb2f 0cbb3b9`.

On top (brief's "8 prior" is out of date — these shipped too):
```
001ef0a feat: S10 private project sharing UI + visibility toggle endpoint
d042a85 feat: S11 tier-gate FeatureGate + UpgradeModal components
f2cf0a0 feat: S12 selector polish — organisation hero + hover-manage + guest-of pills
8aba15d fix: round-2 audit — 7 of 8 critical/high findings addressed
4646825 feat: private projects — read-time enforcement on common surfaces
deb6597 fix(workspace): security + footgun pass from audits
a85d2fe feat(workspace): organisation page, sharing tab, access bubbles, /w URL, hard rules
997ab26 feat(workspace): /o/ organisation route, settings pages, emails in lists, audit fixes
505ba73 feat(ux): dotted +workspace card, /w sweep, audit fixes
b71a2d7 feat(inbox): notifications table + service + emit backfill
1b2ed00 feat(inbox): notifications drawer + more emit coverage
00b3218 feat(inbox): more emit sites + dead-code sweep
cfa758e feat(inbox): close INVITE_ACCEPTED + ORGANISATION_MEMBER_ADDED on remaining paths
```

**Uncommitted work (tree state at session start):**

Modified (in-flight — do not disturb without checking with Sameer):
- `server/dembrane/notifications.py` (~170 lines rewrite), `server/dembrane/api/v2/notifications.py` (~263 lines rewrite), `server/dembrane/tasks.py` (1 line)
- `server/email_templates/` — all 4 existing templates plus `_layout.html`
- `directus/templates/` — all 6 Liquid templates
- `frontend/src/components/project/ProjectListItem.tsx / ProjectSharingModal.tsx / ProjectSharingStrip.tsx`
- `frontend/src/components/layout/Header.tsx`
- `frontend/src/hooks/useNotifications.ts`, `frontend/src/routes/auth/Register.tsx`, `CheckYourEmail.tsx`
- `frontend/src/routes/organisation/OrganisationRoute.tsx` (3 lines)
- `frontend/src/components/auth/hooks/index.ts`
- `scripts/create_schema.py` (~136 lines), `scripts/preseed_workspace.py`
- `docs/workspaces/release-checklist.md`

Deleted:
- `frontend/src/components/announcement/` — 6 files (announcements dead-code sweep)
- `frontend/src/components/notifications/NotificationsDrawer.tsx` (replaced by `inbox/Inbox.tsx`)

New (untracked):
- `docs/workspaces-validate/` — this dir
- `frontend/src/components/inbox/` — new inbox dir (`Inbox.tsx` committed in `b71a2d7`; directory itself looks untracked because index files may be)
- `frontend/src/lib/avatar.ts` — used by `OrganisationRoute.tsx` and `WorkspaceSelectorRoute.tsx`

`git diff --stat` shows -1921 / +703 — net -1218 lines. Announcement + old-drawer removal dominates. **Confirm with Sameer whether this uncommitted tree represents "in progress, resume" or "abandoned, revert" before I build on top of it.**

---

## Inventory of related docs

### Already treated as canonical (do not duplicate)

| Path | Role |
|---|---|
| `docs/workspaces-validate/matrix.md` | Customer contract — source of truth for behavior |
| `docs/workspaces/release-checklist.md` | Engineering ground truth for build status |
| `brand/STYLE_GUIDE.md` | Copy + color + component conventions |
| `brand/README.md` | Short brand summary |
| `CLAUDE.md` (repo root) | Standing organisation instructions — overrides briefs on conflict |

### Live companion design docs (referenced from matrix + checklist)

| Path | Treat as |
|---|---|
| `docs/workspaces/designer-return.html` | Visual wires for Asks 1–5 (designer v2) |
| `docs/workspaces/designer-brief-v2.md` | Sameer → designer clarification asks |
| `docs/workspaces/designer-brief.md` | Original v1 brief — superseded by v2 |
| `docs/workspaces/workspaces-prd-v3-final.md` | Product requirements v3 |
| `docs/workspaces/inheritance-rules.md` | **Stale vs matrix v1.1.** Matrix retires derivation; this doc codifies it. Keep until the walk-back lands, then archive. |
| `docs/workspaces/execution-plan-final.md` | Autonomous-run plan — historical |
| `docs/workspaces/architecture-review.md` | Pre-autonomous arch notes — historical |
| `docs/workspaces/codebase-exploration-report.md` | S1 exploration — historical |
| `docs/workspaces/failure-analysis.md` | Risk register — check before shipping |
| `docs/workspaces/gate-check-protocol.md` | Session-by-session ship criteria |
| `docs/workspaces/gripes.md` | Designer/developer complaints — useful signal |
| `docs/workspaces/inbox.html` | Designer spec for inbox — implementation in `frontend/src/components/inbox/` |
| `docs/workspaces/reference.md` | Feature tree reference |

### Supporting engineering docs

| Path | Role |
|---|---|
| `docs/branching_and_releases.md` | Branch → release flow |
| `docs/database_migrations.md` | Directus migration pattern |
| `docs/directus_sdk_patterns.md` | Python + TS Directus SDK idioms |
| `docs/frontend_translations.md` | i18n workflow |
| `docs/style-guides/` | More component-level guides |

### This session's working docs (this folder)

| Path | Role |
|---|---|
| `matrix.md` | Contract, read-only |
| `00-DOC-AUDIT.md` | This file |
| `00-PLAN.md` | Working plan |
| `02-DELTA.md` | Gap analysis |
| `03-DECISIONS.md` | Append-only log |
| `04-QUESTIONS-FOR-SAMEER.md` | Pending + answered |
| `05-PROGRESS.md` | Rolling status |
| `flows/` | One per user flow |
| `screens/` | One per canonical screen pattern |
| `migration/` | M1–M6 specs |

---

## Key files to know (cross-reference index)

Server:
- `server/dembrane/policies.py` — tier + role matrix
- `server/dembrane/inheritance.py` — derivation resolver (pending retirement)
- `server/dembrane/tier_downgrade.py` — DOWNGRADE_EFFECTS map
- `server/dembrane/notifications.py` — emit() + audience helpers (in flux)
- `server/dembrane/settings.py` — env vars incl. UPGRADE_REQUEST_INBOX
- `server/dembrane/api/v2/middleware.py` — `get_workspace_context`, `user_can_access` wiring
- `server/dembrane/api/v2/me.py` — `/v2/me`, `is_staff`, pending invites, notifications list
- `server/dembrane/api/v2/workspaces.py` — CRUD + tier PATCH + upgrade-request
- `server/dembrane/api/v2/workspace_settings.py` — member mgmt, invites, role change
- `server/dembrane/api/v2/orgs.py` — organisation endpoints
- `server/dembrane/api/v2/project_sharing.py` — per-project CRUD (innovator+)
- `server/dembrane/api/v2/onboarding.py` — onboarding-complete
- `server/dembrane/api/v2/invites.py` — HMAC token invites
- `server/email_templates/` — Jinja templates extending `_layout.html`
- `scripts/create_schema.py` — Directus schema builder (idempotent)
- `scripts/migrate_inherited_to_derived.py` — historical migration (to be reused/retired)

Frontend:
- `frontend/src/routes/workspaces/WorkspaceSelectorRoute.tsx` — home
- `frontend/src/routes/workspaces/WorkspaceSettingsRoute.tsx` — one-page settings
- `frontend/src/routes/workspaces/CreateWorkspaceRoute.tsx` — single-step create
- `frontend/src/routes/organisation/OrganisationRoute.tsx` — organisation admin matrix
- `frontend/src/routes/organisation/OrganisationSettingsRoute.tsx` — organisation settings
- `frontend/src/routes/onboarding/OnboardingRoute.tsx` — new-vs-legacy onboarding
- `frontend/src/components/workspace/FeatureGate.tsx` — tier-gate overlay + upgrade modal
- `frontend/src/components/inbox/Inbox.tsx` — notifications drawer
- `frontend/src/components/project/ProjectSharingStrip.tsx` + `ProjectSharingModal.tsx` — Ask 3 UI
- `frontend/src/hooks/useNotifications.ts`, `useV2Me.ts`, `useWorkspace.ts`, `useMyInvites.ts` — core data hooks
- `frontend/src/lib/avatar.ts` — avatar URL helper

Directus:
- `directus/sync/snapshot/` — schema snapshot (committed after `sync.sh pull`)
- `directus/templates/` — transactional email Liquid templates (separate from product emails in `server/email_templates/`)
