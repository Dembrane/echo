# dembrane - Documentation FACTS (internal source of truth)

> This file is the authoritative, code-derived reference for writing the user docs.
> It is NOT part of the published site (folder2website only renders pages reachable
> from `docs/README.md`; this `_authoring/` folder is never linked).
> Everything here was derived from the `echo/` codebase, the ADRs, and the iOS app.
> When a fact here conflicts with something you remember, trust this file.

---

## 0. What dembrane is

dembrane is a platform for capturing, transcribing, and making sense of spoken
conversations at scale - town halls, workshops, citizen panels, research interviews,
team retros. People speak; dembrane records, transcribes (securely, multilingual),
and turns hours of dialogue into summaries, themes, reports, and a chat you can
interrogate. Core belief: *"PEOPLE KNOW HOW"* - communities already hold the
knowledge; dembrane surfaces it.

"ECHO" is the historical name of the platform feature. It is *not* the brand and
should be used sparingly. The brand is always *dembrane* (lowercase). In new docs,
prefer "dembrane" / "the dashboard" / "the portal" over "ECHO".

The product ships three ways:
1. *Managed SaaS* at dembrane.com (dashboard.dembrane.com + portal.dembrane.com).
2. *Open source* (BSL 1.1 - free under €1M total finances; converts to GPLv3 after 3y).
3. *Self-hosted* with your own LLM providers / data location.

Surfaces:
- *Host dashboard* - `dashboard.dembrane.com` (facilitators/admins).
- *Participant portal* - `portal.dembrane.com` (people recording; no account needed).
- *dembrane Go* - native iOS recording app (own feature set; see §9).
- Same web frontend codebase serves dashboard + portal; it picks the router by hostname.

---

## 1. The actor / user-type model (how the docs are segmented)

