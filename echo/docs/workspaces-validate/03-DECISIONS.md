# Decisions log

Append-only. One decision per entry. Dated. Short.

---

## 2026-04-23

- **D1.** Treat matrix v1.1 as the contract. Checklist's "Decisions locked" for derivation + sticky removal is superseded by matrix §5–§6; reconcile via the walkback flow, not by preserving old behavior.
- **D2.** Build `workspaces-validate/` as descriptive (of what shipped), not prospective. Flow + screen specs document the product; they don't design it.
- **D3.** Working docs follow the layout listed in the brief; `MEMORY.md` / `03-DECISIONS.md` / `04-QUESTIONS-FOR-SAMEER.md` / `05-PROGRESS.md` are all at the root of `workspaces-validate/`, not nested.
- **D4.** `00-DOC-AUDIT.md` carries the "Repo conventions" header per brief; `02-DELTA.md` references it rather than repeating.
- **D5.** Do not touch the uncommitted working tree until Q4 is answered. Build only on top of the last commit (`cfa758e`) for now.
- **D6.** Session 1 outputs: audit, delta, plan, questions, decisions, progress. No implementation until Sameer clears the first gate.
- **D7.** [Q1] `billing` role lands in schema this release. Fifth `workspace_membership.role` value with its own preset. Mirror at organisation level too (matrix §5 lists three organisation roles: Admin / Billing / Member).
- **D8.** [Q2] Add `workspace.visibility` enum (`open_to_organisation | private`). **Remove** `workspace.settings.inherit_organisation_admins` and `inherit_organisation_members` directly — Sameer confirms not in prod yet. Also purge `sticky_removed` tombstones as part of the same walkback.
- **D9.** [Q3] Hour meter = derived. Sum `conversation.duration` where `workspace_id=X AND deleted_at IS NULL AND created_at` within current calendar month. Expose via `/v2/workspaces/:id/usage`. No new `usage_event` table. Pilot hard-block = read-time check against 10h cap before host-side endpoints run.
- **D10.** [Q4] Commit the uncommitted in-flight work as a single coherent commit. **Exclude** `docs/workspaces/` and `docs/workspaces-validate/` from upcoming code commits — docs get their own commits, separated from feature work.
- **D11.** [Q5] Remove `viewer` role. No migration — rely on robust error handling for any stray rows. Drop the preset; if a DB read returns `role='viewer'`, treat as `member` + log a warning.
- **D12.** [Q6] Add `workspace:webhooks` policy. Gate at `changemaker+` via `TIER_REQUIRED_FOR_POLICY`. Freeze-on-downgrade (existing webhooks keep firing, no new configs).
- **D13.** [Q7] Defer M1 CSV tool + deployment-day thinking. Not this session.
- **D14.** [Q8] Switch upgrade-inbox default to `upgrades@dembrane.com` everywhere — `settings.py` default, docstrings, any hardcoded references in endpoints, docs.
- **D15.** Validation plan: four-axis reviewer pattern (security / human-first / brand / copy) at three cadences (spec-time / build-time / phase-boundary). Codified in `06-VALIDATION-PLAN.md`; findings logged in `06-AUDIT-LEDGER.md`. Baseline cleared audits not re-run unless I modify that code.
