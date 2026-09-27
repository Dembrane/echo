# Access model: current state (echo main 9f42cfdd)

Scope: every way a caller is identified and authorised in echo today, written so the Bun platform can reproduce it 1:1 without reading the Python. Where today's behaviour is a hole, the spec says so and gives the fix; the migration should reproduce the intended rule, not the hole.

Sources: `echo/server/dembrane` (unchanged between 9f42cfdd and this branch), `echo/directus/sync/collections`, `echo/frontend/src`, `echo/agent`, `echo-gitops/helm/echo`, and read-only checks against prod Directus on 2026-09-27 (permissions, policies, roles, settings, user counts). Route inventory: `~/server/data/echo-migration/endpoints.txt` (443 routes).

Citation convention: paths are relative to `echo/server/dembrane/` unless prefixed. `_access.py` means `api/v2/bff/_access.py`.

Shorthand used throughout:

| Short | Meaning | Where |
|---|---|---|
| SESSION | `require_directus_session`: valid Directus HS256 JWT | `api/dependency_auth.py:52-109` |
| LADDER | `get_user_project_access` returns a role (any role) | `inheritance.py:572-673` |
| RPA | `resolve_project_access`: app_user required, project not deleted, LADDER non-null. Requires NO policy | `_access.py:178` |
| RPA(p) | RPA then `access.require(p)` | `_access.py:113-128` |
| RCA | `resolve_conversation_access`: RPA on parent + `conversation:read` | `_access.py:223-237` |
| RCHAT | `resolve_chat_access`: RPA on parent + `chat:use` | `_access.py:257-267` |
| RREP | `resolve_report_access`: RPA on parent + `report:view` | `_access.py:289-299` |
| VPA | v1 `_verify_project_access`: staff short-circuit, else LADDER non-null (any role) | `api/project.py:599-635` |
| WS | `get_workspace_context`: app_user, workspace not deleted, `resolve_workspace_access` non-null | `api/v2/middleware.py:66-131` |
| WS(p) | WS then `ctx.require_policy(p)` | `api/v2/middleware.py:53-55` |
| ORG(min) | `orgs._require_org_role`: active org_membership with role at or above min (member accepts any role incl. billing) | `api/v2/orgs.py:191-218` |
| STAFF | `auth.is_admin` (JWT `admin_access` claim) | `api/dependency_auth.py:93` |

---

## 1. Principals

Route counts by auth class (endpoints.txt): SESSION 372, PARTICIPANT 27, AGENT-OAUTH 15, PUBLIC 9, PUBLIC-TOKEN 8, PUBLIC(oauth) 7, PUBLIC(docs, dev only) 3, MCP-OAUTH 1, Mollie webhook 1.

### 1.1 User session (dashboard user)

- Login is done by the browser directly against Directus (`@directus/sdk`, `authentication("session", {credentials:"include"})`, `frontend/src/lib/directus.ts:6-13`). Email+password (+OTP if the user enabled TFA, `routes/auth/Login.tsx:98-112`). Google SSO exists but `AUTH_GOOGLE_ALLOW_PUBLIC_REGISTRATION=false` and its default role id `2446660a-...` does not exist on prod (`echo-gitops/helm/echo/values-prod.yaml:69-70`).
- Cookie: Directus session cookie, name from `SESSION_COOKIE_NAME` = `dembrane_session_token` on prod, domain `dembrane.com`, SameSite `lax`, `SESSION_COOKIE_SECURE` set to the invalid value `"lax"` (`echo-gitops/helm/echo/templates/deployment-directus.yaml:114-124`). Server reads the same name via `DIRECTUS_SESSION_COOKIE_NAME` (default `directus_session_token`, `settings.py:305-311`).
- Server verification (`api/dependency_auth.py:52-109`):
  1. Token = cookie if present and non-blank, else `Authorization: Bearer <t>`. Cookie wins over the header.
  2. `jose.jwt.decode(token, DIRECTUS_SECRET, algorithms=["HS256"])`. Signature and `exp` are checked. `iss`, `aud`, `session` claim and `directus_sessions` row are NOT checked, so logout and suspension do not revoke until `exp`.
  3. Claims used: `id` (Directus user id, required) and `admin_access` (bool, default false). `role`, `app_access` are ignored.
  4. The raw token is kept on the session and used only for Directus self-service proxies (`api/user_settings.py:94-261`, password and TFA) and forwarded to the agent service (`api/agentic.py:192-197`). All data access uses the superuser client `directus`/`async_directus` (`directus.py:950`).
- Lifetimes: gitops sets no `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL` or `SESSION_COOKIE_TTL`, so Directus 11.13 defaults apply (15m access, 7d refresh, 1d session cookie). The SDK auto-refreshes (`autoRefresh: true`). Confirm by decoding a live cookie before copying numbers.
- App identity: Directus user id maps to `app_user.id` via `app_user.directus_user_id` (unique, `app_user.py:289-312`). v2 and BFF routes 403 "User not onboarded" when no app_user row exists. `app_user.email` is copied once from `directus_users.email` at onboarding and never updated (`api/v2/onboarding.py:105-125`).
- Registration: `POST /api/v2/auth/register` proxies to Directus `/users/register` (always 204, IP rate limit, `api/v2/auth.py:274-343`). Directus settings on prod: `public_registration=true`, role Basic User, `public_registration_verify_email=true`, login attempts 25, password policy `/^.{8,}$/`.

### 1.2 Staff (Directus administrator)

- Any JWT with `admin_access=true`: users in the Administrator role (8 on prod) or with the Administrator policy attached directly (2 on prod). `STAFF` checks are the only staff model. `STAFF_POLICIES` (`policies.py:44-48`) are declared and never read.
- Staff pass all `admin*` routes, v1 short-circuits (VPA, chat, conversation, agentic, webhooks, verify custom topics, stateless), billing of any org, workspace creation in any org, tier change. BFF has no staff bypass: staff without an app_user get 403, with an app_user but no membership get 404.
- No impersonation endpoint exists. Closest: `POST /api/v2/admin/workspaces/{id}/change-admin` (`api/v2/admin.py:1530`).

### 1.3 Staff with support access (staff_support membership)

- A `workspace_membership` row with `role=admin`, `source=staff_support`, `expires_at=now+24h` (`support_access.py:23, 78-192`). Resolved like any direct row; expiry enforced at read time in `_get_direct_membership` (`inheritance.py:138-160`). Full admin preset. Excluded from member lists and seat counts (`inheritance.py:355, 428`). Details in section 4.2.

### 1.4 Participant (portal, no auth)

- No credential. The UUID in the path is the capability: project id (initiate, portal config, published reports, visitor ping) or conversation id (upload, ping, finish, get-reply, verify). The only project flag checked is `is_conversation_allowed` (plus `is_get_reply_enabled` for get-reply). Details and holes in 6.2 and 7.
- The portal also reads Directus directly as anonymous (`directusParticipant`, `frontend/src/lib/directus.ts:20-22`); only `conversation_reply` read (public policy) is used.

### 1.5 Report subscriber token holder

- `project_report_notification_participants.email_opt_out_token` + project id authorise unsubscribe and eligibility (`api/participant.py:1303, 1351`).

### 1.6 Invite link holder

- No stored token. Link hash = `HMAC-SHA256(DIRECTUS_SECRET, invite_id)[:32 hex]` (`api/v2/invites.py:40-47`). Used by public `GET /api/v2/auth/invite-status` (email + hash, IP rate limit, `api/v2/auth.py:76-240`) and by signed-in `accept-by-hash` which additionally requires `invite.email == app_user.email` (`api/v2/me.py:1388-1500`). Rotating `DIRECTUS_SECRET` invalidates every invite link, every session and every stored agent client secret.

### 1.7 Agent OAuth token (REST `/api/v2/agent/*`)

- Opaque bearer `dbr_at_<token_urlsafe(32)>`, refresh `dbr_rt_...` (`agent_access/__init__.py:37-38`, `agent_access/store.py:67`). Stored as SHA-256 hex in `agent_token` (token_hash unique, kind, pair_id, grant_id, expires_at, revoked_at) (`store.py:63, 239-299`).
- TTLs: access 1h, refresh 30d, auth code 5 min, parked authorize request 10 min (`agent_access/__init__.py:27-30`). Refresh rotates the pair; no reuse detection (`agent_access/oauth.py:418-437`).
- Grant (`agent_grant`): app_user_id, directus_user_id, client_id, org_ids[], scopes (`read`, `write`; read always added), expires_at 30/90/365 d chosen at consent, revoked_at (`api/v2/agent_access.py:302-305`).
- Identity: impersonates the granting user with `is_admin=False` (`agent_access/context.py:108-121`). Each tool runs the dashboard resolvers as that user, then `require_org` (org in grant.org_ids and `org.agent_access_enabled`, Redis cache 60s), then `charge` (free org 1000 calls/month), then writes `agent_audit_event` (`context.py:58-105, 152-193`). `write` scope is enforced only on update_project (`agent_access/tools.py:507`).

### 1.8 MCP client (`/api/mcp`)

- MCP SDK authorization server: `/api/mcp/authorize`, `/token`, `/register`, `/revoke` and well-known metadata (`agent_access/mcp_server.py:632-690`). Dynamic client registration open, no auth, no rate limit (`oauth.py:270-274`). Public clients allowed. PKCE S256 mandatory; redirect_uri must match a registered one (any host).
- Consent: authorize parks the request in Redis, redirects to `{ADMIN_BASE_URL}/settings/agents/authorize?request=`; the signed-in user approves via `POST /api/v2/agent-access/authorize-requests/{rid}/approve`, which creates the grant for the approver and intersects requested orgs with the approver's orgs that have agent access on (`api/v2/agent_access.py:146-167, 295-333`).
- Transport: `RequireAuthMiddleware(required_scopes=["read"])`, same tokens and tool functions as REST (`mcp_server.py:646-657`).

