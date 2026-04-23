# Flow 0 — Derivation walkback (backend)

**Priority:** blocker. Prerequisite for flows 1 (upgrade-request reassurance), 4 (home-per-team discovery), 6 (invite-and-join). Not a UI flow — a schema + resolver simplification.

**Matrix reference:** §5 "Team-level access is direct-only. No derivation." §6 "Slack-style discovery."

**Code reference:** `server/dembrane/inheritance.py` (full derivation resolver to retire), `docs/workspaces/inheritance-rules.md` (spec to archive after this flow lands).

---

## What changes

**Before (today):**
- Access to a workspace is computed at read time via `user_can_access()` walking `org_membership` + `workspace.settings.inherit_team_admins / inherit_team_members / sticky_removed`.
- Team admins auto-have admin role on every open workspace in their team.
- Team owners auto-have admin role on every workspace (private included).
- Removing a derived user writes a `sticky_removed` tombstone.

**After:**
- Single `workspace.visibility` enum: `open_to_team | private`.
- Access is stored-direct-only. `workspace_membership` is the source of truth; `user_can_access()` does a single row lookup.
- Team admins see all team workspaces in discovery. Team members see `open_to_team` only.
- Joining is always an explicit action → writes `source='direct', role='admin'` (admin click) or `source='direct', role='member'` (member request + admin approval).
- `sticky_removed` retires. Rejoins are normal explicit actions.

---

## Sequence (land in this order)

### 1. Schema migration (scripts/create_schema.py)

Idempotent Python additions:
- `workspace.visibility` enum column: `open_to_team | private`, nullable initially, will flip to required after backfill.
- `access_request` collection: `id, workspace_id, user_id, status, requested_at, actioned_at, actioned_by, deleted_at`.

Directus data migration (single SQL via REST API):
- `UPDATE workspace SET visibility = CASE WHEN (settings->>'inherit_team_admins')::bool IS NOT FALSE THEN 'open_to_team' ELSE 'private' END WHERE visibility IS NULL AND deleted_at IS NULL`.

### 2. Backfill script — the stop condition

**File:** `scripts/backfill_direct_memberships.py`. Dry-run default; `--apply` requires explicit flag.

Algorithm:
```
for each active workspace W:
    effective = inheritance.get_effective_members(W.id)  # current derivation-aware
    for each row in effective where row.source == 'inherited':
        if direct row exists for (W.id, row.user_id) with deleted_at IS NULL:
            skip (direct always won; no-op)
        else:
            propose INSERT workspace_membership (
                workspace_id = W.id,
                user_id = row.user_id,
                role = row.role,          # 'admin' or 'member' per derivation
                source = 'direct',
                is_external = False
            )
```

Output (dry-run):
- Per-org summary: org_name, workspace_count, users_affected, rows_to_insert.
- Per-workspace breakdown: ws_name, visibility, direct_rows_today, rows_to_insert.
- Grand total row count.
- CSV export for manual review.

Stop condition per brief: **before `--apply`, paste the row-count summary in `04-QUESTIONS-FOR-SAMEER.md` and wait for explicit confirmation.** Never auto-apply.

Safeguards:
- Per-host lockfile pattern from `migrate_inherited_to_derived.py` (idempotent, prevents concurrent apply).
- `script_start_iso` cutoff — only consider workspaces + org_memberships created before the script started, so re-runs don't re-insert for rows added mid-run.
- Skip rows for users in `sticky_removed` — they were explicitly kicked; they get zero rows. Matches matrix §6 "sticky removal is retired" — the tombstone history stays buried, affected users just don't auto-rejoin.

### 3. Resolver simplification (`server/dembrane/inheritance.py`)

Shrinks to:
- `user_can_access(workspace_id, user_id)` — single `_get_direct_membership` lookup; returns `(role, 'direct') | None`. Deleted the entire derivation branch.
- `get_effective_members(workspace_id)` — drops the `org_rows` fan-in; returns direct rows only.
- `get_user_project_access` — unchanged except `source` is always `'direct' | 'project_share' | 'legacy'`, never `'inherited'`.

Deletes:
- `workspace_follows_team_admins`, `workspace_follows_team_members`, `is_sticky_removed`.
- `sticky_remove`, `sticky_unremove`.
- Team-owner carve-out (no longer needed — owners write a direct row via migration, not implicit derivation).

Keeps (simplified):
- `on_workspace_created` — still writes creator as direct owner. No settings flags written (visibility is a column).
- `on_team_member_removed` — still soft-deletes the user's direct rows across the team's workspaces. Matches Slack "kicked from Slack → out of every channel." If product disagrees, separate decision.

### 4. Settings purge

Once the resolver no longer reads them, strip from `workspace.settings` JSON:
- `inherit_team_admins`
- `inherit_team_members`
- `sticky_removed`

