# Questions for Sameer

**Convention:** each question is tagged in its heading:
- `🔴 blocking` — blocks other work
- `🟡 non-blocking` — can proceed without
- `✅ answered <date>` — resolved

Answered questions keep their body for context. Answer goes inline right under the heading as `**Answer:**`. Decisions derived from answers land in `03-DECISIONS.md`. New questions go to the top.

---

## Pending

*(none)*

---

## Resolved

### [Q1 · ✅ answered 2026-04-23] Role-rename scope: can `billing` role land in schema this release?

**Answer:** go for it (Option A). Add `billing` as a fifth `workspace_membership.role` value with its own preset. See D7.

**Context:** Matrix §4 introduces four workspace roles — **Admin / Billing / Member / Guest**. Code today has `owner / admin / member / viewer` at the workspace level plus `is_external=true` for Guest. `billing` is not a renaming of anything — it is a net-new role with its own capability set (update payment, see invoices, request upgrades, see usage + € forecasts, cannot create projects, cannot invite).

**In code:**
- `server/dembrane/policies.py:53-93` — `WORKSPACE_ROLE_PRESETS`: `viewer / member / admin / owner`
- `workspace_membership.role` is a free-text field in Directus (not a DB-enum), so adding values is cheap.

**Sub-question (open):** Is "Billing" at the *team* level a rename of the team `admin` role's billing capabilities, or a separate preset? Matrix §5 lists three team roles (Admin / Billing / Member). Default: treat as separate preset, mirror workspace approach. Revisit if it breaks on implementation.

---

### [Q2 · ✅ answered 2026-04-23] Visibility schema — enum vs keep booleans?

**Answer:** Option A. Add `workspace.visibility` enum (`open_to_team | private`). Remove old columns directly — not in prod yet. See D8.

**Context:** Matrix §6 uses a single `workspace.visibility` enum. Code stores two booleans in `workspace.settings` JSON (`inherit_team_admins`, `inherit_team_members`). Matrix v1.1 retires the inheritance model entirely, so the second boolean becomes meaningless.

Also purge `sticky_removed` tombstones as part of the walkback.

---

### [Q3 · ✅ answered 2026-04-23] Hour meter vs deferred `usage_event`

**Answer:** Option B. Derive from `conversation.duration` via a usage API route. Soft-delete respected via `deleted_at` filter. See D9.

**Context:** Matrix §8 requires a per-workspace hour meter with calendar-month reset, overage billing, and Pilot hard-block at 10 hours.

**Implementation shape:** `/v2/workspaces/:id/usage` sums `conversation.duration` where `workspace_id=X AND deleted_at IS NULL AND created_at` within current calendar month. No new `usage_event` table. Pilot hard-block = read-time check against 10h cap before host-side endpoints run.

---

### [Q4 · ✅ answered 2026-04-23] Uncommitted working tree — resume or revert?

**Answer:** Commit the in-flight changes as one commit. Going forward, exclude `docs/workspaces/` and `docs/workspaces-validate/` from code commits — doc churn gets its own commits. See D10. Committed as `bc3310c`.

---

### [Q5 · ✅ answered 2026-04-23] Collapse `viewer` role?

**Answer:** remove viewer. No migration. Rely on good error handling for any stray rows. See D11.

**Approach:** drop the preset; if a DB read returns `role='viewer'`, treat as `member` + log a warning.

---

### [Q6 · ✅ answered 2026-04-23] Webhooks gate — turn on at changemaker+?

**Answer:** yes. Add `workspace:webhooks` policy, gate at changemaker via `TIER_REQUIRED_FOR_POLICY`, freeze-on-downgrade. See D12.

---

### [Q7 · ✅ answered 2026-04-23] Pilot tier assignment for current customers at cutover

**Answer:** deferred — deployment thinking happens later. M1 CSV tool is not this session. See D13.

---

### [Q8 · ✅ answered 2026-04-23] Upgrade inbox switch

**Answer:** `upgrades@dembrane.com` everywhere — default in `settings.py`, docstrings, endpoint copy, docs. See D14.