### 1.9 Popcorn / Present share token

- `project_report.public_token = secrets.token_urlsafe(24)`, plaintext, minted when `settings.public` first becomes true, never rotated (`popcorn/service.py:776, 1174-1181`). Honoured while: token matches `^[A-Za-z0-9_-]{16,64}$`, report kind matches and not deleted, project not deleted, feature flags on, `settings.public` true (`api/v2/popcorn_public.py:60-74`). No expiry, no identity; reads via superuser client.

### 1.10 Mollie webhook

- `POST /api/v2/billing/mollie/webhook`: no signature. Takes form field `id`, refetches the payment from Mollie with our key, routes on our own metadata (`api/v2/billing.py:389-397`, `billing_service.py:2102-2127`). Trust comes from the refetch.

### 1.11 Website pricing writer

- `POST /api/v2/pricing-configurations/site`: `X-Site-Token` compared with `compare_digest` to `settings.site.api_token`, 503 if unset (`api/v2/pricing_configurations.py:446-461`).

### 1.12 Agent service (internal hop)

- Server calls `echo/agent` with `Authorization: Bearer <user's Directus JWT>` plus `X-Dembrane-Docs-Base-Url`, `-Chat-Id`, `-App-User-Id`, `-Message-Id`, `-Canvas-Enabled` (`agentic_client.py:121-136`). The agent does not verify the JWT (`agent/auth.py:20-25`), trusts every `x-dembrane-*` header (`agent/main.py:63-69`), and forwards the JWT on its callbacks to the server (`agent/echo_client.py:115-119`). Prod ingress shows no external hits, so it is internal-only by network, not by auth.

### 1.13 Anonymous

- Public routes: health, stats (10/min per X-Forwarded-For IP), tier-capacities, invite-status, register, OAuth metadata, docs (dev only), `conversations/health/stream`, `stateless/webhook/transcribe` (no-op). Plus Directus public policy (see 3).

---

## 2. Resources, hierarchy and roles

### 2.1 Hierarchy

```
org
 └─ workspace            (visibility: open_to_organisation | invite_only | private; billing_account_id NOT NULL)
     └─ project          (visibility: workspace | private; workspace_id NULL = legacy)
         ├─ conversation ─ conversation_chunk, conversation_reply, conversation_artifact, conversation_project_tag
         ├─ project_chat ─ project_chat_message
         ├─ project_report (kind: report | canvas | popcorn/present) ─ project_report_metric
         ├─ project_tag, project_analysis_run, analysis objects/revisions, map results, webhooks, goals
         └─ agent memory (scope user | project | workspace), insights, runs
billing_account (tier lives here, not on workspace)
```

Tier resolution: `resolve_workspace_tier` (`billing_account.py`); `get_workspace_context` merges billing fields into `ctx.workspace` so `ctx.workspace["tier"]` is the account tier (`middleware.py:99-103`). Tiers: free, innovator, changemaker, guardian (`tier_capacity.py:66-110`, `policies.py:21`). Legacy literals `pilot`, `pioneer` are still accepted by staff set-tier and used as defaults; `meets_tier` returns false for them (`policies.py:266-271`). A NULL tier (legacy project, no workspace) skips every tier gate (`policies.py:261`).

### 2.2 Membership tables

| Table | Key fields | Roles | Delete | Uniqueness |
|---|---|---|---|---|
| `directus_users` | id, role, status, email, tfa_secret | Directus roles (section 3) | status=suspended on account delete (`api/user_settings.py:513`) | |
| `app_user` | id, directus_user_id, email, display_name | none | none | directus_user_id unique |
| `org_membership` | org_id, user_id (app_user), role, custom_policies (never read), deleted_at | member, admin, billing, owner (`orgs.py:76`) | soft (deleted_at); reinvite reactivates (`orgs.py:1285-1300`) | one active per (org,user) |
| `workspace_membership` | workspace_id, user_id, role, source, custom_policies, expires_at, deleted_at | owner, admin, member, billing, external, observer; legacy `viewer` read as member (`policies.py:185-205`) | soft; reinvite reactivates without clearing expires_at (`invites.py:392-397`) | one active per (ws,user) |
| `project_membership` | project_id, user_id, role (default 'editor', ignored), custom_policies (ignored), granted_by | none effective | hard delete of rows[0] (`project_sharing.py:470-479`) | none |
| `org_invite` / `workspace_invite` | email, role, expires_at (7d), accepted_at, deleted_at, invited_by; workspace_invite.project_id | as table | soft | none |
| `access_request` | user_id, workspace_id, status, actioned_by | | soft | |
| `support_access_request` / `support_access_event` | see 4.2 | | | |
| `agent_grant` / `agent_token` | see 1.7 | | revoked_at | token_hash unique |

`workspace_membership.source`: `direct` (default), `staff_support`. `inherited` is computed only, never stored (`inheritance.py:1-21`).

`custom_policies`: no API writes them (Directus admin only); values unvalidated; `'*'` grants everything (`policies.py:208-217, 256`). Several checks ignore them by passing `[]` or comparing raw role strings (7.x).

### 2.3 Resolution algorithm (reimplement exactly)

**Workspace role** `resolve_workspace_access(workspace, user)` (`inheritance.py:314-339`; same as `user_can_access` 271-311):

1. Workspace soft-deleted: none.
2. Active direct row (`deleted_at IS NULL` and `expires_at` null or in the future): (row.role, `direct`, row). Direct always wins, even if lower than the derived role.
3. No org_id: none.
4. `derive_workspace_role(workspace, org_role, user)` (`inheritance.py:83-116`):
   1. user in `workspace.settings.sticky_removed[]`: none (applies to owners too).
   2. org role `owner`: `admin` on every visibility.
   3. visibility != `open_to_organisation`: none.
   4. org role `admin`: `admin`.
   5. org role `member` and `settings.inherit_organisation_members == true` (legacy flag): `member`.
   6. otherwise none. Org `billing` never derives workspace access.
5. Derived: (role, `inherited`, null). Inherited rows carry no custom_policies.

**Project role** `get_user_project_access(project, user)` (`inheritance.py:572-673`):

1. Project missing or soft-deleted: none.
2. `workspace_id` null and `project.directus_user_id == caller directus id`: (`owner`, `legacy`). Legacy projects have no other path; no tier gates apply.
3. `workspace_id` null otherwise: none.
4. Workspace role none: none (shares never cross workspaces).
5. `visibility` (null treated as `workspace`) = `workspace`: workspace role verbatim.
6. `private`: workspace `admin`/`owner` keep access (source `workspace`); anyone else needs a `project_membership` row (source `project_share`), and the returned role is still the workspace role.

Important: step 5 returns `billing`, `observer`, `external` as-is. LADDER, RPA and VPA do not require `project:read`, so every caller that does not add a policy lets workspace billing users reach project data (holes H-8, M-4..M-6).

**Effective policies** = `WORKSPACE_ROLE_PRESETS[role] + custom_policies`; `'*'` matches all; tier gate from `TIER_REQUIRED_FOR_POLICY` is applied when a tier is passed (`policies.py:240-263`). BFF and v2 always pass the tier; code that calls `has_policy(role, [], ...)` directly sometimes passes `tier or 'pioneer'` (always fails gated policies).

**Soft delete**: resolvers 404 on `deleted_at` for project, conversation, chat, report and workspace, and recheck the parent for chunk, tag, message, run (`_access.py:1-50` docstring, 178-340). v1 VPA also 404s. Participant get-reply and verify helpers do not check conversation `deleted_at`.

**Status codes**: no access is 404 (hide existence), policy denial after access is 403, tier denial is 403 with `"This action requires the {tier} tier"` (`_access.py:113-128`). WS returns 403 on no access, 404 on missing workspace.

### 2.4 Workspace role presets (`policies.py:99-172`)

| Policy | observer | external | member | billing | admin | owner | Tier gate | Enforced anywhere |
|---|---|---|---|---|---|---|---|---|
| project:read | Y | Y | Y | - | Y | Y | | yes (12 sites) |
| project:create | - | - | Y | - | Y | Y | | yes |
| project:update | - | Y | Y | - | Y | Y | | yes (58 sites) |
| project:delete | - | - | - | - | Y | Y | | BFF only |
| project:share | - | - | - | - | Y | Y | innovator | yes |
| project:set_private | - | - | - | - | Y | Y | innovator | yes (1 real) |
| project:move | - | - | - | - | Y | Y | | no (raw role check instead) |
| conversation:read | Y | Y | Y | - | Y | Y | | yes |
| conversation:delete | - | - | Y | - | Y | Y | | v1 only |
| chat:use | - | Y | Y | - | Y | Y | | yes |
| report:view | Y | Y | Y | - | Y | Y | | yes |
| report:generate | - | Y | Y | - | Y | Y | | v1 create-report |
| report:publish | - | - | Y | - | Y | Y | | v1 update-report status only |
| report:delete | - | - | - | - | Y | Y | | no |
| member:invite | - | - | - | - | Y | Y | | yes |
| member:manage | - | - | - | - | Y | Y | | yes |
| settings:manage | - | - | - | - | Y | Y | | yes |
| workspace:view_usage | - | - | Y | Y | Y | Y | | yes |
| workspace:view_invoices | - | - | - | Y | Y | Y | | yes (usage € fields) |
| workspace:update_payment | - | - | - | Y | Y | Y | | no (billing uses org roles) |
| workspace:export | - | - | - | - | Y | Y | innovator | no |
| workspace:set_private | - | - | - | - | Y | Y | innovator | yes |
| workspace:whitelabel | - | - | - | - | Y | Y | changemaker | yes |
| workspace:api_access | - | - | - | - | Y | Y | changemaker | no |
| workspace:webhooks | - | - | - | - | Y | Y | changemaker | yes |
| upgrade:request | - | - | - | Y | Y | Y | | no |

