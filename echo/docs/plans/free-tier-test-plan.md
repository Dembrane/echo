# Test Plan: Free Tier, Request Workspaces, and No Hard Limits

Covers all 19 slices from the PRD. Each section maps to an issue spec in `docs/issues/free-tier-and-request-workspaces/`.

---

## Pre-flight: Issues to Fix Before Testing

1. **Em dashes in user-facing strings** (violates `brand/STYLE_GUIDE.md`)
   - `ConversationAccordion.tsx`: `Conversation locked — upgrade to add to chat`
   - `ConversationAccordion.tsx`: `Transcript locked — upgrade to view`
   - `ProjectSidebar.tsx`: `Conversation locked — upgrade to start a chat`
   - Replace `—` with a comma or colon.

2. **i18n extraction not run** (no `.po` file changes in the diff)
   ```bash
   cd frontend && pnpm messages:extract
   # Translate new msgids in all 6 .po files (en-US, nl-NL, de-DE, fr-FR, es-ES, it-IT)
   cd frontend && pnpm messages:compile
   ```

3. **Tier-upgrade picker** is feature-gate-driven (sends `requiredTier` directly) rather than a free-choice picker of tiers above the current one. Confirm this is intentional.

---

## Phase 1: Automated Tests

Run locally. Every command should exit 0.

### 1.1 New and modified backend tests

```bash
cd server

python -m pytest tests/test_tier_capacity.py -v
python -m pytest tests/test_seat_capacity.py -v
python -m pytest tests/test_stamp_over_cap.py -v
python -m pytest tests/test_locked_gate.py -v
python -m pytest tests/test_email_throttle.py -v
python -m pytest tests/test_workspace_requests.py -v
python -m pytest tests/test_admin_workspace_requests.py -v
python -m pytest tests/test_approve_deny_action.py -v
python -m pytest tests/test_chat_link_gating.py -v
python -m pytest tests/test_discount_fields.py -v
python -m pytest tests/test_onboarding.py -v
python -m pytest tests/test_request_notifications.py -v
python -m pytest tests/test_tier_expiry.py -v
python -m pytest tests/test_tier_expiry_prewarning.py -v
python -m pytest tests/test_tier_upgrade_kind.py -v
python -m pytest tests/test_usage_gates_api.py -v
```

### 1.2 Full backend regression

```bash
python -m pytest tests/ -v --tb=short
```

### 1.3 Matrix smoke test

```bash
python scripts/matrix_smoke.py
```

### 1.4 Frontend type check

```bash
cd frontend && npx tsc --noEmit
```

### 1.5 i18n compile

```bash
cd frontend && pnpm messages:extract && pnpm messages:compile
```

---

## Phase 2: Schema Verification

Run against a live Directus instance.

```bash
# Idempotent schema script
python scripts/create_schema.py
```

Verify the following exist:

| Collection / Field | Type | Default | Notes |
|-|-|-|-|
| `conversation.is_over_cap` | boolean | `false` | Readonly, ADR 0001 stamp |
| `workspace.tier_expires_at` | timestamp | `null` | Nullable, staff-writable |
| `workspace.pre_warning_sent` | boolean | `false` | Deduplicates pre-warning email |
| `workspace.type_discount` | enum (scholarship, staff_discount) | `null` | Staff-write, members-read |
| `workspace.percent_discount` | integer 0-100 | `null` | Staff-write, members-read |
| `workspace.tier` enum | includes `"free"` | `"free"` | DB default changed from `"pioneer"` |
| `workspace_request` (collection) | all fields from Step 18 | | `staff_notes` field-locked to staff role |

Then pull the sync snapshot and confirm it matches:

```bash
cd directus && bash sync.sh -u http://directus:8055 -e admin@dembrane.com -p admin pull
```

---

## Phase 3: Manual API Testing

Use `curl`, Postman, or the app UI. Each section lists the cases to hit.

### 3a. Free tier + onboarding (Slices 01, 02)

| # | Test | Expected |
|-|-|-|
| 1 | Create a new account via direct signup | Auto-seeded workspace: tier=`free`, is_default=true, 1 seat |
| 2 | Create a new account via workspace invite | No personal workspace created |
| 3 | Re-trigger onboarding on an existing owner | No duplicate workspace |

### 3b. Usage gates + upload gating (Slices 03, 06)

| # | Test | Expected |
|-|-|-|
| 1 | `GET /v2/workspaces/{id}/usage` on free workspace under 1h | `usage_gates.uploads_locked=false`, `over_cap_active=false` |
| 2 | Same on free workspace over 1h | `uploads_locked=true`, `over_cap_active=true`, `upgrade_cta_tier` populated |
| 3 | Same on pioneer workspace over monthly cap | Both flags `false` |
| 4 | Load project upload page on a locked workspace | Dropzone replaced with upgrade card |
| 5 | Load project upload page on an under-cap workspace | Normal dropzone |

