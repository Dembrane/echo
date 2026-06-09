# Free tier, request-to-create workspaces, and no hard limits

## Problem Statement

Today, every new ECHO workspace is created at the `pilot` tier — a paid trial that hard-blocks host operations once its 10-hour cap is reached. Three problems follow:

1. **Recording can fail.** Pilot's hard block at the cap means a participant in the middle of a portal recording can have their session aborted because the host workspace ran out of hours. The hard block treats a participant-facing surface as a billing enforcement point, which is hostile to a person who has no relationship to the workspace's billing state.
2. **There is no free entry point.** A user signing up to try ECHO must immediately consume a paid pilot, and there is no permanent floor they can return to. When pilot expires, the workspace has no successor tier and silently breaks.
3. **Self-serve workspace creation creates no accountability.** Any signed-in org admin can spin up workspaces and consume pilot grants without staff knowing, with no way to filter abuse, attach commercial terms, or verify legitimacy before provisioning.

Hosts also currently have a separate "guest cap" that doesn't match their mental model of seats — they have to track two parallel limits and frequently hit the guest cap before the seat cap or vice versa.

## Solution

Three changes ship together as one feature:

**1. New `free` tier as the permanent floor.** Every new direct-signup user gets one free workspace auto-seeded at onboarding: 1 seat, 1 hour lifetime cap, no overage, no expiry. Free is the lowest rung of the tier ladder; every workspace can always exist at free.

**2. No hard limits anywhere — gate UI instead of blocking recording.** When a free or pilot workspace exceeds its hour cap, recording from the portal continues to succeed. What changes is downstream: any *new* conversation started after the cap is stamped over-cap and its transcript is hidden behind an upgrade prompt; the host upload section is replaced with an upgrade card; new chat threads cannot be started on over-cap conversations. Existing chat threads, previously-recorded conversation transcripts, and participant recording all stay fully usable. Pioneer and above are unaffected — they continue to bill overage as today.

**3. Request-to-create replaces self-serve.** The existing 4-step "create workspace" wizard's final button changes from "Create workspace" to "Request workspace" and submits to a new `workspace_request` collection. Staff review at a new `/admin/upgrades` page, contact the requester to verify legitimacy, then approve (which creates the workspace at the granted tier) or deny (with a reason). The same collection handles tier-upgrade requests on existing workspaces. Free is not a valid request tier — paid only, default = innovator.

Three smaller changes come along for the ride: tier expiry auto-downgrades workspaces to free with a 3-day pre-warning email, the separate guest cap is unified into the seat pool (guests still exist as a role, just not as a parallel limit), and staff can attach a discount (`type_discount` + `percent_discount`) to a workspace at approval time.

## User Stories