Owner = `*`. Role hierarchy for escalation guards: observer 0, external 1, member 2, billing 3, admin 4, owner 5 (`policies.py:230-237`).

### 2.5 Org roles

`ORG_ROLE_PRESETS` (`policies.py:53-77`) are dead code: nothing reads them. Effective org rules are hardcoded role lists:

| Capability | member | billing | admin | owner | Cite |
|---|---|---|---|---|---|
| View org, list members (emails only admin/owner) | Y | Y | Y | Y | `orgs.py:586, 753-767` |
| Org usage (all workspaces incl. private) | Y | Y | Y | Y | `orgs.py:2346-2372` (hole M-9) |
| Edit org, logo | - | - | Y | Y | `orgs.py:610, 673, 731` |
| Invite to org (role at or below own, workspace hierarchy) | - | - | Y | Y | `orgs.py:1206-1240` |
| Change member role | - | - | Y (not to/from owner) | Y | `orgs.py:1955-2110` |
| Remove member (owner only by owner, last owner protected) | - | - | Y | Y | `orgs.py:2113-2260` |
| List all org projects | - | - | Y | Y | `orgs.py:2637-2653` |
| Referral ledger | - | Y | Y | Y | `orgs.py:2774-2793` |
| Create workspace in org | - | - | Y | Y | `workspaces.py:679-840` |
| Self-join any workspace as admin (any visibility) | - | - | Y | Y | `access_requests.py:199-285` |
| Request access to open workspace | Y | Y | - | - | `access_requests.py:288-400` |
| Approve access requests | - | - | Y | Y | `access_requests.py:120-185` |
| Billing (org or workspace accounts in org) | - | Y | Y | Y | `billing.py:28, 68-84` |
| Enable agent access, manage org grants | - | - | Y | Y | `agent_access.py:377-433` |
| Workspace handoff initiate/cancel/accept | - | - | Y | Y | `workspaces.py:1757-1985` |
| Derived workspace role | none (legacy flag: member) | none | admin if open | admin always | `inheritance.py:83-116` |

Insider/outsider invariant: a user is an outsider in an org when org role is not admin/owner/billing, has an external/observer row and no internal row (`inheritance.py:230-246`). Billing-only: org role billing, or workspace billing rows with no operational row (`inheritance.py:249-268`). Access-request approval grants `billing` to billing-only users, else `member`.

---

## 3. Directus layer

### 3.1 Roles and policies (repo sync = prod, checked 2026-09-27)

| Role | Policies | Prod users |
|---|---|---|
| Administrator | Administrator (admin_access, app_access) | 8 (+2 users with the policy attached directly) |
| Basic User | Basic User Policy (app_access) | 687 (public registration role) |
| Enterprise User | none of its own; child of Basic User | 1 |
| Read-Only (two rows on prod) | none | 5 |
| (no role) | public only | 42 (19 active, 23 suspended) |

Policies: Administrator; Basic User Policy; `$t:public_label` (anonymous); 2FA (`enforce_tfa=true`, attached to nobody; 3 users enabled TFA voluntarily); "Views Pipeline Processing" and "Can read current user activity" (attached to nobody).

Server code never references a Directus role id. It only reads `admin_access` from the JWT. Every server read and write uses the static superuser token (`settings.directus.token`), so no server authorization depends on Directus permissions. Directus permissions matter only for (a) the browser's direct SDK calls and (b) anyone calling `directus.dembrane.com` REST directly with their own session, which every self-registered user can do.

### 3.2 Permission rows (47 in sync, 67 on prod incl. system rows)

Administrator policy: full CRUD on `org_invite`, `workspace_invite`, `referral_ledger` (redundant with admin_access).

Basic User Policy:

| Collection | Action | Row filter | Notes |
|---|---|---|---|
| announcement | read | expires_at >= now or null | frontend reads |
| announcement | update | activity.user_id = me | |
| announcement_activity | CRUD | user_id = me (create has validation only) | frontend writes |
| announcement_translations | read | none | |
| languages | read | none | |
| conversation_artifact | create/read/update | conversation.project.directus_user_id = me (legacy owner) | read/update filter, create validation |
| conversation_link | read | source.project.directus_user_id = me | |
| **conversation_reply** | read, create, update | **none** | cross-tenant read and write |
| conversation_reply | delete | legacy owner | |
| **directus_users** | read | none | fields: disable_create_project, projects, whitelabel_logo, legal_basis, privacy_policy_url |
| **directus_users** | update | **none** | fields incl. `role`, `status`, `email`, `password`, `token`, `tfa_secret`, `id` |
| directus_activity | read | user = me or item = me | audit log page |
| directus_files | read | folder name contains custom_logos, avatars, Public (3 levels) | |
| **project_chat_message_conversation_1** | CRUD | **none** | |
| **project_report_notification_participants** | read, create | **none** | fields incl. `email`, `email_opt_out_token` |
| project_report_notification_participants | update | legacy owner | |
| **verification_topic_translations** | CRUD + share | **none** | |

Public policy: `conversation_reply` read (no filter; id, content_text, reply, conversation_id, date_created, type); `directus_files` read in public folders.

Removed on 2026-09-14 (commit 8d77b193): Basic User grants on `directus_revisions`, `verification_topic`, `project_chat_message_conversation`.

### 3.3 What the frontend relies on (direct SDK calls)

| Call | Collection | Principal | Needs Directus permission |
|---|---|---|---|
| login, logout, refresh, passwordRequest, passwordReset, registerUserVerify | auth | anyone | Directus auth endpoints |
| readItems announcement, create/update announcement_activity | announcements | user | yes (Basic User rows) |
| readItems conversation_reply | portal replies | participant (anon) and user | public read row |
| createItem project_report_metric | portal metric | participant | no row exists: silently fails for anon |
| directus_activity reads | settings audit logs (`components/settings/hooks/useAuditLogsQuery.ts`) | user | activity row |
| readItem view / aspect / aspect_segment, readItems project_analysis_run, readItem project | library, copy view/quote | user | no Basic User rows: works for staff only |
| TFA generate/enable/disable, password | via server proxy with user token (`api/user_settings.py:171-261`) | user | Directus /users/me |

Everything else goes through the FastAPI server.

---

## 4. Special rules

### 4.1 Tier, seat and quota gates

| Gate | Effective today | Cite |
|---|---|---|
| Tier-gated policies | see 2.4; unknown tier (pilot, pioneer, missing account) denies; NULL tier (legacy) allows | `policies.py:26-34, 261-271` |
| Free tier: workspaces per org | 1, staff exempt | `workspaces.py:814`, `free_tier.py:33-36` |
| Free tier: chats | 1 per workspace (402), BFF create | `bff/chats.py:54-64` |
| Free tier: chat turns | 3 user turns per chat | `api/chat.py:1069-1115` |
| Free tier: reports | 1 per workspace | `api/project.py:462-480` |
| Free tier: hide event CTA, popcorn branding | 403 | `bff/tags.py:436-443`, `bff/popcorn.py:290` |
| Over-cap conversation lock | text scrubbed on list/detail, 402 on summarize/title/add-context | `bff/conversations.py:105-175`, `api/conversation.py:732, 913` |
| New workspace blocked by billing account | 402 | `workspaces.py` via `billing_account_blocks_new_workspace` |
| Seat add blocked (reactivate_required) | 402 on non-observer invites | `invites.py:208` |
| Seat hard cap | dead: `_HARD_BLOCK_SEAT_TIERS` empty, all `included_seats=None` | `seat_capacity.py:62, 199` |
| Pilot hard block | dead: `is_hard_blocked` always false; only 4 callers | `tier_capacity.py:196`, `middleware.py:196-259` |
| Agent calls | free org 1000/month | `agent_access/context.py:70-83` |
| Rate limits | Redis per user or IP; `check()` raises, `allow()` fails open; IP keys trust X-Forwarded-For | `api/rate_limit.py:82-96` |

Observers do not consume a seat (`seat_capacity._SEAT_ROLES`). Staff_support rows never count.

### 4.2 Support access (staff seeing customer data)

1. Standing consent: `workspace.allow_support_access` toggle, set by `WS(settings:manage)` via `PATCH /api/v2/workspaces/{ws}/settings` (`workspace_settings.py:404-470`). While on, any staff member may self-join (`POST /api/v2/admin/workspaces/{ws}/join-support`, `admin.py:1657`) with no per-join approval. Enabling schedules a 7-day reminder and cancels pending requests.
2. One-off request: staff `POST /admin/workspaces/{ws}/support-access/request` (refused if toggle on), `expires_at = now + 7d` (`support_access.py:21`, `admin.py:1918-1975`). A customer with `settings:manage` approves or denies (`api/v2/support_access.py:215, 276`). Approve grants 24h; toggle stays off.
3. Grant (`support_access.py:78-192`): create, reactivate or extend `workspace_membership(role=admin, source=staff_support, expires_at=now+24h)` and arm `revoke_staff_support`. If staff already has a non-support row: "already_member", nothing changes. Rejoin while toggle is on extends by 24h, uncapped.
4. Expiry: read-time in `_get_direct_membership`; revoke task soft-deletes; last session end auto-disables the toggle (`support_access.py:533-574`); staff can leave early (`admin.py:1786`).
5. Audit: `support_access_event` (event codes `support_access.py:25-37`) plus in-app notification and email. Customer reads `GET /api/v2/workspaces/{ws}/support-access/events` (`WS(settings:manage)`).
6. Staff without a support row: all STAFF routes and v1 short-circuits (1.2), logged only to application logs.

