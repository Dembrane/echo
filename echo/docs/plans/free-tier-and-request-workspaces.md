# Free tier + Request-to-create workspaces + No hard limits

## Context

The workspaces "big bang" (#558) shipped two weeks ago. Three changes need to land before we proceed:

1. **New `free` tier** replaces `pilot` as the default for new workspaces (1 seat, 1 hr/mo, no overage). Pilot stays as a paid trial tier but is no longer the post-signup default.
2. **No hard limits anywhere.** Recording from the portal must NEVER fail, on any tier. When a free or pilot workspace exceeds its hours (these tiers don't allow overage), we gate consumption instead of blocking recording:
   - **Recording continues.** New portal conversations are recorded and transcribed normally.
   - **Each new conversation created after the cap is marked over-cap.** Its transcript is hidden behind an upgrade overlay; new chats cannot be started on it.
   - **Pre-cap conversations stay fully usable.** Their transcripts are visible and chat over them still works (including new chat sessions on those pre-cap conversations).
   - **Existing chat threads stay fully open** (history + send + stream) even if their underlying conversation later transitions to over-cap. Only NEW chat threads on over-cap conversations are blocked.
   - **Host "upload audio" section is locked** while the workspace is over cap.
   - Pioneer and above: nothing is locked. Overage warning + billing continues as today.
3. **Self-serve workspace creation is removed.** The existing 4-step wizard's final button changes from "Create workspace" to "Request workspace". A new `workspace_request` collection captures both new-workspace and tier-upgrade requests. Staff approve/deny from a new `/admin/upgrades` page. All parties get in-app notifications and emails.

Also bundled:
- After tier expiry, workspaces auto-downgrade to `free` with notification.
- Each new user gets ONE free-tier workspace auto-created at onboarding (we already create one — just change the tier).
- Two new workspace fields: `type_discount` (text — scholarship / staff_discount) and `percent_discount` (number, tier-level only). Staff edit, users read-only.
- **Guests count toward the main seat pool.** The separate guest cap goes away. Guest role/permissions stay (guests still have read-mostly access per `policies.py`); they just no longer have a parallel limit. Invites continue to offer "member" or "guest" as the role choice.

---

## Architecture decisions

- **Unify "new workspace request" and "tier upgrade request" into one `workspace_request` collection** with a `kind` discriminator (`new_workspace` | `tier_upgrade`). Both flow through the same `/admin/upgrades` page. Avoids two parallel staff inboxes.
- **Tier capability stays in `tier_capacity.py`** as the single source of truth (`TIER_CAPACITIES` dict). Tier ordering lives separately in `policies.py:21` as `TIER_ORDER` — both need the `free` entry. Replace the binary `hard_block_on_hours` with `allow_overage: bool` framing where appropriate, and stop hard-blocking host ops on pilot — we gate UI instead.
- **Gating is two-level:** workspace-level (`uploads_locked` for the host upload section) and conversation-level (`is_over_cap` stamped on each conversation at creation time). The conversation flag is captured at creation rather than computed live, so previously-recorded conversations don't retroactively lock if the workspace later crosses its cap, and don't retroactively unlock if usage drops — matches "previous conversations before locking" semantics from the user.
- **Frontend reads** workspace `usage_gates: { uploads_locked, over_cap_active, upgrade_cta_tier }` and per-conversation `is_over_cap` from existing conversation responses.
- **Workspace creation endpoint stays** (`POST /v2/workspaces`) but becomes staff-only (used by the approval handler). Self-serve path becomes `POST /v2/workspace-requests`.

---

## Implementation plan

### 1. Directus schema changes (one Python script: `scripts/add_free_tier_and_requests.py`)

Following `scripts/create_schema.py` pattern from the workspaces big bang.

**1a. Extend `workspace.tier` enum**
- Add `"free"` to the enum choices in `directus/sync/snapshot/fields/workspace/tier.json`
- Change DB default from `"pioneer"` to `"free"` (line 53)

**1b. New fields on `workspace`**
- `tier_expires_at` — timestamp, nullable. **Optional.** Staff may set this at approval/upgrade time; if null, the workspace never auto-expires (matches today's behavior for paid tiers). When set and elapsed, the hourly cron downgrades the workspace to `free` (see 2h).
- `type_discount` — string, nullable, enum: `scholarship` | `staff_discount`. **Directus permissions:** staff write, all workspace members read. Surfaced in the staff CSV export (see 3d).
- `percent_discount` — integer 0-100, nullable. **Applied at the tier subscription price only** — it does NOT discount overage charges, add-on seats beyond `seats_included`, or any à la carte item. Documented in a code comment next to the field. **Directus permissions:** staff write, all workspace members read. Surfaced in the staff CSV export (see 3d).

**1c. New collection: `workspace_request`** (unified — confirmed by user)

Audit + visibility fields are explicit (rather than derived from `created_at` / status changes) so the admin UI and ledger queries are simple to read.

Identity & routing:
- `id` (uuid)
- `kind` (enum: `new_workspace` | `tier_upgrade`)
- `status` (enum: `pending` | `approved` | `denied`, default `pending`)

Requester side (what the user asked for):
- `requested_by` (user m2o)
- `requested_at` (timestamp, default `now()`)
- `org_id` (org m2o) — target org for new workspace; existing org for upgrade
- `workspace_id` (workspace m2o, nullable) — `null` for `new_workspace` until approved; set for `tier_upgrade`
- `proposed_name` (string, nullable) — only for `new_workspace`
- `proposed_tier` (string enum, default `free`)
- `proposed_visibility` (enum: `open_to_organisation` | `private`, default `open_to_organisation`) — new-workspace privacy
- `proposed_inherit_organisation_admins` (bool, default `true`) — mirrors current create flow
- `proposed_type_discount` (enum, nullable) — what the requester is asking for
- `proposed_percent_discount` (integer 0-100, nullable)
- `requester_message` (text, max 1000)

Approval side (what staff did):
- `approved_at` (timestamp, nullable)
- `approved_by` (user m2o, nullable)
- `granted_tier` (string enum, nullable) — what was actually granted (may differ from proposed)
- `granted_tier_expires_at` (timestamp, nullable) — **optional** expiry; only set if staff explicitly chose one at approval. Null means no expiry (current default behavior for paid tiers).
- `granted_type_discount` (enum, nullable) — what staff actually applied
- `granted_percent_discount` (integer 0-100, nullable)
- `resulting_workspace_id` (workspace m2o, nullable) — points to created (new_workspace) or upgraded (tier_upgrade) workspace. Same as `workspace_id` for upgrades; populated on new_workspace approval.

Denial side:
- `denied_at` (timestamp, nullable)
- `denied_by` (user m2o, nullable)
- `denial_reason` (text, nullable)

Internal:
- `staff_notes` (text, nullable) — staff-only internal notes, never shown to requester
- `created_at`, `updated_at` (DB-managed standard timestamps)

Directus permissions:
- Requesters: read-only on their own rows (filtered by `requested_by = $CURRENT_USER`), create with limited fields (kind, org_id, workspace_id, proposed_*, requester_message).
- Staff: full read/write on all rows.
- `staff_notes` field-level locked to staff role.

After running the script: `cd directus && bash sync.sh -u http://directus:8055 -e admin@dembrane.com -p admin pull` then commit the snapshot diff.

---

### 2. Backend (Python)

**2a. `server/dembrane/tier_capacity.py` + `server/dembrane/policies.py`** — single source of truth
- In `policies.py:21`, prepend `"free"` to `TIER_ORDER` so it becomes `["free", "pilot", "pioneer", "innovator", "changemaker", "guardian"]`.
- In `tier_capacity.py`, add `TIER_CAPACITIES["free"]` using the existing dataclass field names: `included_seats=1, included_hours=1, hard_block_on_hours=False, hour_overage_eur=None, seat_overage_eur=None, guest_cap=1` (the `guest_cap` field gets removed entirely in 2g below, so this is transient — set it to `1` for the brief window before 2g lands, or sequence 2g first).
- Stop setting `hard_block_on_hours=True` on pilot — overage stays disabled (`hour_overage_eur=None`), but no 403 hard block anywhere. Update `is_hard_blocked()` to always return False (keep the function for call-site compat; mark deprecated).
- Add new helper `compute_usage_gates(tier, hours_lifetime, hours_this_month) -> UsageGates`. Two-regime cap (see ADR 0001):
  - For `free` and `pilot` (lifetime cap regime): compare `hours_lifetime >= cap.included_hours`. Bucket never refills.
  - For `pioneer+` (monthly cap regime): never sets the gate flags (overage is allowed). Pass `hours_this_month` for billing-display purposes only.
  - Returns `over_cap_active`, `uploads_locked` (both true for free/pilot at-or-past cap; both false otherwise).
- Add `tier_allows_overage(tier) -> bool` helper (`pioneer/innovator/changemaker/guardian` true; `free/pilot` false). Use this in the over-cap conversation-stamp logic.

**2b. `server/dembrane/api/v2/workspaces.py`**
- **Remove** the hardcoded `"tier": "pilot"` at line 596. Make the `POST /v2/workspaces` endpoint accept `tier` from caller and require staff role (it's now an internal admin endpoint used by the approval handler).
- **Remove** the existing email-only `POST /v2/workspaces/{id}/upgrade-request` (lines 881-951). Migrate this to the new workspace_request collection.
- Update `_get_workspace_usage()` to include the `usage_gates` block computed via `compute_usage_gates()`.
- Update `UsageResponse` Pydantic schema (`api/v2/schemas.py`) to include `usage_gates: UsageGates`.

**2b-bis. Conversation `is_over_cap` stamp + live lock**

See `docs/adr/0001-over-cap-conversation-model.md` for the full rationale.

- New Directus field on `conversation`: `is_over_cap` (bool, default false, not editable by users). Durable accounting stamp.
- **Stamp at finish, not creation.** Wire into the existing finish hook (`api/participant.py:632 run_when_conversation_is_finished` is one trigger; also wherever a host upload finishes). Formula:
  - `is_over_cap = NOT tier_allows_overage(workspace.tier) AND (workspace.audio_hours_all_time − this_conversation.duration) >= cap.included_hours` where `cap = get_capacity(workspace.tier)`.
  - Soft edge: subtract this conversation's own duration before comparing. A conversation that started under cap stays unlocked even if its recording crossed the cap.
  - Free/pilot have lifetime caps, so use `workspace.audio_hours` (all-time). Pioneer+ allow overage, so the formula evaluates to `false` and stamping is a no-op.
- **The lock is live-computed, not stored.** In BFF (`server/dembrane/api/v2/bff/conversations.py`), expose a derived `locked: bool` per conversation: `locked = conversation.is_over_cap AND NOT tier_allows_overage(workspace.current_tier)`. Do NOT expose raw `is_over_cap` to the frontend — frontend reads `locked` only. Raw stamp is admin/CSV only.
- In `list_chunks()` / `get_chunk()`: when `locked` is true, scrub the `transcript` field from chunk responses (return `transcript=null`) and add `transcript_locked: true` on the chunk envelope. Audio fields stay intact.
- **Tier upgrade auto-unlocks.** No batch update needed — the live formula handles it. Tier *downgrade* re-locks the previously-over-cap conversations (this matches ADR 0001's "downgrade does not re-stamp" because the stamp is durable; only the live gate is sensitive to current tier).
- **Pilot → free downgrade does NOT re-stamp.** Pilot-trial content stays readable on free forever, even though the workspace is now massively over the 1-hour free cap. Conversations created on pilot were never stamped (pilot stamp uses pilot's 10-hour cap), so they stay `is_over_cap=false` and the live gate keeps them unlocked.
- **Chat link gating** (Q8 from grilling): enforce at the `project_chat_conversation` insert and at auto-select pickup in `chat.py:1058+`. Reject inserts where the target conversation's live `locked` is true with a 402 + structured error code. Pre-existing links and running chats are unaffected; the LLM receives the full transcript text of pre-existing links.

**2c. New router: `server/dembrane/api/v2/workspace_requests.py`**
- `POST /v2/workspace-requests` — auth'd users create a request. For `new_workspace`: validate user is org admin/owner (same check as today). For `tier_upgrade`: require workspace admin/billing.
- `GET /v2/admin/workspace-requests` — staff-only list, filterable by status.
- `PATCH /v2/admin/workspace-requests/{id}` — staff approve/deny. Body: `{ action: "approve" | "deny", denial_reason?, override_tier?, override_discount? }`.
  - On approve+new_workspace: create the workspace via the existing creation helper (factored out of the old endpoint), populate `workspace_id`, emit `WORKSPACE_REQUEST_APPROVED`, email requester.
  - On approve+tier_upgrade: call existing `PATCH /v2/workspaces/{id}/tier` logic (factor into a helper), emit the same notification + email.
  - On deny: set status, store reason, emit `WORKSPACE_REQUEST_DENIED`, email requester.

**2d. `server/dembrane/notifications.py`**
- Add event codes: `WORKSPACE_REQUEST_SUBMITTED` (action_required, audience = staff), `WORKSPACE_REQUEST_APPROVED` (info, audience = requester), `WORKSPACE_REQUEST_DENIED` (info, audience = requester), `TIER_EXPIRED` (destructive, audience = workspace admins/billing).
- Add staff audience helper `audience_staff()` (queries Directus users with `admin_access=true`).

**2e. Email templates: `server/email_templates/`**
- `workspace_request_submitted.html` / `.txt` — to staff
- `workspace_request_approved.html` / `.txt` — to requester (with link to new/upgraded workspace)
- `workspace_request_denied.html` / `.txt` — to requester (with denial reason)
- `tier_expired.html` / `.txt` — to workspace admins+billing

All extend `_layout.html` and follow the `tier_downgraded.html` pattern.

**2f. Onboarding — auto-seed one free workspace for new owners**

This is the "after registration → ONE ws with free tier" requirement.

- Change `tier='pilot'` to `tier='free'` on the auto-created personal workspace (`server/dembrane/api/v2/onboarding.py:484`).
- **Eligibility rule:** the auto-seed runs only for users who register through the standard direct-registration path. Users who register by accepting an invite to someone else's workspace do NOT get a personal free workspace; they only get added to the inviting workspace.
- **Duplicate guard:** if the user already owns/admins a workspace (returning users, re-running onboarding), skip the seed. The check is `exists(workspace_membership where user_id=$me AND role in ('owner','admin') AND is_external=false)`.
- **System seeding, not user creation:** the seed calls the staff-only `POST /v2/workspaces` endpoint server-side (no `workspace_request` row is filed). Bypassing the request flow is intentional — only USER-initiated workspace creation goes through requests. Document this in a code comment at the call site.
- Subsequent workspaces (after the seed) for this same user must go through the request flow.

**2g. Unify guests into the main seat pool**
- `server/dembrane/tier_capacity.py` (lines 33, 50, 64, 78, 92, 106): remove the `guest_cap` field from `TierCapacity` and from every tier entry. Keep `included_seats` (the existing field name) as the only seat limit (`pilot=2`, `pioneer=3`, `innovator=10`, `changemaker=20`, `guardian=None` for unlimited, and `free=1` from 2a).
- `server/dembrane/seat_capacity.py`:
  - `compute_effective_seat_state()` (line ~54): count distinct users regardless of `is_external`. The current branch at line 74 that splits members vs guests into separate buckets becomes a single combined seat count. Still expose `member_count` and `guest_count` separately in the response for UI breakdown, but `seats_used` is the sum and is what enforces the cap.
  - Remove the dedicated guest-overflow gate at line ~193 (`Raise 402 if adding a guest…`). Replace with a unified `seats_used >= cap.included_seats` check that fires for both member and guest invites.
- `server/tests/test_seat_capacity.py`: update fixtures (esp. lines 67, 162-189) to assert the unified model — guests + members share one cap.
- `scripts/matrix_smoke.py` (lines 93, 100): remove `guest_cap` from the expected matrix tuple.
- Frontend: remove `guest_cap` / `guest_cap_hit` references and merge displays into one seat line.
  - `frontend/src/components/workspace/SeatCapBanner.tsx` (lines 37, 79, 114): drop the guest-specific banner branch; one banner reads "X / Y seats used".
  - `frontend/src/components/workspace/UsageCard.tsx` (lines 42, 287-290): drop guest cap row; can still show a small "(N members + M guests)" breakdown chip below the seat bar.
  - `frontend/src/components/workspace/OrganisationUsageRollup.tsx` (lines 85-86, 447-448): drop guest_cap columns.
  - `frontend/src/components/workspace/TierCapacityMatrix.tsx` (lines 17, 63-64): remove the guest-cap row from the pricing matrix.
  - `frontend/src/routes/admin/AdminSettingsRoute.tsx` (lines 107-108, 1067-1068, 1178, 1197): drop `guest_cap` / `guest_cap_hit` columns and CSV export field.
  - `frontend/src/routes/workspaces/WorkspaceSettingsRoute.tsx` (lines 329, 352-353): drop the local guest-cap usage probe; rely on the unified seats check.
- `is_external` itself stays — it still drives role/permissions (`policies.py` line 232 maps it to the `guest` policy role). Only the cap concept is unified.

**2h. Tier expiry → auto-downgrade to free + notification**

This is the "after expiry tier → move to free, send notification" requirement.

- New Dramatiq actor in `server/dembrane/tasks.py`: `task_expire_workspace_tiers()`.
- Query: workspaces where `tier_expires_at IS NOT NULL AND tier_expires_at < now() AND tier != 'free'`.
- For each match, in a single transaction:
  1. Set `tier = 'free'`.
  2. Populate `downgraded_at = now()` and `downgraded_from_tier = <previous tier>` (reuses existing downgrade fields, so the 7-day "you were downgraded" banner just works).
  3. Clear `tier_expires_at`.
  4. Run existing `tier_downgrade.apply_downgrade_effects()` so revert/freeze policies (whitelabel, api_access, webhooks, etc.) fire automatically.
  5. Emit `TIER_EXPIRED` in-app notification to audience = workspace admins + billing.
  6. Queue `task_send_tier_expired_email.send(workspace_id)` which renders `tier_expired.{html,txt}` and sends to admins + billing.
- Schedule in `server/dembrane/scheduler.py`: hourly cron `CronTrigger(minute="0")`.
- Workspaces with `tier_expires_at IS NULL` are skipped — paid tiers never auto-expire unless staff explicitly set a date.
- Idempotency: an already-`free` workspace with a past `tier_expires_at` is a no-op (filter excludes it). Re-running the actor produces no duplicate notifications.

---

### 3. Frontend (React)

**3a. `frontend/src/lib/tiers.ts`**
- Add `"free"` to the `Tier` union; prepend to `TIER_ORDER`.
- `TIER_SEAT_OVERAGE_EUR.free = null`; same for hour overage.

**3b. Workspace creation wizard: `frontend/src/routes/workspaces/CreateWorkspaceRoute.tsx`**
- Final-step button (line 442) text → "Request workspace".
- Submit handler POSTs to `/v2/workspace-requests` with `kind: "new_workspace"`, not `/v2/workspaces`.
- Success state changes from "Workspace created → redirect" to "Request submitted, you'll get a notification once it's approved" — keep the modal open, show confirmation panel, close on dismiss.
- Tier acknowledgment step (line 596) updates copy: "Tier: Free · 1 seat, 1 hour/month".

**3c. Gating UI**
- Extend the workspace usage hook to surface `usage_gates`. Conversations carry `is_over_cap` already in their responses.
- **Per-conversation transcript lock:** in `ProjectConversationTranscript.tsx` and `ConversationChunkAudioTranscript.tsx`, when the conversation's `is_over_cap` is true, render a single LockedTranscriptOverlay (new component, model on existing `FeatureGate`) that hides transcript text and shows "Upgrade to view transcripts" CTA. Audio player stays accessible.
- **Library view (`ProjectLibrary.tsx`):** for over-cap conversations, hide the transcript snippet and add a small lock chip.
- **Host upload section:** when `usage_gates.uploads_locked`, hide the upload button and show a gate card. Locate during impl (likely under `frontend/src/routes/project/...`).
- **Chat:** when the user tries to start a new chat on an over-cap conversation, disable the "Start chat" button with a tooltip that explains it; existing chat threads continue to load and stream normally.
- **Critically do NOT gate:** the participant portal recording (`ParticipantConversationAudio.tsx`) or text upload — these stay open per the "recording never fails" requirement.

**3d. `/admin/upgrades` page**
- New route under `frontend/src/routes/admin/` (sibling to `AdminSettingsRoute.tsx`).
- List tabs: Pending / Approved / Denied.
- Each row: kind, requester, org, target tier, message, created_at, action buttons.
- Approve dialog: optional override tier, optional discount fields (`type_discount`, `percent_discount`), confirm.
- Deny dialog: required reason text.
- Add nav link in `Header.tsx` admin section (gated on `me.is_staff`).

**3e. Discount display & export**
- **User-facing (read-only):** on the workspace settings page, show `type_discount` and `percent_discount` as read-only chips when set. Members + admins + billing all see the chips, none can edit.
- **Staff write:** in the `/admin/upgrades` approve dialog AND on a workspace's admin detail view, staff can edit `type_discount` (scholarship / staff_discount / none) and `percent_discount` (0-100).
- **Staff export:** extend the existing admin workspaces CSV export (used in `AdminSettingsRoute.tsx`) to include the two new columns `type_discount`, `percent_discount`. Tier and `tier_expires_at` columns also belong in this export.

---

### 4. Critical files to modify

| File | Change |
|------|--------|
| `directus/sync/snapshot/fields/workspace/tier.json` | Add `free` enum + change default |
| `directus/sync/snapshot/collections/workspace_request.json` | New collection (via script) |
| `directus/sync/snapshot/fields/workspace_request/*.json` | New fields (via script) |
| `directus/sync/snapshot/fields/workspace/{tier_expires_at,type_discount,percent_discount}.json` | New fields (via script) |
| `scripts/add_free_tier_and_requests.py` | New idempotent schema script |
| `server/dembrane/tier_capacity.py` | Add free tier, soften hard block, add `compute_usage_gates`, **remove `guest_cap`** |
| `server/dembrane/seat_capacity.py` | Unify guests into the main seat pool; remove guest-only 402 gate |
| `server/tests/test_seat_capacity.py` | Update assertions to the unified seat model |
| `scripts/matrix_smoke.py` | Drop `guest_cap` from expected matrix |
| `frontend/src/components/workspace/SeatCapBanner.tsx` | Single unified seat banner |
| `frontend/src/components/workspace/OrganisationUsageRollup.tsx` | Drop guest_cap columns |
| `frontend/src/components/workspace/TierCapacityMatrix.tsx` | Drop guest_cap row |
| `frontend/src/routes/workspaces/WorkspaceSettingsRoute.tsx` | Drop local guest-cap probe |
| `server/dembrane/api/v2/workspaces.py` | Gate POST to staff-only; remove email-only upgrade-request; add `usage_gates` to UsageResponse |
| `server/dembrane/api/v2/workspace_requests.py` | New router (create/list/approve/deny) |
| `server/dembrane/api/v2/__init__.py` | Register new router |
| `server/dembrane/api/v2/schemas.py` | Add `UsageGates`, `WorkspaceRequest*` schemas |
| `server/dembrane/api/v2/onboarding.py:484` | `tier='pilot'` → `tier='free'` (and guard against duplicate) |
| `server/dembrane/notifications.py` | Add 4 new event codes + `audience_staff()` |
| `server/dembrane/tasks.py` | New `task_expire_workspace_tiers` actor |
| `server/dembrane/scheduler.py` | Hourly cron for the expiry task |
| `server/email_templates/workspace_request_{submitted,approved,denied}.{html,txt}` | New |
| `server/email_templates/tier_expired.{html,txt}` | New |
| `frontend/src/lib/tiers.ts` | Add `free` to union + TIER_ORDER |
| `frontend/src/routes/workspaces/CreateWorkspaceRoute.tsx:442,596` | Button copy + endpoint + success state |
| `frontend/src/routes/admin/AdminUpgradesRoute.tsx` | New page |
| `frontend/src/routes/admin/index.ts` (or router) | Register `/admin/upgrades` |
| `frontend/src/components/layout/Header.tsx` | Admin nav link |
| `frontend/src/components/workspace/UsageCard.tsx` | Read `usage_gates` |
| `frontend/src/components/conversation/ConversationChunkAudioTranscript.tsx` | Locked overlay |
| `frontend/src/routes/project/conversation/ProjectConversationTranscript.tsx` | Locked overlay |
| `frontend/src/routes/project/library/ProjectLibrary.tsx` | Locked snippets |
| Host upload component (TBD during impl) | Hide section when `uploads_locked` |

---

## Verification

1. **Directus schema** — run `scripts/add_free_tier_and_requests.py` twice; second run is a no-op. `cd directus && bash sync.sh ... pull` produces a clean diff matching the new snapshot.
2. **Onboarding (direct registration)** — sign up a fresh user via the standard signup path → exactly one workspace exists, `tier=free`, `is_default=true`, user is owner.
2b. **Onboarding (via invite)** — register a new user by accepting an invite to an existing workspace → user joins the inviting workspace, **no** personal free workspace is auto-created.
2c. **Onboarding re-run** — re-trigger onboarding for an existing user who already owns a workspace → no new workspace is created (duplicate guard).
3. **No self-serve create** — as a regular user, the wizard's last step says "Request workspace"; submitting creates a `workspace_request` row with `status=pending`; no workspace is created. Staff and requester (other staff/requester) both get notifications + emails.
4. **Admin approve** — staff visits `/admin/upgrades`, sees the pending request, approves it (with/without discount fields) → workspace is created, request `status=approved`, `workspace_id` populated, requester gets notification + email with a deep link.
5. **Admin deny** — denial with reason → request `status=denied`, requester gets notification + email containing the reason.
6. **Recording always works** — on a free-tier workspace at 1.5 hr usage, the participant portal records and uploads chunks successfully (no 403/blocking).
7. **Gating active for free/pilot at cap**
   - At >= 1 hr usage on free tier: record a new portal conversation → it succeeds, chunks land, but its `is_over_cap=true`, its transcript is hidden in the host dashboard, and "Start chat" on it is disabled.
   - A conversation created BEFORE the cap was hit: stays fully usable (transcript visible, new chats startable, existing chats keep streaming).
   - Host upload section: hidden / replaced with the upgrade gate.
   - Audio playback: available everywhere (including over-cap conversations).
8. **Pioneer+ unaffected** — at 1.5x hours on pioneer, transcripts and uploads remain visible; overage continues to bill as today.
9. **Tier expiry** — manually set `tier_expires_at` to past on a pioneer workspace, trigger the cron actor by hand → workspace tier becomes `free`, `downgraded_from_tier=pioneer`, `downgraded_at` set, `TIER_EXPIRED` notification + email delivered.
10. **Guests count as seats** — on a pioneer workspace (3 seats), invite 2 members and 1 guest → seat counter shows `3/3`. A 4th invite (member or guest) is blocked by the same banner. No separate guest cap message anywhere.
11. **Tests**:
    - Backend unit: `compute_usage_gates()` matrix (each tier × under/at/over cap)
    - Backend unit: `compute_effective_seat_state()` counts members+guests as one pool; invite blocking fires on the unified cap regardless of role.
    - Backend integration: approve/deny endpoints produce the right side effects
    - Frontend: usage gate renders the lock overlay when flag is true
    - `scripts/matrix_smoke.py` passes without the removed `guest_cap` field.
    - i18n: new strings added to `.po` files, `pnpm messages:compile` runs clean

---

## Style notes (from CLAUDE.md + memory)

- No em dashes in user-facing copy. Don't say "AI", "successfully", or use bold for emphasis.
- "Request workspace" (not "Request a new workspace") on the button to keep it short.
- Comments stay terse — one line max.
- Dutch translations: informal `je/jij`.
- No new alert stacks (use one alert at a time for gate messaging).

## Decisions from grilling session (2026-05-11)

These supersede or clarify earlier text in the plan:

- **Free is the permanent floor, not time-bounded.** No `tier_expires_at` on free; the 1-hour cap is a lifetime cap, not monthly. Only pilot has `tier_expires_at = +1 month`. Cap regimes split: free/pilot lifetime, pioneer+ calendar-monthly.
- **`is_over_cap` stamp moved from creation to finish.** Formula: `NOT tier_allows_overage(tier) AND (workspace.audio_hours − this_conversation.duration) ≥ workspace.hours_included`. Soft edge — conversations that started under cap stay unlocked. See `docs/adr/0001-over-cap-conversation-model.md`.
- **Live gate, no batch updates.** Locking is computed: `locked = is_over_cap AND NOT tier_allows_overage(workspace.current_tier)`. No on-upgrade sweep, no monthly reset hook. Frontend reads a derived `locked` from the BFF, not the raw stamp.
- **Pilot → free downgrade does not re-stamp.** Pilot-trial content stays readable on free forever.
- **`POST /v2/workspace-requests` is paid-tiers only.** The picker contains pilot/pioneer/innovator/changemaker/guardian. Default = **innovator** (not free, not pioneer). Free is unrequestable.
- **Discount is staff-granted, never user-proposed.** Drop `proposed_type_discount` and `proposed_percent_discount` from `workspace_request`. Keep `granted_*` on the staff side. Users supply context in `requester_message`.
- **Onboarding seed.** Existing branch logic in `onboarding.py` (only seed when user has projects or no internal invites) is already correct. Change is *only* `tier='pilot'` → `tier='free'` at line 484. No additional duplicate guard needed.
- **Existing pilot `tier_expires_at` backfill: grandfather as NULL.** Cron only catches workspaces where staff explicitly set the date.
- **Guest unification migration: none.** Pre-prod; if real customers land in the "now over-cap" state at ship time, handle by hand.
- **Approval model is manual touchpoint, ~1 day turnaround.** Submission notification copy: "Thanks — we'll be in touch within 1 business day." Schema is neutral toward future automated billing.
- **Chat link insertion is the gate.** Enforce at `project_chat_conversation` insert + auto-select pickup at `chat.py:1058+`. Pre-existing links and running chats are unaffected; LLM sees full transcript content of pre-existing links.
- **Free workspace is strict 1 seat.** Owner takes the seat. Member or guest invites both fail with 402 until upgrade. Portal participants unaffected.
- **Lock UX for `ProjectUploadSection`:** replace with an upgrade-prompt card; don't show a disabled dropzone.
- **Tier-expiry pre-warning email**: send `TIER_EXPIRING_SOON` 3 days before `tier_expires_at`. New event code, audience = workspace admins + billing. Cron same as `task_expire_workspace_tiers`, query is `tier_expires_at BETWEEN now() AND now() + interval '3 days' AND NOT pre_warning_sent`. Add a `pre_warning_sent` boolean on workspace to avoid duplicate emails.
- **Workspace_request schema trim.** Replace separate `approved_at`/`approved_by`/`denied_at`/`denied_by` with `decided_at` (timestamp) + `decided_by` (user m2o) — status already records which (approved/denied). Drop `requested_at` (use `created_at`). Drop `proposed_inherit_organisation_admins` (set to `true` for everyone; mirrors the only path that exists today). Keep all `proposed_*` (minus discounts) and `granted_*` so the audit trail of "what was asked vs what was granted" stays queryable.
- **Notification batching for staff.** New `WORKSPACE_REQUEST_SUBMITTED` event creates an in-app notification per submission (cheap) but emails are batched: if a staff member has received >5 request-submission emails in the trailing 24h, switch to a daily digest at 09:00 UTC until rate drops. Implement as a per-event-code throttle in `notifications.py`.

## Follow-up (deferred)

_(None.)_
