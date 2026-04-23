# Audit ledger

Append-only. One row per finding. Findings from subagent validation dispatches (see `06-VALIDATION-PLAN.md`) land here so future sessions can see what's cleared and what's outstanding.

## Baseline (pre-session)

Three audit rounds shipped fixes before this session. Treat their scope as cleared unless I change that code. Reference commits for the baseline:

- `f2bfb2f` — audit summary + fix/defer ledger for the 5-perspective review
- `8aba15d` — round-2 audit (7 of 8 critical/high findings addressed)
- `deb6597` — security + footgun pass from audits
- `4646825` — private projects: read-time enforcement on common surfaces
- `15c7d1a`, `2f543ac`, `ff93e68`, `0120a72` — inheritance + security spot fixes

Open from the baseline (per release-checklist.md §"Private-project read enforcement"):
- Deep-linked chat/conversation URL to a private project's chat bypasses `ProjectAccessGuard` because the Directus SDK path doesn't know about visibility. Fix: tighten Directus permissions on `project / conversation / project_chat / project_report` reads. Tracked as its own session.

## Findings

### Columns

| ID | Date | Severity | Axis | File:line | Issue | Fix | Resolution |
|---|---|---|---|---|---|---|---|
| F1 | 2026-04-23 | high | security | workspaces.py:get_workspace_usage | Initial member preset lacked `workspace:view_usage` → members would have gotten 403 despite matrix §4 granting them "View usage & overage". | Added `workspace:view_usage` to member preset; endpoint also explicitly rejects `is_external=true` (guest) callers, matching matrix §4 (members ✓ guest ✗). | Fixed in same commit. |
| F2 | 2026-04-23 | nit | security | workspaces.py:get_workspace_usage | Default tier fallback `or "pilot"` meant NULL-tier rows would silently activate Pilot hard-block. | Changed to `or ""` → falls through to the unknown-tier path (treated as unlimited / no block). Reviewed in commit. | Fixed in same commit. |
| F3 | 2026-04-23 | medium | security | workspaces.py:get_workspace_usage | A guest (`is_external=true`) with an elevated role would be counted only as guest, skipping seat billing. | State is blocked at invite + change-role write paths already. Added defensive `logger.warning` so ops can spot any drift. | Fixed in same commit. |
| F4 | 2026-04-23 | false-pos | security | workspaces.py:get_workspace_usage | Agent flagged `billing` role in seat counter as possibly wrong. | Matrix §7: "Seat = active workspace access. One seat per person per workspace, for members, admins, and billing." Billing counts as seat. Intentional. | N/A — keep. |
| F5 | 2026-04-23 | nit | security+copy | workspaces.py:set_workspace_tier + tier_downgraded.{html,txt} | Mental review only (no subagent dispatch — scope small). Auth guard unchanged. Subject via `_strip_header_unsafe`. Jinja autoescape covers template fields; all substitutions are admin-controlled strings. Copy: "dembrane" never written as "Dembrane", no bold, no "successfully/please/click here", Royal Blue accent for workspace name, Graphite text. | N/A — shipped as-is. |
| D1 | 2026-04-23 | — | dev-action | scripts/backfill_direct_memberships.py | Ran `--apply` on dev Directus per user-confirmed stop condition. Wrote 2 direct rows across 2 orgs (both seed "Default" workspaces). Re-run with `--dry-run` shows 0 proposals → idempotent + complete on dev. Prod run pending Q7 deployment thinking. | Applied on dev. |