### 4.3 Invites

- Workspace invite `POST /api/v2/workspaces/{ws}/invite`: `WS(member:invite)`, requested role at or below caller's level, roles admin/member/billing/external/observer (`schemas.py:246`), observer only in external-client workspaces, optional `project_id` needs `project:share`, self-invite blocked, rate limited (`invites.py:150-620`). Existing onboarded user: added immediately, no consent. Otherwise `workspace_invite` with 7-day expiry.
- Org invite `POST /api/v2/orgs/{org}/invites`: `ORG(admin)`, roles member/admin/billing/owner, same hierarchy guard, existing users added immediately (`orgs.py:1206-1400`).
- Accept: by id (`me.py:478-560, 773-800`) or by hash (`me.py:1388-1500`); both require `invite.email == app_user.email`, not accepted, not deleted, not expired. Onboarding auto-accepts every pending invite for the user's email (`onboarding.py:125-548`). A `claimed_role` above the actual role returns 418.
- Resend (+7d): inviter still in org, or org admin (`invite_actions.py:125-160`). Revoke: inviter, org admin, or workspace admin/owner (`invite_actions.py:261-305`).

### 4.4 Access requests

- Request: org member (role member or billing), workspace `open_to_organisation`, not external-only (`access_requests.py:288-400`).
- Approve/reject: direct row with `member:manage` (ignores expires_at) or org admin/owner. Grants billing to billing-only users, else member (`access_requests.py:120-185, 498-595`).
- Org admin/owner skip the request: `POST /workspaces/{ws}/join` writes a direct admin row on any visibility, ignoring sticky_removed (`access_requests.py:199-285`).

### 4.5 Membership removal semantics

- Remove from org: soft-delete org row and every direct workspace row in the org incl. staff_support (`inheritance.py:508-569`). Guest (no org row) path soft-deletes external rows only, not observer (`orgs.py:2170`).
- Remove from workspace: soft-delete row; if the user still has an org row, append a sticky-remove tombstone so derivation does not re-grant (`workspace_settings.py:834-980`, `inheritance.py:676-702`). No unremove endpoint.
- Self-leave: no policy needed. Last owner and last admin protected (counts include staff_support rows).
- Project share revoke: hard delete.

---

## 5. Permission matrix (effective today)