### 3c. Over-cap stamp + locked gate (Slices 04, 05)

| # | Test | Expected |
|-|-|-|
| 1 | Upload audio to free workspace under 1h, finish conversation | `is_over_cap=false` |
| 2 | Upload audio to free workspace already over 1h, finish | `is_over_cap=true` |
| 3 | Conversation starts at 0.95h, finishes at 1.25h (soft edge) | `is_over_cap=false` |
| 4 | `GET` conversation list via BFF | `locked=true` on over-cap convs, `locked=false` on others |
| 5 | Verify `is_over_cap` is absent from BFF response | Only `locked` is present |
| 6 | `GET` chunks of a locked conversation | `transcript=null`, `transcript_locked=true`, audio fields intact |
| 7 | Upgrade workspace to innovator, re-fetch | Previously-locked conversations show `locked=false` |
| 8 | Downgrade pilot to free | Conversations stamped `is_over_cap=false` on pilot stay unlocked |

### 3d. Chat link gating (Slice 07)

| # | Test | Expected |
|-|-|-|
| 1 | Add a locked conversation to a chat via API | 402 with `conversation_locked` error code |
| 2 | Lock a conversation that a chat already links to | Pre-existing chat still works, messages send, LLM gets full transcript |
| 3 | Auto-select on project with locked + unlocked convs | Locked ones excluded |
| 4 | View a locked conversation in UI | "Ask" sidebar button disabled with tooltip |
| 5 | Chat selection checkbox on locked conversation | Disabled, tooltip explains lock |

### 3e. Workspace request flow (Slice 08)

| # | Test | Expected |
|-|-|-|
| 1 | Open Create Workspace wizard as org admin | Button says "Request workspace", tier picker shows pilot-guardian (no free), default=innovator |
| 2 | Submit request with message | Success panel: "Request submitted, we'll be in touch within 1 business day." |
| 3 | Check Directus `workspace_request` table | Row with status=pending, correct fields |
| 4 | Submit as non-admin org member | 403 |
| 5 | Submit tier_upgrade request | workspace_id set |
| 6 | Submit duplicate tier_upgrade for same workspace | 409 |

### 3f. Admin upgrades page (Slice 09)

| # | Test | Expected |
|-|-|-|
| 1 | As staff, open admin settings > upgrades tab | Pending / Approved / Denied tabs with counts |
| 2 | Click a pending request | Full detail: proposed fields, requester_message, timestamps |
| 3 | As non-staff user, call `GET /v2/admin/workspace-requests` | 403 |

### 3g. Approve + deny (Slices 10, 11)

| # | Test | Expected |
|-|-|-|
| 1 | Approve a `new_workspace` request | Workspace created at granted tier, `resulting_workspace_id` set, `decided_at`/`decided_by` populated |
| 2 | Approve with overrides (different tier, discount, expiry) | All overrides applied to the workspace |
| 3 | Approve a `tier_upgrade` request | Target workspace tier updated |
| 4 | Deny a request with reason | status=denied, denial_reason stored, no workspace change |
| 5 | Deny with empty reason | 400 |
| 6 | Re-approve or re-deny an already-decided request | 409 |
| 7 | Non-staff calls `POST /v2/workspaces` | 403 (now staff-only) |
| 8 | Onboarding auto-seed | Still works (bypasses API) |

### 3h. Notifications + email (Slices 12, 13)

| # | Test | Expected |
|-|-|-|
| 1 | Submit a request | Staff receive in-app notification + email (`WORKSPACE_REQUEST_SUBMITTED`) |
| 2 | Approve a request | Requester receives notification + email with deep link to workspace |
| 3 | Deny a request | Requester receives notification + email including `denial_reason` |
| 4 | Submit 6+ requests rapidly | 6th+ email queued for digest; in-app notification fires individually for all |
| 5 | Trigger or wait for 09:00 UTC digest flush | Digest email sent with summary of queued events |

### 3i. Tier expiry + pre-warning (Slices 15, 16)

| # | Test | Expected |
|-|-|-|
| 1 | Set `tier_expires_at` to 2 days from now on a pilot workspace, trigger pre-warning cron | `TIER_EXPIRING_SOON` notification + email, `pre_warning_sent=true` |
| 2 | Set `tier_expires_at` to the past, trigger expiry cron | Workspace downgraded to free, `downgraded_from_tier` set, `TIER_EXPIRED` notification + email |
| 3 | Re-run expiry cron | Idempotent: no duplicate notifications, workspace stays free |
| 4 | Pilot to free downgrade via expiry | Conversations stamped `is_over_cap=false` on pilot stay unlocked |
| 5 | Extend `tier_expires_at` past the 3-day window | `pre_warning_sent` reset to false |