Single UPDATE via Directus, plus future-workspace `on_workspace_created` no longer writes these keys.

Tombstones that exist today are naturally orphaned — the backfill already decided their fate (no row = no access; the user can rejoin via the explicit discovery path if they're discoverable again).

### 5. New endpoints (unlock flows 4 + 6)

**`POST /v2/workspaces/:id/join`** — team admin self-join.
- Guard: caller is `org_membership` admin/owner in this workspace's org. No workspace-level policy (you can't require a policy you don't have yet).
- Rate-limited (5/hr/user).
- Idempotent: 409 if direct row already exists.
- Writes `workspace_membership (role='admin', source='direct')`.
- Emits `WORKSPACE_ADDED` to joiner; no broadcast.

**`POST /v2/workspaces/:id/access-requests`** — team member request-to-join, open workspaces only.
- Guard: caller is `org_membership` member in org; workspace is `visibility='open_to_team'`.
- Idempotent: 409 if pending request exists.
- Writes `access_request (status='pending')`.
- Emits `MEMBERSHIP_REQUESTED` to audience = workspace admins + team admins.

**`GET /v2/workspaces/:id/access-requests`** — admin view.
- Guard: `member:manage` policy on workspace OR team admin.
- Returns pending requests.

**`POST /v2/workspaces/:id/access-requests/:req_id/approve`**
- Writes `workspace_membership (role='member', source='direct')`.
- Marks request `status='approved', actioned_at, actioned_by`.
- Emits `MEMBERSHIP_REQUEST_APPROVED` to requester + `WORKSPACE_ADDED`.

**`POST /v2/workspaces/:id/access-requests/:req_id/reject`**
- Marks request `status='rejected'`.
- **No notification to requester** per matrix §6 "Rejection is silent from the member's perspective."

Additional:
- `PATCH /v2/workspaces/:id/visibility` — admin-only, flips `workspace.visibility`. Gated by `workspace:set_private` (innovator+ for `private`).

### 6. Notification emits

Add event codes to `_SEVERITY_BY_EVENT` in `notifications.py`:
- `MEMBERSHIP_REQUESTED` → severity `action_required`.
- `MEMBERSHIP_REQUEST_APPROVED` → severity `info`.
- `MEMBERSHIP_REQUEST_REJECTED` → **not emitted** (silent rejection).

### 7. Surface changes (UI flows downstream — not this flow)

Listed here for dependency clarity:
- Home page (`flows/home-per-team.md`): discovery section with Join / Request-access CTAs.
- Workspace settings → Members tab: pending access requests list, approve/reject buttons.
- Workspace create wizard (`flows/workspace-creation.md`): visibility radio + honesty disclosure on Private.

---

## Invariants (post-walkback)

1. `SELECT count(*) FROM workspace_membership WHERE source='inherited' AND deleted_at IS NULL` = 0.
2. `user_can_access` never reads `org_membership` or `workspace.settings`.
3. `workspace.settings` contains no `inherit_team_admins | inherit_team_members | sticky_removed` keys for any active row.
4. Team admin promotion/demotion does NOT change workspace access — workspace rows are explicit.
5. External user (is_external=true) is always direct; derivation never produced externals anyway. Post-walkback, externals can be freely invited without any reconciliation logic.
6. Last-admin protection holds — `DELETE /v2/workspaces/:id/members/:uid` refuses if the target is the last `role='admin'` row with `deleted_at IS NULL`.

---

## Tests that must pass before apply

1. Dry-run against a seeded test DB — verify:
   - Every derivation-only member shows up in the proposal.
   - Every user with both a direct row and a derived path is skipped.
   - Every sticky-removed user is skipped.
2. Apply to a scratch DB — verify `get_effective_members()` output is identical before and after the simplification (same user set, same roles).
3. Smoke test all three role paths after simplification: admin, member, guest.
4. Participant portal access unchanged — walkback does not touch participant auth at all.

---

## Subagents to dispatch after build

Per `06-VALIDATION-PLAN.md`, at build-time for this flow:
- **Security** — scoped to `inheritance.py` diff, new endpoints, backfill script. Check for: access-check bypass via missing direct row, migration idempotency, lockfile hygiene, join endpoint abuse (rate-limit + guard), access-request cross-workspace leakage.
- **Human-first** — scoped to the spec itself + eventually the flow UIs that consume this. Check: participant portal never touched, last-admin protection documented, silent rejection is honest UX (matrix requires it).

Copy + brand: N/A — backend-only flow until the UI flows consume it.

---

## Out of scope for this flow

- UI for join / request-access / approve-reject (covered in flows 4 + 6 + 9).
- `access_request` model deeper fields (reason text, expiry) — not in matrix; add post-release if we see abuse.
- Bulk re-join (former employees returning to a team) — out of scope; they rejoin per workspace.
- Cross-team workspace discovery — matrix §6 restricts discovery to team scope; don't widen.