Columns: Anon/P = anonymous or participant; Obs/Ext/Mem/Bill/Adm/Own = workspace role (direct or derived); Staff = is_admin with no membership; Agent = agent token acting as a user (inherits that user's column, plus org gate). Cells: Y allowed, N denied, C conditional (note). A hole id means today's effective rule differs from the preset and must not be ported.

### 5.1 Project

| Action | Anon/P | Obs | Ext | Mem | Bill | Adm | Own | Staff | Agent | Cite |
|---|---|---|---|---|---|---|---|---|---|---|
| project.list (workspace) | N | Y | Y | Y | N | Y (all incl. private) | Y | N | C | `workspace_projects.py:264-307` |
| project.read (v2 detail/bff/usage) | N | Y | Y | Y | Y (M-4) | Y | Y | N | Y (L) | `api/v2/projects.py:36-120, 533-560` |
| project.read portal config | Y (open) | | | | | | | | | `api/participant.py:401` |
| project.create | N | N | N | Y | N | Y | Y | N | N | `workspace_projects.py:466-480` |
| project.update (BFF PATCH) | N | N | Y | Y | N | Y | Y | N | Y (write scope) | `bff/tags.py:414`, `agent_access/tools.py:506-517` |
| project.legal_basis change | N | N | N | N | N | C (raw role + dembrane email) | C | N | N | `bff/tags.py:455` |
| project.delete (BFF) | N | N | N | N | N | Y | Y | N | N | `bff/tags.py:494-501` |
| project.delete (v1) | N | Y (C-5) | Y (C-5) | Y (C-5) | Y (C-5) | Y | Y | Y | N | `api/project.py:118-128` |
| project.clone | N | N | N | Y | N | Y | Y | Y | N | `api/project.py:1183-1195` |
| project.pin | N | N | N | Y (direct row only) | Y | Y (direct only) | Y (direct only) | N | N | `api/project.py:39-110` (M-12) |
| project.set_private | N | N | N | N | N | C innovator | C | N | N | `api/v2/projects.py:406-475` |
| project.move / bulk-move | N | N | N | N | N | C admin on both ws, same billing | C | N | N | `api/v2/projects.py:180-316` |
| project.members.list | N | Y | Y | Y | Y (L) | Y | Y | N | N | `project_sharing.py:216-300` |
| project.members.manage (share) | N | N | N | N | N | C innovator, private only | C | N | N | `project_sharing.py:109-160, 354-480` |
| project.webhooks.* | N | N | N | N | N | C changemaker | C | Y | read only | `api/project_webhook.py:78-97` |
| project.transcripts.export (zip) | N | Y | Y | Y | Y (H-8) | Y | Y | Y | N | `api/project.py:290-299` |
| project.tags.write (BFF) | N | N | Y | Y | N | Y | Y | N | N | `bff/tags.py:70-114` |
| project.tags.delete (v1) | N | Y (H-3) | Y | Y | Y | Y | Y | Y | N | `api/project.py:158-168` |
| project.goal write | N | N | Y | Y | N | Y | Y | N | N | `bff/goals.py:129` |
| verify topics select (PUT) | Y (H-1) | Y | Y | Y | Y | Y | Y | Y | N | `api/verify.py:269` |
| verify custom topics CRUD | N | Y (M) | Y | Y | Y (M) | Y | Y | Y | N | `api/verify.py:318-468` |

### 5.2 Conversation

| Action | Anon/P | Obs | Ext | Mem | Bill | Adm | Own | Staff | Agent | Cite |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation.read (list, detail, chunks, transcript) | N | Y | Y | Y | N | Y | Y | Y (v1) / N (BFF) | Y | `bff/conversations.py:184-2063`, `api/conversation.py:278-549` |
| conversation.read participant emails | N | Y (L) | Y | Y | N | Y | Y | Y | N | `api/conversation.py:516` |
| conversation.read by UUID (portal) | Y (H-5) | | | | | | | | | `api/participant.py:434-475` |
| conversation.update / move / tags | N | N | Y | Y | N | Y | Y | N | N | `bff/conversations.py:1838-1929, 2158` |
| conversation.summarize/title/retranscribe | N | N | Y | Y | N | Y | Y | Y | N | `api/conversation.py:732, 913, 1007` |
| conversation.delete (v1 only) | N | N | N | Y | N | Y | Y | Y | N | `api/conversation.py:1270` |
| conversation.create_via_portal (initiate) | C (project open) | | | | | | | | | `api/participant.py:334` |
| conversation.upload (chunk/text/confirm) | C (open, H-9) | | | | | | | | | `api/participant.py:507-535, 925` |
| conversation.finish | Y (no check, M) | | | | | | | | | `api/participant.py:1052` |
| conversation.get_reply | C (is_get_reply_enabled, H-7) | | | | | | | | | `api/conversation.py:698` |
| conversation.chunk.delete (portal) | C (M) | | | | | | | | | `api/participant.py:478` |
| conversation_reply read (Directus) | Y (C-6) | Y | Y | Y | Y | Y | Y | Y | | permissions.json |

### 5.3 Chat, report, analysis, canvas, popcorn

| Action | Anon/P | Obs | Ext | Mem | Bill | Adm | Own | Staff | Agent | Cite |
|---|---|---|---|---|---|---|---|---|---|---|
| chat.use (create, read, post, add context) | N | N | Y | Y | N | Y | Y | Y (v1) | N | `bff/chats.py:44-230`, `api/chat.py:112-151` |
| chat.private (other user's) read/post | N | N | Y (M-10) | Y (M-10) | N | Y | Y | Y | N | `api/chat.py:112-151` vs `api/agentic.py:1340-1380` |
| chat.rename / delete / delete message | N | N | Y | Y | N | Y | Y | Y | N | `bff/chats.py:164, 254`, `api/chat.py:168` |
| agentic run start / message | N | N | Y | Y | N | Y | Y | Y | N | `api/agentic.py:900-1060` |
| agentic run read/stop (by run creator) | N | C creator | C | C | C | C | C | Y | N | `api/agentic.py:330-334` (L) |
| agent memory write (workspace scope) | N | Y (M) | Y | Y | Y (M) | Y | Y | Y | N | `api/agentic.py:2217-2295` |
| report.view (BFF) | N | Y | Y | Y | N | Y | Y | N | N | `bff/reports.py:36-98` |
| report.view (v1 list/latest/detail/views) | N | Y | Y | Y | Y (H-8) | Y | Y | Y | N | `api/project.py:649-1030` |
| report.view published (portal) | Y | | | | | | | | | `api/participant.py:1112-1168` |
| report.generate | N | N | Y | Y | N | Y | Y | Y | N | `api/project.py:453-480` |
| report.update content | N | Y (M) | Y | Y | Y (M) | Y | Y | Y | N | `api/project.py:748-860` |
| report.publish (status published/scheduled) | N | N | N | Y | N | Y | Y | Y | N | `api/project.py:768-774` |
| report.update other tenant's report | Y for any role on any project (C-3) | | | | | | | | | `api/project.py:748-860` |
| report.delete / cancel schedule | N | Y (H) | Y (H) | Y | Y | Y | Y | Y | N | `api/project.py:890-956` |
| report.metric create (BFF) | N | Y (L) | Y | Y | N | Y | Y | N | N | `bff/reports.py:242` |
| analysis/map read | N | Y | Y | Y | N | Y | Y | N | N | `bff/analysis.py:123`, `bff/map.py:83` |
| analysis/map run, generate, edit objects | N | N | Y | Y | N | Y | Y | N | N | `bff/analysis.py:268-997`, `bff/map.py:239-396` |
| analysis run read by id | N | Y | Y | Y | Y (L) | Y | Y | N | N | `bff/tags.py:179-201` |
| canvas read / write | N | Y / N | Y / Y | Y / Y | N | Y | Y | N | N | `bff/canvases.py:110-477` |
| popcorn/present read / write | N | Y / N | Y / Y | Y / Y | N | Y | Y | N | N | `bff/popcorn.py:183-396`, `bff/present.py` |
| popcorn/present make public (share link) | N | N | Y (H-11) | Y (H-11) | N | Y | Y | N | N | `bff/popcorn.py:280-296`, `bff/present.py:125-139` |
| popcorn public view | Y with token | | | | | | | | | `api/v2/popcorn_public.py:80-194` |
| home search | N | Y | Y | Y | Y (M) | Y | Y | scoped | N | `api/search.py:388-436` |

### 5.4 Workspace

| Action | Obs | Ext | Mem | Bill | Adm | Own | Staff | Staff-support | Cite |
|---|---|---|---|---|---|---|---|---|---|
| workspace.list own | Y | Y | Y | Y | Y | Y | Y | Y (expired rows listed, L) | `workspaces.py:196-240` |
| workspace.create | org admin/owner of target org | | | | | | Y any org | | `workspaces.py:679-840` |
| workspace.settings.read | Y | Y | Y | Y | Y | Y | N | Y | `workspace_settings.py:101-117` |
| workspace.settings.manage | N | N | N | N | Y | Y | N | Y (M-6) | `workspace_settings.py:357-420` |
| workspace.support_access toggle | N | N | N | N | Y | Y | N | Y (H-13) | `workspace_settings.py:404-470` |
| workspace.data_ownership | N | N | N | N | Y (M) | Y | N | Y | `workspace_settings.py:525-540` |
| workspace.logo (whitelabel, changemaker) | N | N | N | N | C | C | N | C | `workspace_settings.py:747-813` |
| workspace.delete (no live projects) | N | N | N | N | Y (raw role) | Y | N | Y | `workspaces.py:939-990` |
| workspace.tier.set | N | N | N | N | N | N | Y | N | `workspaces.py:1031-1045` |
| workspace.tier.preview_downgrade | N | N | N | N | Y | Y | N | Y | `workspaces.py:1204-1212` |
| workspace.usage (raw) / (€) | N | N | Y / N | Y / Y | Y / Y | Y / Y | N | Y | `workspaces.py:1428-1473` |
| workspace.members.invite | N | N | N | N | Y | Y | N | Y | `invites.py:70-620` |
| workspace.members.change_role | N | N | N | N | Y (can demote owner, H-12) | Y | N | Y | `workspace_settings.py:992-1105` |
| workspace.members.remove | self | self | self | self | Y (can remove owner, H-12) | Y | N | Y | `workspace_settings.py:834-980` |
| workspace.access_requests.action | N | N | N | N | Y | Y | N | Y (even expired, L) | `access_requests.py:120-185` |
| workspace.support_access.approve/deny/events | N | N | N | N | Y | Y | N | Y | `api/v2/support_access.py:59-276` |
| workspace.handoff | org admin of billing org | | | | | | | | `workspaces.py:1757-1985` |
| workspace.memory read (agent) | N | Y | Y | N | Y | Y | N | Y | `bff/memory.py:92` |
| methodology create / edit | N / N | N / N | Y / N | N / N | Y / Y | Y / Y | N | Y | `bff/goals.py:169-223` |

### 5.5 Org, billing, admin, agent access

| Action | Allowed | Cite |
|---|---|---|
| org.* | see 2.5 | |
| org.billing.manage (overview, checkout, invoices, payment method, cancel, resume, retry) | staff, or org role owner/admin/billing of the account's org; workspace roles ignored (M) | `api/v2/billing.py:28, 68-384` |
| billing.invoice.pdf | same, invoice id unbound (M) | `api/v2/billing.py:282-298` |
| admin.* (billing rollup, discounts, partner, trials, change-admin, reset-usage, join-support, support requests, at-risk, payments, managed accounts, trainings, feedback admin) | STAFF only | `api/v2/admin.py`, `admin_managed.py:39`, `admin_training.py:46`, `feedback.py:287`, `feedback_responses.py:281` |
| training.request | org admin | `api/v2/training.py:251` |
| training.roster | org member, emails admin/owner | `api/v2/training.py:159` |
| agent_access.approve consent | any onboarded user holding the request id; grant scoped to own orgs with agent access on | `api/v2/agent_access.py:270-336` |
| agent_access.org toggle, org grants | org admin/owner | `api/v2/agent_access.py:377-433` |
| agent_access.own grants, audit | self; org admin with `?org_id` | `api/v2/agent_access.py:348-450` |
| pricing configuration (session) | any user; can take over a row with null user_id | `api/v2/pricing_configurations.py:408-496` |
| feedback report / responses | any user; ids dropped if unreachable; own rows | `api/v2/feedback.py:103-175`, `feedback_responses.py:203-377` |
| notifications | own rows | `api/v2/notifications.py:52-220` |
| me / onboarding | self | `api/v2/me.py`, `api/v2/onboarding.py` |
| user settings (profile, password with current password, TFA, avatar, logo, delete account) | self | `api/user_settings.py:56-513` |
| prompt templates | personal: creator; workspace: direct row not external/observer (inherited admins denied) | `api/template.py:82-323` |

---

## 6. Route mapping

One line per group sharing a check; exceptions listed individually. Prefix `/api` omitted.

### 6.1 v1 session routers

`chat.py` (/chats)
- DELETE /{chat_id}: RCHAT + project:update (staff bypass). `api/chat.py:168`
- GET /{id}/context, POST /{id}/delete-context, POST /{id}/lock-conversations, GET /{id}/suggestions: RCHAT. `:188, 787, 820, 892`
- POST /{id}/add-context: RCHAT + body.project_id match; single conversation_id checked only in non-agentic chats (H-4); free-tier lock. `:584-785`
- POST /{id}/initialize-mode: RCHAT + project match. `:963`
- POST /{id}: RCHAT, agentic rejected, pilot gate (dead), 3 free turns. `:1069`
- All ignore `is_private` (M-10).

`project.py` (/projects)
- PATCH /{id}/pin: direct workspace row not external/observer; legacy creator. `:39-110`
- VPA only (any role): DELETE /{id}; DELETE /{id}/tags/{tag_id}; POST /{id}/conversations/{cid}/tags/delete; GET /{id}/transcripts; POST /{id}/create-library; GET /{id}/reports; GET /{id}/reports/latest; DELETE /{id}/reports/{rid}; POST /{id}/reports/{rid}/cancel-schedule; GET /{id}/reports/{rid}/detail; GET /{id}/reports/{rid}/views; GET /{id}/reports/{rid}/needs-update; GET /{id}/participants/count; GET /{id}/reports/{rid}/progress. rid bound to project on delete, cancel-schedule, detail; not bound on views, needs-update, progress.
- POST /{id}/create-view: staff VPA, else RPA(project:update). `:411`
- POST /{id}/create-report: staff VPA, else RPA(report:generate) + free 1 report. `:453`
- PATCH /{id}/reports/{rid}: staff VPA, else RPA + report:publish only for status published/scheduled; rid unbound (C-3). `:748`
- POST /{id}/clone: staff VPA, else RPA(project:create). `:1183`

`project_webhook.py` (/projects/{id}/webhooks): staff, else RPA(workspace:webhooks) (changemaker; skipped for legacy). GET, POST, PATCH/DELETE /{wid}, POST /{wid}/test; wid bound. GET /copyable additionally filters sources by `allows(workspace:webhooks)`; staff sees all tenants. `api/project_webhook.py:78-486`

`agentic.py` (/agentic). APA = staff or RPA(chat:use) (`:200-215`). RUN = staff or run.directus_user_id == caller (`:330-334`).
- POST /runs: session JWT + APA + chat bound to project, pilot, free tier. `:900`
- POST /runs/{id}/messages: RUN, pilot, free tier. `:991`
- POST /runs/{id}/stream, /stop, GET /runs/{id}, /events, GET /chats/{cid}/latest-run: RUN. `:2297-2417`
- APA: GET /projects/{pid}/settings, /conversations, /focused-conversations, /monitor, /dismissed-insights, /insights, /reports, /reports/{rid} (bound), /memory, /goal, /methodologies; POST /projects/{pid}/tags (bound), /support-request (body ids trusted, L), /insight, /memory. 
- GET /projects/{pid}/chats: APA + workspace-visible projects + others' private chats excluded. `:1286`
- GET /chats/{cid}/messages: RCHAT + private owner check. `:1340`
- PATCH /insights/{iid}, POST retract, dismiss: APA on insight's project. `:1472-1538`
- Canvas routes (/projects/{pid}/canvases...): APA + canvas bound to project + canvas flag. `:1851-2130`
- PATCH/DELETE /memories/{mid}: user scope owner; project scope APA; workspace scope any workspace role (M). `:2217-2295`

`conversation.py` (/conversations). R(p) = staff existence check, else RCA + p (`api/conversation.py:234`).
- R(): GET /{cid}/counts, /content, /chunks/{chunk_id}/content (bound), /transcript, /emails, /token-count.
- R(project:update): POST /{cid}/summarize, /generate-title (lock 402), /retranscribe.
- R(conversation:delete): DELETE /{cid}. `:1270`
- POST /{cid}/get-reply: PARTICIPANT, `is_get_reply_enabled` only. `:698`
- GET /health/stream: public, static. `:1320`

`stateless.py`: POST /stateless/transcribe: with project_id RPA(project:update) or staff; purpose pricing_intake/issue_report session only (30/h); else staff. POST /stateless/webhook/transcribe: public no-op. `api/stateless.py:289-569`

`verify.py`: GET/PUT /verify/topics/{pid}: none. POST/PATCH/DELETE /verify/topics/{pid}/custom*: staff or LADDER (any role). GET /verify/artifacts/{cid}, GET /verify/artifact/{aid}, POST /verify/generate, PUT /verify/artifact/{aid}: none. No check of is_verify_enabled, deleted_at. `api/verify.py:257-1098`

`search.py`: GET /home/search: session, 40/min, results filtered by LADDER (any role, staff scoped too). `api/search.py:388`

`template.py`: see 5.5. `user_settings.py`: self. `stats.py`: public. `api.py` health: public.

### 6.2 v1 participant router (`participant.py`, no auth)

| Route | Key | Check | Cite |
|---|---|---|---|
| POST /participant/projects/{pid}/conversations/initiate | pid | open; tag_id_list unvalidated; source client-set | `:334` |
| GET /participant/projects/{pid} | pid | open | `:401` |
| GET /participant/projects/{pid}/conversations/{cid}, .../chunks | pid+cid | open; cid NOT bound to pid | `:434, 456` |
| DELETE /participant/projects/{pid}/conversations/{cid}/chunks/{chunk_id} | ids | cid bound to pid; chunk NOT bound; no open check | `:478` |
| POST /participant/conversations/{cid}/upload-text, upload-chunk | cid | open (via create_chunk); source client-set | `:507, 535` |
| POST /participant/conversations/{cid}/ping | cid | none; 6000/min/IP; body.project_id trusted | `:651` |
| POST /participant/projects/{pid}/visitors/{vid}/ping | pid | none; 3000/min/IP | `:754` |
| POST /participant/conversations/{cid}/check-s3, get-upload-url | cid | open; 40/min/cid in-process | `:787, 837` |
| POST /participant/conversations/{cid}/confirm-upload | cid | open; file_url not bound to cid prefix | `:925` |
| POST /participant/conversations/{cid}/finish | cid | none | `:1052` |
| GET /participant/{pid}/report/latest, /{rid}/detail, /views | pid | published report only; project deleted_at not checked | `:1112-1168` |
| POST /participant/{pid}/report/metric | pid | published report in pid; type client-set | `:1198` |
| POST /participant/report/subscribe | none | none; ids unbound; no rate limit | `:1234` |
| POST /participant/{pid}/report/unsubscribe, GET eligibility | token+pid | token match | `:1303, 1351` |

### 6.3 v2 non-BFF

- orgs, access_requests, workspaces, invites, invite_actions, workspace_projects, workspace_settings, projects, project_sharing: see 2.5, 4.3, 4.4 and 5.1/5.4 (each row cites file:line).
- me, onboarding, notifications, auth: self or public as in 1.1, 1.6, 4.3.
- billing: org billing roles or staff (5.5); webhook public (1.10).
- pricing_configurations: session (any) and site token (1.11).
- feedback, feedback_responses, training: 5.5.
- admin, admin_managed, admin_training: STAFF.
- support_access: WS(settings:manage).
- agent_access: 5.5. agent: 6.5. popcorn_public: 1.9.

### 6.4 v2 BFF (`/api/v2/bff`)

No staff bypass anywhere in BFF.

- conversations: RPA(conversation:read) on query project_id: GET "", /count, /live-count, /live, /monitor, /monitor/stream, /remaining-count. RCA: GET /{id}, /{id}/chunks, /{id}/chunk-count, GET /conversation-chunks/{chunk_id}, GET /conversation-project-tags. RCA + project:update: PATCH /{id}, POST /conversation-project-tags/replace (tags bound). POST /{id}/move and /bulk-move (max 500): project:update on source and target, every id checked first. `bff/conversations.py:184-2179`
- chats: POST /chats RPA(chat:use) + free cap; GET /chats RPA(chat:use); GET /chats/{id}, GET /chat-messages, POST /chat-messages: RCHAT; PATCH /chats/{id}, DELETE /chat-messages/{id}: RCHAT + project:update. No is_private check. `bff/chats.py:44-254`
- reports: GET /reports RPA(report:view); GET /reports/{id}, /timeline, GET /report-metrics, POST /report-metrics: RREP. `bff/reports.py:36-256`
- tags.py: GET /tags, GET /analysis-runs: RPA(project:read); POST /tags, PATCH /projects/{id}: RPA(project:update); PATCH/DELETE /tags/{id}: tag resolver + project:update; GET /analysis-runs/{id}, /new-chunks-count: run resolver, no policy; GET /projects (picker): LADDER per project; DELETE /projects/{id}: RPA(project:delete). `bff/tags.py:41-501`
- memory: GET /memory/user self; GET /memory/project/{pid} RPA(chat:use); GET /memory/workspace/{ws} WS(chat:use); DELETE /memory/{id} by row scope. `bff/memory.py:65-107`
- goals: GET goal RPA(project:read); POST goal RPA(project:update); GET /methodologies WS any role; POST WS + project:create; GET /methodologies/{id} public/owner/any workspace role; POST versions owner or settings:manage. `bff/goals.py:88-223`
- canvases (flag + project.is_canvas_enabled): list RPA(project:read); create/preview RPA(project:update); GET /{id}, /events, /generations: RREP + project:read + kind; PATCH, refresh, host-items, loop: same + project:update. `bff/canvases.py:45-477`
- popcorn (flag): list RPA(project:read); create RPA(project:update); sample routes session only; GET /{id} and all /view/* reads: RREP + flag + project:read; settings, refresh, rerun, live, loop: + project:update. `bff/popcorn.py:64-526`
- present (flag, reuses popcorn resolver): GET /projects/{pid} RPA(project:read); default/start RPA(project:update); audience, map, deck, updates reads: project:read; draft, publish, opening, adopt, translate, prepare: project:update. `bff/present.py:21-470`
- map: GET project, graph, events: RPA + project:read + conversation:read; POST generate + project:update (10/600s); POST /results/{id}/title read only (LLM); fact-checks read; fact-check write/delete + project:update. `bff/map.py:83-396`
- analysis: GET /recipes session; runs start + project:update (ids bound); GET run, list runs, objects, revisions (bound, SQL scoped): read; cancel, object revisions/rollback/membership: + project:update; last-opened and feedback: read, own rows; lineage: read. `bff/analysis.py:123-1348`

### 6.5 Agent REST and MCP

All require a live agent token (1.7). MCP tools map 1:1 to the same functions.

| Route | Check | Cite |
|---|---|---|
| GET /v2/agent/whoami, /tools, /docs/read, /docs/search | token only | `api/v2/agent.py:72-253` |
| GET /v2/agent/projects/find | reachable workspaces + LADDER + org in grant | `agent_access/tools.py:439-498` |
| GET /v2/agent/projects/{id} | RPA + require_org (no project:read, L) | `tools.py:501-503` |
| PATCH /v2/agent/projects/{id} | write scope + RPA(project:update), field allowlist | `tools.py:506-517` |
| GET /v2/agent/projects/{id}/webhooks | RPA(workspace:webhooks) | `api/v2/agent.py:126` |
| GET /v2/agent/projects/{id}/conversations, /search | conversation:read | `toolkit/conversations.py:263-270` |
| GET /v2/agent/conversations/{id}, /grep, /transcript | RCA + require_org | `api/v2/agent.py:194-225` |
| POST /v2/agent/issues | optional access check | `tools.py:758-763` |
| POST /v2/agent/tool-requests | token only | `api/v2/agent.py:298` |

---

## 7. Holes and inconsistencies

Severity: critical = cross-tenant data or privilege escalation reachable by any signup or anonymous caller without secrets; high = cross-tenant or role-bypass needing a guessable id, a UUID, or a low role; medium = within-tenant role bypass or leak; low = hygiene, defence in depth, dead code. "Verified" means checked live on prod (read-only) on 2026-09-27.

### Critical

| Id | Where | Exploit shape | Fix |
|---|---|---|---|
| C-1 | Directus Basic User `directus_users` update, no row filter, fields incl. role, status, email, password, token, tfa_secret, id (permissions.json:619-650; prod row 579 verified) | Any self-registered user PATCHes `directus.dembrane.com/users/<id>` to set their own role to Administrator (gains `admin_access`, i.e. STAFF on the server) or another user's email/password (account takeover). Directus-side enforcement of role changes by non-admins is unverified: confirm on echo-next with two throwaway accounts before disclosure | Today: filter `id = $CURRENT_USER`, drop role, status, token, id, email, tfa_secret from the field list. Bun: users never write the identity store directly; Better Auth owns profile changes |
| C-2 | Directus self email change + onboarding invite auto-accept (`onboarding.py:105-548`, `me.py:533`) | Even with C-1 filtered to self: register, verify own email, change own Directus email to a victim's address, call `/v2/onboarding/complete`, which auto-accepts every pending org/workspace invite addressed to the victim | Remove `email` from writable fields; email change only through a verified flow; bind invite acceptance to a verified email claim at accept time, not a copy |
| C-3 | PATCH /api/projects/{A}/reports/{rid} (`api/project.py:748-860`) | Any role on any own project A rewrites content, publishes or schedules another tenant's report by enumerating integer report ids | Load report with `project_id = A`; content needs project:update, status needs report:publish |
| C-4 | POST /api/projects/{A}/conversations/{cid}/tags/delete (`api/project.py:177-190`) | Any role on own project hard-deletes `conversation_project_tag` rows platform-wide by integer id | Delete with filter on conversation cid and project A; require project:update |
| C-5 | DELETE /api/projects/{id} (`api/project.py:118-128`) | Observer (free outsider), external or workspace billing soft-deletes a project; BFF requires project:delete | require project:delete; retire v1 route |
| C-6 | Directus public + Basic User `conversation_reply` (permissions.json; verified: anonymous total_count 862) | Anonymous dump of every AI reply text across tenants; any signup can create or edit replies on any conversation | Remove public and Basic User rows; serve replies through the backend keyed by a participant token |
| C-7 | Directus Basic User `project_report_notification_participants` read/create, no filter (verified) | Any signup lists every report subscriber's email and opt-out token across tenants, and can unsubscribe them or insert rows | Remove rows; backend only |

### High

| Id | Where | Exploit shape | Fix |
|---|---|---|---|
| H-1 | PUT /api/verify/topics/{pid} (`api/verify.py:269`) (known, NOT fixed) | Unauthenticated rewrite of any project's verify topic selection | SESSION + RPA(project:update) |
| H-2 | POST /api/verify/generate, PUT /api/verify/artifact/{aid} (`api/verify.py:840-1098`) | Holder of any conversation UUID gets an LLM summary of its transcript; PUT can pull conversation B into artifact A | Participant capability token bound to conversation; bind artifact to conversation; check is_verify_enabled, deleted_at |
| H-3 | DELETE /api/projects/{A}/tags/{tag_id} (`api/project.py:158-168`) | Any role hard-deletes any tenant's project_tag by UUID | Filter tag by project; require project:update |
| H-4 | POST /api/chats/{id}/add-context in agentic mode (`api/chat.py:725-747, 875-880`) | Attach a foreign conversation UUID; lock-conversations and the run prompt then leak its row and participant name | Verify conversation.project_id == chat.project_id in every mode; scope list_by_ids |
| H-5 | GET /api/participant/projects/{pid}/conversations/{cid}, .../chunks (`api/participant.py:434-475`) | Any open project id plus a foreign cid reads another tenant's transcript and participant email | Filter conversation by project_id = pid |
| H-6 | POST /api/stateless/transcribe audio_file_uri (`api/stateless.py:476-499`) | Any user (purpose=pricing_intake) transcribes any bucket key incl. other tenants' audio; full URLs fetched server-side (SSRF) | Accept only the uploaded file or keys under the caller's project; reject URLs |
| H-7 | POST /api/participant/conversations/{cid}/confirm-upload (`api/participant.py:925-996`) | file_url set to another conversation's S3 key gets transcribed into the attacker's conversation, then read back | Require key prefix `conversation/{cid}/chunks/` and the issued chunk id |
| H-8 | v1 VPA reads by workspace billing: transcripts zip, report list/latest/detail/views, participant count, create-library (`api/project.py:290-1086`) | Billing role (no project:read) downloads every transcript of workspace-visible projects | Make LADDER return none for roles without project:read, or require it in VPA |
| H-9 | DELETE /api/projects/{id}/reports/{rid}, POST cancel-schedule (`api/project.py:890-956`) | Observer or external deletes or unschedules reports (report:delete is admin-only) | require report:delete / report:publish |
| H-10 | POST /api/conversations/{cid}/get-reply (`api/conversation.py:698`, `reply_utils.py:127-237`) | Unauthenticated LLM spend by conversation UUID; works on deleted conversations; injected text can pull adjacent conversations' content | Participant token, deleted_at, open check, rate limit |
| H-11 | PATCH /bff/popcorn/{id}/settings public=true, POST /bff/present/{id}/publish (`bff/popcorn.py:280-296`, `bff/present.py:125-139`) | External or free-tier member publishes an unauthenticated link to project analysis (sharing is otherwise project:share, admin, innovator) | Require project:share (tier gated) and report:publish to go public; rotate token on each toggle |
| H-12 | DELETE and PATCH /api/v2/workspaces/{ws}/members/{mid} (`workspace_settings.py:856-872, 1004-1008`) | Workspace admin (incl. inherited org admin or staff_support) removes or demotes an owner; guard checks only the requested role | Target's current level must be at or below caller's; only owners touch owners |
| H-13 | Support access lifecycle (`workspace_settings.py:404-470`, `support_access.py:78-192`, `inheritance.py:355`) | Customer turns support off but live staff rows keep full admin up to 24h; staff admin can turn the toggle back on and rejoin forever; invisible in Members | Toggle-off revokes all staff_support rows; staff_support principal cannot write consent, members or approvals; show live sessions; cap extensions |
| H-14 | STAFF blanket access (`api/project.py:618`, `api/v2/admin.py`, `billing.py:70`, `workspaces.py:718`) | Any admin_access holder reads and mutates every tenant with only application logs; combined with C-1 this is reachable by any signup | Named staff policies; durable staff audit per mutation and cross-tenant read; data reads only via support session |

### Medium

| Id | Where | Exploit shape | Fix |
|---|---|---|---|
| M-1 | POST/PATCH/DELETE /api/verify/topics/{pid}/custom* (`api/verify.py:151-179`) | Billing and observer create/edit/delete topics | RPA(project:update) |
| M-2 | DELETE /api/participant/projects/{pid}/conversations/{cid}/chunks/{chunk_id} (`api/participant.py:478-504`) | Own pid/cid pair deletes any tenant's chunk by id | Filter chunk by conversation; open check |
| M-3 | POST /api/participant/conversations/{cid}/ping body.project_id (`api/participant.py:698-703`, `bff/conversations.py:1255`) | Register a foreign conversation in own monitor; its name and duration show up | Verify cid in project; filter monitor by project |
| M-4 | GET /api/v2/projects/{id}, /bff, /conversation-usage (`api/v2/projects.py:36-120, 533-560`) | Billing reads project detail and usage | require project:read (same root fix as H-8) |
| M-5 | GET /api/home/search (`api/search.py:427-436`) | Billing gets transcript and chat hits | filter by project:read |
| M-6 | Staff_support and inherited admins pass hardcoded `role in (admin, owner)` checks: workspace delete, legal basis, visibility, move (`workspaces.py:950`, `bff/tags.py:455`, `api/v2/projects.py:406-475`) | Support session deletes a workspace; custom policies ignored | Named policies (workspace:delete, project:legal_basis, project:move) via has_policy; deny destructive actions to staff_support |
| M-7 | Fields passthrough on superuser client: GET /bff/conversations, /{id}/chunks, /bff/reports `fields` (`bff/conversations.py:249-256, 2041`, `bff/reports.py:62-66`) | Observer requests relational paths (e.g. `project_id.directus_user_id.email`) and reads outside the resource; bypasses over-cap lock | Allowlist fields per endpoint; reject dotted paths |
| M-8 | PATCH /api/projects/{id}/reports/{rid} content edits (`api/project.py:768-774`) | Observer or billing rewrites report content in own project | project:update for non-status fields |
| M-9 | GET /api/v2/orgs/{org}/usage (`orgs.py:2346-2372`) | Any org member sees every workspace incl. private (names, seats, hours) | admin/owner/billing only, or filter to accessible workspaces |
| M-10 | v1 chat routes and BFF chats ignore is_private (`api/chat.py:112-151`, `bff/chats.py`) | Member reads and posts into a colleague's private chat; agentic routes hide it | Owner check in the chat resolver |
| M-11 | GET /api/projects/{A}/reports/{rid}/views, /needs-update, /progress (`api/project.py:981-1140`) | Integer rid of another tenant leaks view counts, timestamps, progress events | Bind rid to project |
| M-12 | PATCH /api/projects/{id}/pin (`api/project.py:67-96`) | Inherited org admins denied, billing allowed, no staff path | RPA(project:update) |
| M-13 | Agent memory workspace scope (`api/agentic.py:2217-2252`) | Billing or observer amends or deletes workspace agent memory | chat:use for write, settings:manage for delete |
| M-14 | POST /api/v2/workspaces/{ws}/join (`access_requests.py:230-255`) | Sticky-removed org admin, or one kept out of a private workspace, self-joins as admin | Honour sticky_removed; CTO decision on private (Q3) |
| M-15 | PATCH /api/v2/workspaces/{ws}/data-ownership (`workspace_settings.py:525-540`) | Workspace admin (not org admin) re-scopes billing out of the org account | Require org admin of billing org |
| M-16 | Billing routes use org roles only (`billing.py:47-84`) | Workspace admin/billing refused on own workspace account; org billing manages every workspace account incl. private | Scope-aware check: workspace accounts use workspace:view_invoices / update_payment |
| M-17 | GET /billing-accounts/{id}/invoices/{invoice_id}/pdf (`billing.py:282-298`) | Own account id plus another org's Mollie invoice id returns its PDF | Check invoice customer matches account |
| M-18 | Session and grant revocation (`dependency_auth.py:52-109`, `agent_access/context.py:108-121`) | Suspended or deleted user keeps a valid session until exp and agent grants up to 365 days | Check user status at the resolver; revoke grants on suspend and org removal |
| M-19 | Participant writes: source client-set, finish unauthenticated, subscribe unbound (`api/participant.py:339-556, 1052, 1234`) | Dodge the recording meter; close and fire webhooks for any cid; enrol arbitrary emails on any project | Server-set source; participant token; bind and rate limit subscribe |
| M-20 | Unvalidated custom_policies (`policies.py:208-256`) | A `'*'` written via Directus admin makes a member owner-equivalent | Validate against known policy list; never honour `*` from custom |
| M-21 | DISABLE_CORS (`main.py:86-100`) | `*` with credentials reflects any origin | Refuse to start outside local with DISABLE_CORS |
| M-22 | Webhook URL SSRF (`api/project_webhook.py:276-550`, `service/webhook.py:458-462`) | Changemaker admin targets internal services; /test echoes 200 chars; redirects followed | Block private ranges at create and dispatch, no redirects, no body echo |

### Low

| Id | Where | Summary | Fix |
|---|---|---|---|
| L-1 | Directus Basic User `project_chat_message_conversation_1` CRUD and `verification_topic_translations` CRUD+share, no filter | Cross-tenant junction and translation edits by any signup | Remove rows |
| L-2 | Agentic runs by creator only (`api/agentic.py:330-334`) | Removed user keeps reading and appending to runs | Also RPA on run.project_id |
| L-3 | Body ids trusted: agentic support-request, insight; x-dembrane-* headers in agent (`api/agentic.py:1382-1446`, `agent/main.py:63-69`) | Tickets attributed to other users/chats | Derive from session; agent verifies JWT or signed envelope |
| L-4 | Analysis run by id and project picker (`bff/tags.py:179-201, 397-407`) | Billing reads run metadata, lists project names | project:read in resolver |
| L-5 | POST /bff/report-metrics, POST /bff/chat-messages message_from, map title (`bff/reports.py:242`, `bff/chats.py:239-243`, `bff/map.py:295`) | Observer writes metrics with client ip; forged assistant turns; observer triggers LLM | Server-set fields; proper write policy |
| L-6 | Foreign ids attached: methodology_version_id, goal chat_id, initiate tag_id_list (`bff/tags.py:269, 464`, `bff/goals.py:143-150`, `service/conversation.py:407`) | Attach another workspace's private methodology or tags | Validate visibility and project binding |
| L-7 | GET /bff/methodologies/{id} (`bff/goals.py:88-97`) | Any workspace role reads any methodology tagged with that workspace, ignoring visibility | Use list_visible_methodologies rule |
| L-8 | Share token plaintext and never rotated (`popcorn/service.py:1174-1181`) | Un-publish then re-publish revives the old URL | Hash and rotate |
| L-9 | Direct workspace_membership queries skip expires_at and count staff rows (`access_requests.py:140-165`, `workspaces.py:212-220`, `workspace_settings.py:862-1075`, `api/template.py:82-105`) | Expired support row approves requests; staff row counts as "other admin" | One resolver everywhere |
| L-10 | Org invite adds external as org admin (`orgs.py:1263-1400`) | Bypasses the external-never-admin rule | Same check as role change |
| L-11 | Guest org removal leaves observer rows (`orgs.py:2170`) | Observer survives removal | role in (external, observer) |
| L-12 | Workspace project list shows own private projects not shared (`workspace_projects.py:286-287`) | Leaks names of projects that then 404 | Drop legacy creator clause for workspace projects |
| L-13 | project_membership no unique index, revoke deletes rows[0] (`project_sharing.py:470-478`) | Duplicate share survives revoke | Unique index; delete all |
| L-14 | Invite reactivation keeps old expires_at (`invites.py:392-397`) | Silent 403 for re-added former support staff | Clear expires_at |
| L-15 | Soft-deleted org still manageable (`orgs.py:191-218`) | Hygiene | Check org.deleted_at |
| L-16 | Invite resend by demoted inviter (`invite_actions.py:147-155`) | Extends an old admin-issued invite | Require current member:invite |
| L-17 | Legacy tiers pilot/pioneer accepted and used as defaults (`workspaces.py:1014, 1206`, `middleware.py:58`) | Staff sets a tier that disables paid features | Restrict to TIER_CAPACITIES keys |
| L-18 | Open MCP dynamic registration (`agent_access/oauth.py:266-277`) | Registry spam; consent phishing with chosen client name | Rate limit, "unverified client" label, expire unused |
| L-19 | Refresh reuse not detected (`oauth.py:394-437`) | Stolen refresh races the real client | Reuse revokes grant |
| L-20 | IP rate limits trust X-Forwarded-For / X-Site-Visitor-Ip (`api/participant.py:221`, `api/stats.py`, `popcorn_public.py:47-51`, `pricing_configurations.py:462`) | Limits dodged | Trusted hop only |
| L-21 | Public report routes ignore project deleted_at; metric type client-set (`api/participant.py:1112-1231`) | Published reports of deleted projects stay readable | Join project.deleted_at; whitelist type |
| L-22 | Unauthenticated verify reads (`api/verify.py:257, 524, 564`) | Custom topic prompts and approved artifacts by UUID | Participant token |
| L-23 | Uploads without type/size limit to public custom_logos (`api/user_settings.py:329-474`) | SVG in a public folder | Raster only, size cap |
| L-24 | Agent docs regex (`knowledge.py:142-147`), agent get_project without project:read (`tools.py:501-503`), issue ids unbound (`tools.py:758-763`) | ReDoS; billing reads project via agent | re2; project:read; bind ids |
| L-25 | Pilot block missing on v1 and BFF generation routes; pilot and seat gates dead (`tier_capacity.py:196`, `seat_capacity.py:62`) | Inconsistent, currently inert | Delete or wire one quota gate in the resolver |
| L-26 | Dead policy code: ORG_ROLE_PRESETS, STAFF_POLICIES, never-enforced presets (project:move, report:delete, workspace:export, workspace:api_access, workspace:update_payment, upgrade:request) | Spec drift | Port only enforced rules; wire or drop the rest |
| L-27 | `SESSION_COOKIE_SECURE="lax"` (deployment-directus.yaml:123); Google default role id missing on prod | Config hygiene | `true`; fix or remove role id |

### Known issues status

- PUT /verify/topics/{project_id} missing owner check: NOT fixed (H-1).
- 14 Sep `/revisions` cross-tenant: FIXED. Directus grant removed in 8d77b193 (anonymous GET /revisions is 403); BFF revisions are bound to project (`bff/analysis.py:840`, `analysis/store.py:1267`). Not re-tested with a Basic User token.
- 14 Sep `conversation_reply` public read: NOT fixed (C-6, verified 862 rows readable anonymously).

### Inconsistencies to resolve once, centrally

- Seven row-check implementations disagree on: staff bypass (v1 yes, BFF no, search scoped), whether project:read is required (RPA/VPA/LADDER no), direct-row-only vs ladder (pin, templates, access-request approval, workspace list), expires_at and staff_support handling, raw role strings vs policies.
- The same action has different rules on different surfaces: project delete (v1 any role vs BFF project:delete), tag delete (v1 any role, BFF project:update, agentic chat:use), conversation delete (v1 only), private chats (agentic hides, v1 and BFF do not), pilot gate (4 callers of a dead gate).

---

## 8. Open questions for the CTO

Each has a recommended default so the port is not blocked.

1. Should the Bun resolver reproduce the effective behaviour or the preset intent where they differ (every hole marked in section 5)? Default: preset intent, with each deviation listed in the migration changelog and fixed on echo main first where it is critical or high.
2. Should workspace billing users get any project access (LADDER returns `billing` today)? Default: no; resolver returns none for roles without project:read.
3. Should org admins be able to self-join private and invite_only workspaces, and override a sticky removal? Default: allow invite_only, deny private and sticky (org owner carve-out stays).
4. What exactly may a staff_support session do? Default: read-only preset (project:read, conversation:read, report:view, workspace:view_usage) plus explicit "act as admin" only when the customer approved it in that request; never consent, members or delete.
5. Should is_admin blanket access survive at all? Default: no; replace with named staff policies (`staff:set_tier`, `staff:billing`, `staff:support_join`, ...) held on the Better Auth user, every use audited; customer data only via a support session.
6. Is the legacy owned-project path (workspace_id null) still needed? Default: backfill every legacy project into its owner's personal workspace before cutover, then drop the path. Needs a prod count first.
7. Participant identity: keep UUID-as-capability or issue a participant token? Default: signed participant token per conversation (issued at initiate, stored in the portal), project UUID only for initiate and published reads.
8. Directus direct access after cutover: can users still reach Directus REST? Default: no; Directus is admin-only and internal, the frontend's remaining direct calls (announcements, replies, audit log, auth) move to the platform.
9. Session model: Better Auth sessions with server-side revocation replace Directus JWTs; what lifetime? Default: 7-day sliding session, immediate revocation on logout, suspension and org removal; MFA enforced for staff, optional for users (2FA policy is attached to nobody today).
10. Agent/MCP access vs `workspace:api_access` (changemaker gate): which wins? Default: agent access stays available on all tiers with the free call budget; `workspace:api_access` is removed as dead.
11. Should custom_policies remain a feature (no UI writes them today)? Default: keep the column, validate against the policy list, forbid `*`.
12. Pilot hard block and seat hard cap are dead code: port or drop? Default: drop; reintroduce as one quota gate in the resolver when pricing needs it.
13. Which roles may make content public (popcorn/present links, published reports)? Default: project:share plus report:publish, tier gated at innovator.
14. Should observers see participant emails? Default: no; PII requires member or above.