1. As a new direct-signup user, I want a workspace auto-created for me at signup, so I can start recording immediately without going through a request flow.
2. As a new direct-signup user, I want my auto-created workspace to be free and never expire, so I'm not surprised by an expired-tier wall the first time I come back to ECHO.
3. As a free-tier user, I want to be able to record audio from the participant portal even after I've hit my 1-hour cap, so a participant who already started recording doesn't have their session terminated by my billing state.
4. As a free-tier user, I want a clear upgrade prompt instead of a transcript when I exceed my cap, so I understand exactly what's happening and what to do about it.
5. As a free-tier user, I want my pre-cap conversations to stay fully usable forever, so the work I did under the cap isn't punished by the work I did past it.
6. As a free-tier user, I want my existing chat threads to keep working even on conversations that later become locked, so my active research isn't interrupted mid-flow.
7. As a free-tier user, I want to see audio playback on locked conversations, so I can still listen to my own recordings while deciding whether to upgrade.
8. As a user invited to someone else's workspace, I want to NOT receive a personal free workspace, so my account isn't littered with unused workspaces I never asked for.
9. As a returning user who already owns a workspace, I want onboarding to skip the seed step, so I don't get a second default workspace I didn't ask for.
10. As an org admin, I want to request a new workspace through a wizard, so I can communicate intent and context to staff before consumption.
11. As an org admin, I want the request wizard to offer paid tiers only, default to innovator, and clearly show what each tier includes, so I can make an informed choice instead of asking staff what the tiers mean.
12. As an org admin, I want a free-text message field in the request, so I can explain my use case, ask about discounts, or note constraints staff need to know.
13. As an org admin, I want a confirmation that says "we'll be in touch within 1 business day", so I have an honest expectation instead of assuming instant provisioning.
14. As an org admin, I want an in-app notification and email when my request is approved or denied, so I don't have to poll the admin page.
15. As an org admin, I want a denial to include the reason staff gave, so I understand whether to re-request or pursue another path.
16. As a workspace admin on free, I want to request a tier upgrade from inside the workspace, so I don't have to create a new workspace just to move to pioneer.
17. As a workspace admin on a paid tier whose `tier_expires_at` is set, I want a pre-warning email 3 days before the date, so I'm not surprised when the workspace auto-downgrades.
18. As a workspace admin, I want an in-app notification when my workspace auto-downgrades to free, so I know why my UI suddenly shows the free-tier gates.
19. As a workspace admin on pilot, I want my pilot-trial content to stay readable forever after the trial expires, so paying €349 wasn't a one-month rental of access to my own data.
20. As a workspace member on any tier, I want to see a small read-only chip with the discount that staff applied to my workspace, so I have transparency on my commercial terms.
21. As a workspace member, I want the seat counter to show one number ("3 of 5 seats used") rather than separate member and guest counts, so I have one mental model for who counts toward my limit.
22. As a workspace admin, I want to invite a guest from inside the workspace without hitting a separate guest cap, so I can treat guest invitations the same way I treat member invitations.
23. As an admin staff member, I want a single `/admin/upgrades` page listing all pending requests, so I have one inbox instead of two parallel ones for "new workspace" and "tier upgrade".
24. As an admin staff member, I want each request row to show kind, requester, org, target tier, requester message, and submission time, so I can triage at a glance without opening detail pages.
25. As an admin staff member, I want to approve a request with optional overrides on tier, discount, and expiry, so I can grant terms different from what was requested when sales context warrants.
26. As an admin staff member, I want to deny a request with a required free-text reason, so I'm forced to communicate context to the requester.
27. As an admin staff member, I want a private `staff_notes` field on each request, so I can record internal context without exposing it to the requester.
28. As an admin staff member, I want to set an optional `tier_expires_at` at approval time, so I can grant time-bounded access (typical for pilot, occasional for a paid-tier promo).
29. As an admin staff member, I want batched daily-digest emails when more than 5 request notifications accumulate in 24 hours, so my inbox doesn't drown during high-volume periods.
30. As an admin staff member, I want a CSV export including tier, `tier_expires_at`, `type_discount`, and `percent_discount` columns, so finance can compute manual invoices from one file.
31. As an admin staff member, I want to attach or change `type_discount` and `percent_discount` on any workspace from a workspace admin detail view, so I can update commercial terms without going through a request.
32. As a participant joining a recording via QR code, I want to never experience a failed recording, so my contribution to the conversation isn't lost because of someone else's billing state.
33. As a participant, I want to never see workspace-level upgrade prompts on the portal, so my participation experience isn't polluted by the host's billing situation.
34. As an LLM-backed chat user, I want existing chat threads on a conversation that later becomes locked to keep streaming answers with full transcript context, so my long-running analysis isn't quietly degraded.
35. As a host who exceeded the cap, I want the upload section replaced with an upgrade prompt rather than a disabled-button-with-tooltip, so the path forward is unambiguous.
36. As a free-tier owner, I want my workspace's 1 seat to mean "just me" — I cannot invite anyone, even read-only, until I upgrade — so the pricing model is honest.
37. As an admin staff member, I want approvals to create the workspace at the granted tier (and not at pilot regardless of pick), so the request flow's tier picker is meaningful end-to-end.
38. As an admin staff member, I want to be able to grant a tier at approval that differs from the requested tier (and have both recorded), so audit shows what the customer asked for vs what we negotiated.
39. As a workspace user, I want auto-downgrade from pilot to free to leave my historical conversations readable, so I never lose access to data I paid to produce.
40. As a developer maintaining ECHO, I want a single source of truth for tier capacity (`tier_capacity.py` + `policies.py`'s `TIER_ORDER`), so I don't have to keep tier matrices in sync across backend, frontend, emails, and i18n.

## Implementation Decisions

### Modules (deep, isolated)

**Tier capacity matrix** — extends today's `tier_capacity.py` plus `policies.py:TIER_ORDER`. Adds `free` as a tier entry (`included_seats=1, included_hours=1, hour_overage_eur=None, seat_overage_eur=None, hard_block_on_hours=False`), prepends `"free"` to `TIER_ORDER`, removes the `guest_cap` field from the `TierCapacity` dataclass and every tier entry. Adds two pure helpers:
- `tier_allows_overage(tier) -> bool` — true for pioneer/innovator/changemaker/guardian, false for free/pilot.
- `compute_usage_gates(tier, hours_lifetime, hours_this_month) -> UsageGates` — caller passes both counts; the function picks the right regime per tier (lifetime for free/pilot, monthly for pioneer+). Returns `over_cap_active` and `uploads_locked`.

`is_hard_blocked()` keeps its signature but always returns false. Marked deprecated; existing call sites stay compatible and stop hard-blocking by behavior.

**Over-cap stamp + live lock** — encapsulates ADR 0001. New Directus field `conversation.is_over_cap` (bool, default false, user-uneditable). One stamping function called from the existing conversation-finish path, plus one live-lock function called from BFF.
- Stamp formula (at `is_finished` transition): `is_over_cap = NOT tier_allows_overage(tier) AND (workspace.audio_hours − this_conversation.duration) >= cap.included_hours`. Soft edge — a conversation that started under cap stays unlocked even if its recording crossed the cap. Stamping is a no-op on pioneer+ (always false).
- Live-lock formula (per conversation, on read): `locked = conversation.is_over_cap AND NOT tier_allows_overage(workspace.current_tier)`. Frontend reads `locked` from BFF; raw `is_over_cap` is admin/CSV only. Tier upgrade auto-unlocks; pilot→free downgrade does not re-stamp (paid-trial content stays readable).
- Chat-link gating: `project_chat_conversation` insert and auto-select pickup both check live `locked` and reject 402 on locked conversations. Pre-existing links and running chats are unaffected; LLM receives full transcript text of pre-existing links.

**Workspace request approval orchestrator** — single entry point for staff actions on `workspace_request` rows:
- `approve(request, granted_tier, granted_type_discount, granted_percent_discount, granted_tier_expires_at) -> workspace_id` — creates workspace (for `kind=new_workspace`) or applies tier change (for `kind=tier_upgrade`), populates `resulting_workspace_id` and `decided_at` / `decided_by`, fans out approval notification + email.
- `deny(request, reason) -> None` — sets status, stores reason, fans out denial notification + email.
- Side-effect ports (workspace creation, tier change, notification emit, email send) are injected so the orchestrator is testable with mocks.

**Tier expiry + pre-warning crons** — pure-ish query + apply:
- `find_workspaces_expiring(now, window=0) -> [workspace_id]` — returns workspaces where `tier_expires_at` is past (window=0) or within `window` days (window=3).
- `apply_expiry(workspace) -> downgrade_effects` — wraps the existing `tier_downgrade.apply_downgrade_effects()` call, sets `tier='free'`, `downgraded_at`, `downgraded_from_tier`, clears `tier_expires_at`, emits `TIER_EXPIRED`.
- Pre-warning path emits `TIER_EXPIRING_SOON` and stamps `pre_warning_sent=true` on the workspace to dedupe. Two Dramatiq actors share the query helper; both scheduled hourly via `scheduler.py`.

**Notification batching** — pure decision function:
- `should_send_now(recipient, event_code, history_24h) -> "individual" | "queue_for_digest"` — if the recipient has received more than 5 events of this `event_code` in the trailing 24h, returns `queue_for_digest`. A separate daily 09:00 UTC actor flushes queued digests.
- The in-app notification is always individual; only the email is batched.

### Schema changes

**New `workspace` fields:**
- `tier_expires_at` (timestamp, nullable) — null = no expiry. Set by staff at approval.
- `type_discount` (enum: `scholarship` | `staff_discount`, nullable) — staff-write, all members read.
- `percent_discount` (integer 0-100, nullable) — same permissions. Pure metadata; not enforced by any code path.
- `pre_warning_sent` (bool, default false) — dedupes the 3-day pre-warning email.

**New `conversation` field:**
- `is_over_cap` (bool, default false, not user-editable) — durable accounting stamp from ADR 0001.

**Updated `workspace.tier` enum:** add `"free"`; change DB default from `"pioneer"` to `"free"`.

**New `workspace_request` collection:**
- Identity: `id`, `kind` (enum `new_workspace` | `tier_upgrade`), `status` (`pending` | `approved` | `denied`, default `pending`).
- Requester side: `requested_by` (user m2o), `org_id` (org m2o), `workspace_id` (workspace m2o, nullable — set for upgrades), `proposed_name`, `proposed_tier` (enum, default `innovator`), `proposed_visibility` (enum, default `open_to_organisation`), `requester_message` (text, max 1000).
- Approval side: `granted_tier`, `granted_tier_expires_at`, `granted_type_discount`, `granted_percent_discount`, `resulting_workspace_id`.
- Decision (collapsed from earlier draft): `decided_at` (timestamp, nullable), `decided_by` (user m2o, nullable), `denial_reason` (text, nullable).
- Internal: `staff_notes` (text, nullable, staff-only). Standard `created_at` / `updated_at`.
- Dropped from earlier draft: `proposed_type_discount`, `proposed_percent_discount` (discounts are staff-granted only), `proposed_inherit_organisation_admins` (always `true`), `requested_at` (use `created_at`), separate `approved_at` / `approved_by` / `denied_at` / `denied_by` (collapsed into `decided_at` / `decided_by` since status records which).

### API contracts

- `POST /v2/workspace-requests` — auth'd users create a request. New-workspace: validate user is org admin/owner. Tier-upgrade: validate workspace admin or billing.
- `GET /v2/admin/workspace-requests` — staff list, filterable by status.
- `PATCH /v2/admin/workspace-requests/{id}` — staff approve/deny. Body: `{ action: "approve" | "deny", denial_reason?, granted_tier?, granted_type_discount?, granted_percent_discount?, granted_tier_expires_at? }`.
- `POST /v2/workspaces` — was self-serve, becomes staff-only. Called server-side by the approval orchestrator. The onboarding seed continues to write directly to Directus (bypasses the API entirely), so the staff-only restriction doesn't affect it.
- `POST /v2/workspaces/{id}/upgrade-request` — removed. The existing email-only endpoint migrates to the new collection.
- Workspace usage response (`_get_workspace_usage`) gains a `usage_gates: { uploads_locked: bool, over_cap_active: bool, upgrade_cta_tier: string }` block.
- Conversation BFF responses gain `locked: bool` per conversation. Raw `is_over_cap` is not exposed to the frontend.
- Chunk responses (`list_chunks`, `get_chunk`): when the conversation is `locked`, the `transcript` field is `null` and `transcript_locked: true` is set on the chunk envelope. Audio fields stay intact.
- `project_chat_conversation` insert rejects with 402 when the target conversation is `locked`. Auto-select picks filter out locked conversations.

### Behavior decisions

- **Onboarding seed change scope.** Existing branching in `onboarding.py` already gates the seed correctly (only direct-signup users with own projects or no internal invites). The only code change is the tier value at the seed call.
- **Existing pilot `tier_expires_at` backfill.** None — leave NULL on existing rows so the cron skips them. Only newly-granted pilots set the date.
- **Guest unification migration.** None — pre-prod feature; if any production pilot is over the unified cap at ship time, staff handles it manually.
- **Lock UX.** The `ProjectUploadSection` is replaced with an upgrade-prompt card when `uploads_locked`. Not a disabled-button-with-tooltip.
- **Tier-expiry email cadence.** Pre-warning email 3 days before, plus the day-of `TIER_EXPIRED` email. Both via the same audience (workspace admins + billing).
- **Approval workflow is manual.** Submission notification copy is "Thanks — we'll be in touch within 1 business day." Schema is neutral toward future automated billing; when that lands, it will likely own its own discount/expiry source of truth and the directus fields become a mirror.
- **Recording never fails.** The participant portal recording endpoints stay open on all tiers. The cap is enforced only on host-facing surfaces and on new-engagement gates (transcript view, new chat threads, host upload).

### What the LLM sees inside chats

For chats already linked to a now-locked conversation, the LLM receives the full transcript text of the linked conversation (no placeholder, no scrubbing). The lock is a new-engagement gate, not a content-extraction gate. This loophole is intentional and documented in ADR 0001 — the alternative (chat suddenly degrading mid-conversation) is more hostile than the workaround is valuable to abusers.

## Testing Decisions

Tests target external behavior of the deep modules — given a tier + usage state, what does the gate say? Given a stamped conversation + current tier, is it locked? Tests do not assert on internal call sequences, mocked side-effect counts, or the structure of intermediate dicts. Refactors that preserve behavior should not require test updates.

**Unit-tested modules:**

- **Tier capacity matrix** (`tests/test_tier_capacity.py`, extends today's file). Exhaustive matrix for each tier:
  - `tier_allows_overage(tier)` returns the right boolean for every tier including unknown.
  - `compute_usage_gates(tier, hours_lifetime, hours_this_month)` for the cross-product of (each tier) × (under cap / at cap / over cap) — checks `over_cap_active` and `uploads_locked` are correct.
  - `is_hard_blocked()` returns false for every tier (regression: it must not block).
  - `next_tier()`, `compute_hour_overage_eur()`, `compute_seat_overage_eur()` for the new ordering (free at position 0).
  - Prior art: today's `test_tier_capacity.py` (if it exists) and `tests/test_seat_capacity.py`.

- **Over-cap stamp + live lock** (`tests/test_over_cap.py`, new). Behavior tests for the stamp + lock pair:
  - Stamp formula: free workspace at 0.5h, conversation Y duration 0.3h, stamp false (started under cap).
  - Stamp formula: free workspace at 1.5h, conversation Y duration 0.3h, stamp true (started over cap).
  - Stamp formula: pioneer workspace at 30h, conversation Y duration 0.3h, stamp false (overage allowed).
  - Live lock: stamped+free returns true; stamped+innovator returns false; unstamped+anything returns false.
  - Pilot → free downgrade: pre-downgrade conversations stamped false stay false; the workspace's `is_conversation_locked()` returns false for them despite the workspace being over the free cap.
  - Soft edge regression: a free conversation that records its first audio at 0.95h and finishes at 1.25h must stamp false.

- **Notification batching** (`tests/test_notification_batching.py`, new):
  - `should_send_now(recipient, event_code, history_24h)` returns `"individual"` for the first 5 events of a code in 24h.
  - Returns `"queue_for_digest"` for the 6th and later events of the same code, same recipient, within the 24h window.
  - Returns `"individual"` again once the window slides past the 5-event threshold (events older than 24h drop out).
  - Different event codes don't pollute each other's count.
  - Different recipients are tracked independently.
  - Prior art: any throttle/rate-limit tests in `tests/api/rate_limit*` (the in-app rate limiter has the same shape).

**Skipped (intentional):**

- **Workspace request approval orchestrator** — covered by integration tests at the API level (`PATCH /admin/workspace-requests/{id}` with mocks for Directus / email transport). The orchestrator's value is the choreography of side effects, which integration tests assert end-to-end better than mocked unit tests.
- **Tier expiry cron** — the query is a single Directus filter and the apply step is a thin wrapper around existing `tier_downgrade.apply_downgrade_effects()`. Add one smoke test that asserts cron-with-fake-now downgrades the right row; don't try to unit-test the cron scheduling.
- **Frontend gating components** — exercised by the existing E2E flow, not unit tests. The view-layer behavior (does the upgrade card render? does the dropzone disappear?) is best asserted visually or through integration; unit-testing JSX gates is low-leverage.

## Out of Scope

- **Automated billing.** Stripe / Lemonsqueezy / etc. integration is months away per current staff plans. The discount fields are descriptive metadata for finance until that lands; they do not feed any computational path.
- **Per-conversation overage attribution.** The `is_over_cap` stamp records "this conversation finished while the workspace was over a non-overage cap" but does NOT record the fractional hours of audio that fell past the cap. If finance later wants per-conversation overage accounting, that's a separate effort.
- **Workspace-level seat overrides.** No `seats_included_override` field — if a real workspace lands in a now-over-cap state at ship time due to the guest unification, staff handles it manually rather than building grandfathering machinery.
- **Free-tier rate limits, abuse heuristics, anti-farming.** A determined user could create multiple free workspaces by registering multiple accounts. Not addressed; if it becomes a real abuse vector, build it later from real signal.
- **Pilot one-time payment collection at request time.** Pilot's €349 is collected manually by finance after staff approval, same as monthly billing for pioneer+. No payment-before-approval gating.
- **Tier upgrade UX from inside the over-cap overlay.** The "Upgrade to view transcript" CTA can deep-link to the workspace's request page; building an inline payment / instant-upgrade flow is out of scope.
- **Workspace deletion as part of the request flow.** Denied requests stay as audit rows; no auto-cleanup. Approved requests that result in unused workspaces stay around; users delete them through the existing workspace settings flow.
- **Email-only `POST /v2/workspaces/{id}/upgrade-request` deprecation period.** The old endpoint is removed at ship; any in-flight email threads from before the cutover are handled by staff manually.
- **Notification digest format polish.** First implementation sends a plain list of requests in the daily digest. Templated copy, sorting, grouping by org are future enhancements.

## Further Notes

- **Foundational ADR.** `docs/adr/0001-over-cap-conversation-model.md` is the load-bearing decision record for the stamping and locking semantics. Read it before touching `is_over_cap` logic — the durable column + live computed gate split is surprising without that context, and there are several deliberate loopholes (chat extraction, paid-trial-survives-downgrade) that future engineers should not "fix".
- **Domain vocabulary.** `CONTEXT.md` at the repo root is the canonical glossary for this work. Terms like *workspace request*, *over-cap conversation*, *locked conversation*, *direct signup*, *guest*, *free tier*, *pilot tier*, *discount* all carry specific meanings established in the grilling session — use them consistently in code, comments, copy, and i18n.
- **Schema sequencing matters.** Section 2a of the implementation plan creates the `free` tier with a transient `guest_cap=1`, then section 2g removes `guest_cap` from the dataclass entirely. Land 2g first to avoid the transient field, or accept the brief inconsistency.
- **`TIER_ORDER` lives in `policies.py:21`, not `tier_capacity.py`.** Both need editing — the new `free` entry goes in the `TIER_CAPACITIES` dict in one file and the `TIER_ORDER` list in the other.
- **`is_hard_blocked()` becomes deprecated, not removed.** Existing call sites continue compiling and now always see false; cleanup of the call sites is a separate refactor.
- **Submission email copy.** "Thanks — we'll be in touch within 1 business day." Avoid promising automated provisioning until automated billing lands.
- **Brand & UI copy compliance.** No em dashes in user-facing copy. Don't say "AI" or "successfully". Use Royal Blue or italics for emphasis, never bold. Dutch translations use informal `je/jij`. (Per `brand/STYLE_GUIDE.md` and `CLAUDE.md`.)
- **i18n.** New strings (request wizard, lock overlays, upgrade prompts, admin upgrades page, email templates, notification copy) need entries in all six `.po` files (en-US, nl-NL, de-DE, fr-FR, es-ES, it-IT) and `pnpm messages:compile` to run clean.
- **Single alert at a time.** Gate messaging uses one alert at a time per `CLAUDE.md` — don't stack the upgrade banner with other workspace alerts.