### 3j. Guest unification (Slices 17, 18)

| # | Test | Expected |
|-|-|-|
| 1 | Pilot workspace (2 seats): owner + 1 member already present, try adding a guest | 402 (unified cap hit) |
| 2 | Pioneer workspace: add a mix of members and guests | Unified `seats_used` counts both |
| 3 | Free workspace (1 seat): try inviting anyone | Rejected |
| 4 | Usage card | Shows "(N members + M guests)" breakdown chip below seat bar |
| 5 | Seat banner | Single "X / Y seats used" line, no separate guest line |
| 6 | CSV export | No `guest_cap` column |

### 3k. Discount fields (Slice 19)

| # | Test | Expected |
|-|-|-|
| 1 | Staff: `PATCH /v2/admin/workspaces/{id}/discount` with `type_discount=scholarship`, `percent_discount=25` | 200, fields set |
| 2 | Workspace member views workspace settings | Read-only chips for discount type and percent |
| 3 | CSV export | Includes `type_discount` and `percent_discount` columns |
| 4 | Approve a request with discount overrides | Discount written to the resulting workspace |
| 5 | Grep codebase for price computation using `percent_discount` | No results in `tier_capacity.py` or `seat_capacity.py` |

---

## Phase 4: UI Smoke Tests

End-to-end, in a browser. Cover the golden paths.

| # | Scenario | What to check |
|-|-|-|
| 1 | Load app as free-tier user | Tier label renders in workspace list, settings, usage card |
| 2 | Hit 1h cap on free | Upload section shows upgrade card; locked conversations show overlay; audio still plays; "Ask" disabled on locked; pre-cap conversations stay usable |
| 3 | Navigate to admin settings as staff | Upgrades tab exists; pending requests visible; approve/deny dialogs work end-to-end |
| 4 | Open "Create workspace" wizard | Says "Request workspace"; tier picker visible; confirmation on submit; no workspace created |
| 5 | Check seat cap banner | Unified count, no separate guest banner |
| 6 | Set discount on a workspace (as staff) | Chips appear on workspace settings |
| 7 | Feature-gated action on a lower tier | UpgradeModal opens, posts to `/v2/workspace-requests`, success toast matches copy |

---

## Phase 5: Regression Checks

These should NOT change from current behavior.

| # | Check | Expected |
|-|-|-|
| 1 | Pioneer+ workspaces | No gates, no locks, overage billing works as before |
| 2 | Existing pilot workspaces with `tier_expires_at=NULL` | Expiry cron skips them |
| 3 | Participant portal recording on an over-cap workspace | Recording succeeds, no error |
| 4 | Existing chat threads | History loads, messages send, streaming works |
| 5 | Whitelabel features | `DembraneLoadingSpinner` patterns unchanged |
| 6 | Report generation | Unaffected by tier changes |
| 7 | Transcription webhook flow | Unaffected |

---

## Slice Coverage Matrix

Quick reference: which test phases cover which slices.

| Slice | Phase 1 (auto) | Phase 3 (API) | Phase 4 (UI) | Phase 5 (regression) |
|-|-|-|-|-|
| 01 Free tier in matrix | `test_tier_capacity` | 3a, 3b | 1 | 1 |
| 02 Onboarding seeds free | `test_onboarding` | 3a | | |
| 03 Usage gates exposed | `test_usage_gates_api` | 3b | 2 | |
| 04 is_over_cap stamp | `test_stamp_over_cap` | 3c | 2 | |
| 05 Live locked gate | `test_locked_gate` | 3c | 2 | |
| 06 Host upload gating | | 3b | 2 | |
| 07 Chat link gating | `test_chat_link_gating` | 3d | 2 | 4 |
| 08 Workspace request | `test_workspace_requests` | 3e | 4 | |
| 09 Admin upgrades page | `test_admin_workspace_requests` | 3f | 3 | |
| 10 Approve action | `test_approve_deny_action` | 3g | 3 | |
| 11 Deny action | `test_approve_deny_action` | 3g | 3 | |
| 12 Notifications + emails | `test_request_notifications` | 3h | | |
| 13 Staff batching | `test_email_throttle` | 3h | | |
| 14 Tier upgrade kind | `test_tier_upgrade_kind` | 3e | 7 | |
| 15 Tier expiry cron | `test_tier_expiry` | 3i | | 2 |
| 16 Pre-warning email | `test_tier_expiry_prewarning` | 3i | | |
| 17 Guest unification BE | `test_seat_capacity` | 3j | | |
| 18 Guest unification FE | | 3j | 5 | |
| 19 Discount fields | `test_discount_fields` | 3k | 6 | |