| Doc user type | Who they are | Primary surface |
|---|---|---|
| *Host* | Facilitators & workspace members who run projects, collect & analyse conversations | Dashboard |
| *Host - partner* | A host inside a *partner* organisation that hosts external-client workspaces; plus the *observer*/*external* collaborator roles | Dashboard |
| *Staff* | dembrane employees (Directus admins) - billing, support, trainings, partner ops | Admin panel |
| *Participant* | Members of the public who record via QR/link; no account | Portal |
| *Developer - internal* | dembrane engineers working on the codebase | Repo |
| *Developer - external* | Self-hosters, OSS contributors, API integrators | Repo / API |

It is fine (and intended) for the SAME feature to appear in multiple user-type guides,
written from that user's vantage point ("when would *I* use this, as *this* role?").

---

## 2. Roles & permissions (THE backbone) - `server/dembrane/policies.py`

### 2.1 Organisation roles (`ORG_ROLE_PRESETS`)
- *owner* - `["*"]`, full control, cannot be demoted via UI.
- *admin* - `org:view, org:manage_users, org:manage_settings, org:manage_billing, org:create_workspace, org:view_all_workspaces, org:view_usage`.
- *member* - `org:view` only.
- *billing* - `org:view, org:view_all_workspaces, org:view_usage, org:view_invoices, org:update_payment` (financial visibility across all org workspaces; no invite/create/settings).

Org membership is *independent* of workspace membership (ADR 0004). You can be an
org member with zero workspaces; you can be in a workspace (external/observer) with no
org membership.

### 2.2 Workspace roles (`WORKSPACE_ROLE_PRESETS`) - hierarchy: observer < external < member < billing < admin < owner
- *owner* - `["*"]`.
- *admin* - full project/content/member/settings/billing: `project:read/create/update/delete/share/set_private/move, conversation:read/delete, chat:use, report:view/generate/publish/delete, member:invite/manage, settings:manage, workspace:view_usage/view_invoices/update_payment/export/set_private/whitelabel/api_access/webhooks, upgrade:request`.
- *member* - `project:read/create/update, conversation:read/delete, chat:use, report:view/generate/publish, workspace:view_usage`. (Can create & edit projects; cannot delete projects, invite, manage settings.)
- *billing* - `workspace:view_usage/view_invoices/update_payment, upgrade:request`. Financial visibility only; NO project/content access. Consumes a seat.
- *external* - `project:read/update, conversation:read, chat:use, report:view/generate`. A *paid* outside collaborator: can edit projects, read conversations, chat, generate reports; CANNOT create/delete projects, capture, invite, publish reports.
- *observer* - `project:read, conversation:read, report:view`. *FREE, read-only.* Cannot chat, generate, edit, invite. Only exists in *external-client* workspaces.

### 2.3 Capability matrix (who can do what)
| Action | owner | admin | member | billing | external | observer |
|---|---|---|---|---|---|---|
| View projects | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Create projects | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Edit projects | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| Delete projects | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Share/set-private project | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Read conversations | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Delete conversations | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Use chat | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| View reports | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Generate reports | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| Publish reports | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Invite / manage members | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Manage settings | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| View usage | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| View invoices / update payment | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |

### 2.4 Staff policies (`STAFF_POLICIES`) - Directus admin only
`staff:can_set_tier`, `staff:can_set_visibility`, `staff:can_transfer`. Gate = JWT
claim `admin_access` (set via Directus admin role). See §6.

### 2.5 Role display (frontend) - `frontend/src/lib/roles.ts`
`displayRole()` / `roleColor()` / `ROLE_HIERARCHY`. observer & external render grey.

---

## 3. Membership mechanics

### 3.1 External as a role (ADR 0003)
`is_external` boolean was removed; `external` is a stored workspace role. Invariant
(write-time only): `role='external'` ⟺ no `org_membership` row in that org. To promote
external→member: admin removes the external row, adds the user to the org, re-invites
as member (no in-place "convert" button; cross-table mutation is deliberate).

### 3.2 Free observer role (PR #688, ISSUE-030)
Free, read-only, *only in external-client workspaces*. Does NOT consume a seat
(`seat_capacity.py` `_SEAT_ROLES` excludes observer). Internal workspaces reject
observer invites. Upgrade path: admin changes observer→external (now a paid seat).

### 3.3 Visibility & discovery (PRs #700–#705) - `workspace_settings.py`
Three-state `workspace.visibility`:
- *open_to_organisation* - all org members see it; org admins auto-join; free at all tiers; default.
- *invite_only* - invited users + org admins; moving OUT of open requires Innovator+.
- *private* - invited only; org admins do NOT auto-join (org *owner* still carves in).
Moving *out of* open_to_organisation is the only paywalled transition (Innovator+).
Org-admin self-join: admins can discover & join workspaces in their org.

### 3.4 Invites (ADR 0004) - unified modal; `api/v2/invites.py`, `orgs.py`
- Workspace invite `POST /v2/workspaces/{id}/invite` body `{email, role}` where role ∈
  `{admin, member, billing, external, observer}`. Branches: already_member / reactivated /
  added (existing user) / invited (pending row + emailed hash URL, 7-day expiry).
- Org invite `POST /v2/orgs/{id}/invites` role ∈ `{member, admin, billing, owner}`
  (no external at org level).
- *Invite by link* as an alternative to email (PR #672). Accept flow at `/invite/accept`
  handles logged-out / wrong-email / matching-email. Access requests + pending invites
  lists. Role-hierarchy enforced (can't grant a role above your own). Seat cap counts
  pending; observer invites skip the cap.

### 3.5 Seats / metering (`seat_capacity.py`; ADR 0005)
Billable roles `_SEAT_ROLES = {owner, admin, member, billing, external}`; observer free.
Seats are *metered, never blocked* (invites never walled). Seats pooled across a
billing account's workspaces; a person counts once per workspace. `compute_effective_seat_state`
→ (seats_used, member_count, external_count, observer_count).

---

## 4. Tiers & billing (ADR 0005 "per-seat tier overhaul"; supersedes parts of 0001/0002)

Tiers: *Free, Innovator, Changemaker, Guardian* (pilot & pioneer removed). Per seat /
month, EUR, billed yearly by default; *monthly = +15%* (`MONTHLY_BILLING_PREMIUM_PCT=15`).
Tiers stack (each includes everything below).

| Capability | Free | Innovator €20 | Changemaker €75 | Guardian €150 |
|---|---|---|---|---|
| Secure transcription | ✓ | ✓ | ✓ | ✓ |
| Recording hours | 1 h | unlimited | unlimited | unlimited |
| Bring-your-own-LLM + MCP | - | ✓ | ✓ | ✓ |
| Built-in analysis (Gemini) | - | - | ✓ | ✓ |
| Audit logs | - | - | ✓ | ✓ |
| White labeling | - | - | ✓ | ✓ |
| EU-sovereign stack | - | - | - | ✓ |

- *Free*: 1 h recording, single user, open registration, secure transcription. Only tier with an hour cap + the over-cap machinery (ADR 0001 reduces to Free-only).
- *Innovator* (€20/seat): unlimited hours; *no built-in analysis* - chat screen becomes a BYO-LLM integration + MCP (connect ChatGPT/Claude). *Coming soon* (gated on MCP shipping).
- *Changemaker* (€75/seat): the tier most land on. Built-in analysis on EU-hosted *Gemini*, audit logs, white labeling. *Self-serve via Mollie now.*
- *Guardian* (€150/seat): CLOUD-Act-safe EU-sovereign stack (e.g. OVHcloud + sovereign LLMs). *Coming soon* (gated on sovereign stack).
- Bespoke compliance + self-hosting available.
- Existing paying customers migrate to Changemaker (unlimited hours) until renewal.
- Payments via *Mollie* (Stripe legacy). Billing-account split: billing account can be
  org-scoped (pooled) or workspace-scoped (external-client). Free-tier gating (PR #710)
  gates workspaces/transcripts/chat/reports on Free.

---

## 5. Partner program & data ownership

### 5.1 Partner orgs (PR #688, ISSUE-026/028)
`org.is_partner` (staff toggle in Directus / admin). A partner is a trusted agency that
hosts *external-client* workspaces on behalf of others.

### 5.2 External-client workspaces (`billing_account.py` `workspace_is_external_client`)
A workspace is external-client when `usage_context == "external"` (or legacy:
`data_owner_email` set / `billed_to_team_id != org_id`). On creation the host supplies:
`data_owner_org_name`, `data_owner_email`, `partner_agreement_accepted` (checkbox →
`partner_agreement_accepted_at`). Server: sets `usage_context="external"`, creates a
*workspace-scoped billing account* (not the org's pooled one), and *auto-invites the
data owner as a free observer*. Whitelabel (per-workspace logo) is external-only.

### 5.3 Data ownership (PR #697) - internal vs external
Admin-editable: internal workspaces share the org's pooled billing & inherit org
branding; external workspaces name a data owner, bill separately, allow free observers,
support whitelabel. `is_data_owner` boolean (privacy-respecting) shown in workspace list
when the current user's email matches `data_owner_email`.

### 5.4 Handoff / move rules (PRs #688, #694, #698)
Project-move & bulk-move between projects/workspaces; partner→client handoff
(workspace transfer, `staff:can_transfer`). Referral ledger tracks partner kickback
deals (kickback %, discount %, EUR cap, expiry).

---

## 6. Staff / admin panel - `api/v2/admin.py`, `admin_managed.py`, `admin_training.py`; `frontend/src/routes/admin/AdminSettingsRoute.tsx`

Gate: JWT `admin_access == true` (Directus admin). Sections/actions:
- *Usage & billing rollup* `GET /v2/admin/billing-rollup?month_offset=` - per-account &
  per-workspace usage, revenue (trial/managed/comped/paying), MRR forecast, admin contacts,
  CSV export, 12-month lookback, search/tier/status filters.
- *At-risk accounts* `GET /v2/admin/at-risk` - pilot hard-block / at-cap / approaching-cap /
  recently-downgraded, sorted by severity.
- *Workspace actions* (kebab): change tier `PATCH /v2/workspaces/{id}/tier`; change admin
  `POST /v2/admin/workspaces/{id}/change-admin`; reset usage `POST .../reset-usage` (with reason);
  discount `PATCH .../discount` (scholarship/staff_discount/trial, percent).
- *Account actions*: grant reverse trial `POST /v2/admin/billing-accounts/{id}/grant-trial`
  (Changemaker, 1 month, auto-reverts via cron); discount (canonical at account level);
  partner toggle `PATCH /v2/admin/orgs/{id}/partner`.
- *Managed billing* (offline invoicing) `admin_managed.py`: set-managed, assign/clear
  account-manager (@dembrane.com), issue-payment-link, issue-invoice (VAT/e-invoice),
  mark-invoice-paid (out-of-band bank transfer).
- *Payments rollup* `GET /v2/admin/payments` - Mollie transactions, statuses, Mollie deep links.
- *Training* `admin_training.py`: list/create/update trainings (online/in_person/flex),
  complete → grants 1-year `training_license` per user, roster, license edit/revoke.
  Trainings = compliance trainings for high-risk settings. `StaffTrainingPanel`.
- *Referral ledger* `GET /v2/admin/referral-ledger`; *external-led orgs*
  `GET /v2/admin/external-led-orgs` (partner→independent conversion signal).
- *Workspace upgrade requests* (free-tier flow, ISSUE-009–013): submit / list / approve /
  deny; kinds `new_workspace` & `tier_upgrade`; notifications + email digest batching
  (first 5/24h individual, then daily 09:00 UTC digest); tier-expiry + 3-day prewarning crons.

---

## 7. Host feature surface (dashboard) - routes confirmed in `Router.tsx`

Auth: `/login /register /check-your-email /verify-email /password-reset /request-password-reset`.
2FA supported. `/onboarding` wizard (create workspace + project). `/invite/accept`, `/invites`.

- *Workspaces* `/w/:workspaceId/home`, `/w/new`. Settings `/w/:id/settings/:section`:
  name/logo, *assistant context* (host guidance handed to the assistant in every project chat,
  admins, autosaves) + *assistant memory* (workspace-scope notes, view + Remove),
  members (invite/roles/visibility/inherit-org), billing & usage, data ownership.
  Members `/w/:id/members/*`. Org `/o/:orgId`, `/o/:orgId/settings/:section` (admin matrix:
  members × workspaces, access requests, pending invites, discoverable workspaces, org usage rollup).
- *Projects* `/w/:id/projects` (home, pinned, search), create wizard `/new` (name & context →
  access → review; private requires Innovator+), project home `/.../home`.
  Settings `/.../settings/:section`: overview (name/language/visibility, conv toggle, participant-name,
  move project, delete), *portal-editor*, access, usage.
- *Conversations* `/.../conversations` (list, search, filters, bulk move/lock/delete/retranscribe);
  detail `/conversation/:id` (transcript by chunk, copy, PDF download, summary generate/regenerate,
  tags, verified artifacts, lock, anonymisation status, retranscribe, delete).
- *Chat / Ask* `/.../chats/new`, `/.../chats/:chatId` (+ `/debug`): RAG over selected
  conversations; auto-select vs manual context; sources; templates (built-in + user templates);
  standard mode + *agentic mode* (tool use, separate agent service). Free-tier chat gate.
  `ENABLE_AGENTIC_CHAT = byEnv({production:false}, true)` - agentic OFF in production. Where
  it's on, `/chats/new` is the *Ask home*: chat list + a question bar that filters chats and
  creates one on Enter, a `Templates` insert menu, starter chips, and a
  "Prefer the old chat? Start a Specific Details chat" escape hatch. Agentic runs show live
  progress, a Send↔Stop morph, named citation links ("{name}'s conversation" →
  `#chunk-` deep links), and documentation citations via a chooser modal
  ("Open documentation" / "Open chat documentation"). Agent tools (echo/agent, 20): inventory/
  search/transcripts (`listProjectConversations, findConvosByKeywords, listConvoSummary,
  listConvoFullTranscript, grepConvoSnippets`), docs (`listDocs, readDoc, grepDocs, readSkill`),
  settings (`getProjectSettings, proposeProjectUpdate, proposeCustomVerificationTopic` - all
  changes are proposals the host applies via a review card), chats (`listProjectChats,
  readChat` - respects others' private chats), live status (`getLiveConversationStatus`),
  support (`reachOutToDembrane` → `support_request` outbox; never promises follow-up),
  memory (`readMemory, remember` - see memory below), progress (`sendProgressUpdate`).
  *Assistant memory*: one `agent_memory` collection, scope `workspace|project|user` (user scope
  is the only one that may hold personal detail; owner-only). Hosts view + delete (never edit)
  memories via `/v2/bff/memory/*`; surfaces = user settings *Assistant* section, project
  settings *Assistant memory*, workspace settings general tab. The assistant is the only
  writer. *Workspace context* (`workspace.context`): host-written standing guidance, edited on
  the workspace settings general tab ("Assistant context", autosaves), injected into every
  agentic run prompt alongside project context.
- *Monitor* `/.../monitor` (sidebar entry *Monitor*, no role gate): live view of a project's
  recording sessions. *Live participant flow* funnel (canvas, scales to thousands): lanes
  `Scanned → Setting up → Recording`, fed by portal visitor beacons (per-stage outcomes:
  mic ok/skipped/blocked, terms, details). Per-conversation rows: state pills (Recording,
  Paused, Verifying, Exploring, Typing, Finishing, Finished, Waiting, Just started, Idle),
  `Transcribing N clips` chip, `catch up ~N min` backlog estimate, red `Error` badge,
  `Audio stopped?` (stalled) and `Screen locked` (backgrounded) warnings, a live mic-level
  meter (5-bar, from the beacon's `audio_level` 0..1 RMS, shown on `receiving` rows;
  all-quiet hints *check the mic isn't muted*), weak-network and low-battery hints, live
  transcript snippet. Real-time over SSE
  (`GET /v2/bff/conversations/monitor/stream`, Redis-cached snapshot ≤1 Directus read/3s).
  Project home shows a *Live & recent* section embedding the same monitor.
- *Library / analysis* `/.../library`, `/.../library/views/:viewId`,
  `/.../views/:viewId/aspects/:aspectId`: AI-extracted topics/aspects/quotes; custom views;
  library generation (status, regenerate). Gated (Changemaker+ / "contact sales" if unavailable).
- *Reports* `/.../report`: multi-section report builder, timeline, PDF export, scheduling/email.
- *Upload* `/.../upload`: bulk import transcripts (then redirect to conversations).
- *Integrations / export* `/.../integrations`: CSV/Excel/transcript-zip export; *webhooks* (Changemaker+).
- *Host guide* `/.../projects/:projectId/host-guide`: PDF + QR for participants.
- *Portal editor* `/.../settings/portal-editor` (see §8).
- *Settings (user)* `/settings/:section`: account & security (display name, password, 2FA, audit logs),
  my access (orgs/workspaces & roles), appearance (font/size/language; 8 locales), *assistant*
  (Memory card: the caller's own user-scope assistant memories, view + Remove only),
  project-defaults (legal basis). Account deletion: server endpoint only
  (`DELETE /user-settings/account` suspends + marks for purge within 30 days) - NO in-app UI yet;
  don't document a button.
- Sidebar *Documentation* link → Notion Info Hub, locale-aware (see §11).

i18n: 8 locales `en-US, nl-NL, de-DE, fr-FR, es-ES, it-IT, uk-UA, cs-CZ` (Lingui).

---

## 8. Participant portal + portal editor

### 8.1 Portal editor (host-configured) - project settings `portal-editor`
Configures the participant experience: tutorial slug, language, default conversation
title/description/finish text, *transcript prompt* (a.k.a. key terms - proper nouns/jargon
that improve transcription; field `default_conversation_transcript_prompt`), ask-for-name,
ask-for-email, anonymise transcripts, AI title & tags generation, *Get Reply* (audio replay)
mode + prompt, *verification* (enable, on-finish, topics predefined/custom), notification
subscription, portal tags. Live preview. QR + invite link.

### 8.2 Participant flow (portal.dembrane.com) - routes `/:language/:projectId/...`
- *start* - onboarding cards (welcome, instructions, consent/legal, privacy link,
  participant info form if enabled), mic test, language selection. Event `portal_landed`.
- *conversation/:id* - record (chunked S3 upload, pause/resume/stop, level meter, wake lock,
  S3 connectivity check, echo/spike messages). `/text` alternative (type instead of speak).
- *refine* - review/select recorded segments.
- *verify* (+ `/approve`) - select verification topics, approve/reject/modify extracted artifacts.
- *finish* - completion message, optional participant report.
- *report* - participant-facing summary/artifacts. *unsubscribe*.
No account required. Public/participant API in §10.4.

---

## 9. dembrane Go (iOS) - native SwiftUI app (`dembrane-go/`)

Production env, email/password + 2FA login, register. Local-first chunked recording
(30 s chunks, survives crash/kill, background capture, Live Activity / Dynamic Island,
waveform, mic selector), audio-file import. Conversations list/detail (transcript, summary,
title-gen, tags, move, delete, retranscribe, edit). Ask/chat (templates, history, sources,
context picker). Client-side search. *Portal settings* editor (title/description/key-terms)
+ QR share. Settings (project switch, sign out, delete-account-in-browser).
Calls the same `participant/*` upload API + `v2/bff/*`.
Gaps vs web (NOT in iOS): library/analysis, reports, full participant verification flow,
project creation, workspace/org/team management, billing detail, webhooks/export, host guide.
iOS is *ahead* on background recording UX.

---

## 10. Developer surface

### 10.1 Architecture (services)
- *FastAPI backend* (`server/dembrane/`, :8000) - v1 `/api/*` + v2 `/api/v2/*`; BFF layer
  `api/v2/bff/*`; service layer `service/*`. Auth `dependency_auth.py` (Directus JWT;
  cookie `directus_session_token` or `Authorization: Bearer`; `admin_access` claim = staff).
- *Agent service* (`agent/`, :8001) - CopilotKit/LangGraph agentic chat; lease-based in
  Redis; tools: listProjectConversations, findConvosByKeywords, getConversationTranscript.
- *Directus* (:8055) - data layer, auth, file storage (49 collections).
- *Workers* - Dramatiq: `network` queue (gevent, async I/O: transcribe/merge/summary/reports),
  `cpu` queue. Broker Redis. NO asyncio in actors (use gevent / `run_async_in_new_loop`).
- *Scheduler* - APScheduler → Dramatiq dispatch (catch-up + reconcile + billing + digests).
- Infra: PostgreSQL (+pgvector), Redis/Valkey, S3 (MinIO/DO Spaces).

### 10.2 Data model (key collections, Directus)
org → org_membership, workspace → workspace_membership / workspace_invite, project →
conversation → conversation_chunk / conversation_reply / conversation_artifact /
conversation_segment / conversation_project_tag; project_chat → project_chat_message;
project_report (+ metric); project_agentic_run (+ event); view; project_tag;
project_webhook; project_membership; billing_account; workspace_request; app_user;
training (+ training_license); verification_topic; processing_status; notification;
announcement; access_request; referral_ledger.

### 10.3 Processing pipeline
Upload chunk → S3 (presigned) → `task_transcribe_chunk` (AssemblyAI webhook/poll OR LiteLLM)
→ `task_correct_transcript` (Gemini: hotwords + PII redaction; diarization schema
"Dembrane-25-09" / "…-26-01-redaction") → coordination counter → when 0 & finished →
`task_finalize_conversation` → `task_merge_conversation_chunks` + `task_summarize_conversation`
(Gemini). Reports = two-phase (fan-out summaries → generate). Chat: overview (summaries) vs
deep_dive (transcripts). Redis locks for idempotency. SSE progress via Redis pub/sub.
LLM via LiteLLM Router groups: MULTI_MODAL_PRO (Gemini 2.5 Pro), MULTI_MODAL_FAST (Flash),
TEXT_FAST (legacy). Config `docs/litellm_config.md`, env `LLM__<GROUP>[_n]__*`.

### 10.4 Public / participant API (`server/dembrane/api/participant.py`, unauthenticated)
`GET /api/participant/projects/{pid}` (public project meta), `.../conversations/{cid}`,
`.../chunks`; `POST .../conversations/initiate` `{name,email?,tag_id_list?,source?}`;
`POST /api/participant/conversations/{cid}/get-upload-url` (presigned, 40/min),
`/confirm-upload`, `/upload-chunk` (multipart), `/upload-text`, `/check-s3`; participant
report endpoints. OpenAPI at `/docs` + `/redoc` only when `SERVE_API_DOCS=1`.

### 10.5 Webhooks (Changemaker+) `service/webhook.py`
Events: `conversation.started`, `conversation.transcribed`, `conversation.summarized`,
`report.generated`. CRUD `GET/POST/PATCH/DELETE /api/projects/{pid}/webhooks` (+ `/test`,
`/copyable`). HMAC-SHA256 `X-Dembrane-Signature` when secret set.

### 10.6 Export
`GET /api/projects/{pid}/transcripts` → zip of per-conversation markdown.
`GET /api/conversations/{cid}/transcript` → plain text. Reports via create-report task.

### 10.7 MCP / BYO-LLM
ADR 0005 Innovator tier: MCP server to connect ChatGPT/Claude. *Coming soon* (not shipped).
The `.mcp.json` in repo is for internal dev tooling, not an exposed dembrane MCP.

### 10.8 Self-hosting (`echo/readme.md`, `mprocs.yaml`, `.devcontainer/`)
Dev container (pnpm + uv + Postgres + Valkey + Directus). `mprocs` runs server / workers /
workers-cpu / scheduler / admin-dashboard(:5173) / participant-portal(:5174). Bring your own
S3 or run MinIO. Configure `server/.env` (+ `.env.sample`), `directus/.env`. EU residency:
SendGrid EU subuser, Vertex europe-west*, EU S3 endpoint.

### 10.9 Licensing & contributing (repo root)
*BSL 1.1*: non-production unrestricted; production free if total finances ≤ €1M/12mo;
Change Date = release + 3y → GPLv3. CLA required (Dembrane B.V. perpetual licence over
contributions). CONTRIBUTING: security/privacy PRs prioritised; tests + style + docs required.
Security disclosures → sameer@dembrane.com. Community Slack link in config.
Contacts: sameer@ (PRs/security), bram@ (legal/stewardship), jorim@ (mission/press),
evelien@ (hosting/commercial).

### 10.10 Deployment
main auto-deploys to "echo-next" after merge (~2 min); tags every ~2 weeks → production.
testing branch = shared staging (reset to main after). GitOps repo `echo-gitops`
(Terraform DO + Helm + Argo). Dockerfiles: server / agent / directus / tools/usage-tracker.
DB migrations doc `docs/database_migrations.md`; release doc `docs/branching_and_releases.md`.
ADRs in `echo/docs/adr/`.

---

## 11. Existing docs (what we are replacing/superseding)

1. *Notion "Info Hub"* - what the dashboard sidebar "Documentation" link points to,
   locale-aware via `config.ts getDocumentationUrl(locale)`:
   - EN: https://dembrane.notion.site/Info-Hub-Welcome-to-dembrane-26f9cd84270580049be7cb1e7a472162
   - NL: https://dembrane.notion.site/Welkom-bij-het-info-portaal-van-dembrane-2959cd842705804c815ac315464b6fa0
   Content (marketing/onboarding flavoured, still uses "ECHO" branding): Start Here
   (First Steps with ECHO Dashboard, How to Record your first Conversation, First Aid),
   Resources (Who is Dembrane?, Blog, Case studies, Designing a session, FAQs, Prompt
   Library, Reporting a Bug, Compliance & Trust), toggles for Setting-up a project /
   Recording / Analysing / Templates / Ready-Check-Go / Designing a session / Upload docs.
   Also links to docs.dembrane.com for First Aid + bug reporting.
2. *docs.dembrane.com* = the Nextra site `echo-user-docs/` (en-US + nl-NL): Getting Started
   (creating-project, collecting-data, analysis), Core Concepts, First Aid, Avoiding Pitfalls
   (technical, social). Thin, "under construction", off-brand ("ECHO").
3. *echo/docs/* = developer/internal docs (ADRs, plans, issues, litellm config, migrations).

These are the baseline our new docs replace: comprehensive, role-segmented, on-brand,
bilingual (en-UK default + nl-NL), per-feature AND per-user-type.

Other useful external links (from `config.ts`):
- Privacy statements (all languages): notion.site/Privacy-statements-all-languages-…
- Legal: www.dembrane.com/legal/{terms,privacy,DPA} (may 404 for now).
- Community Slack invite (see config).
