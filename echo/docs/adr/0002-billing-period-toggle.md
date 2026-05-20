# Billing period as a request-time choice with admin override capture

## Status
proposed (2026-05-19)

## Context
Tier prices in the matrix today are flat per-month figures (Pioneer €200/mo, Innovator €500/mo, etc.) with billing cadence handled informally over email. We want a self-serve billing-period choice (annual vs monthly) on every pricing surface — cards (CreateWorkspace, FeatureGate upgrade modal, admin approval dialog) and matrix (WorkspaceSettings, AdminSettings) — with monthly billing carrying a +10% premium over annual. Pilot and Free are exempt; Pioneer/Innovator/Changemaker/Guardian carry the toggle. Automated billing is not yet built — today the cadence choice flows to a manual invoicing process.

## Decision
- **Pricing data is computed server-side and exposed as a nested object.** The `/v2/workspaces/tier-capacities` API returns `pricing: { annual_billing, monthly_billing, one_time }` per tier instead of the flat `price_eur_monthly` + `price_note` shape. Free → `pricing=null`; Pilot → `one_time` only; Pioneer+ → `annual_billing` and `monthly_billing` both populated. The frontend never multiplies or parses pricing strings.
- **The premium is a code constant.** `MONTHLY_BILLING_PREMIUM_PCT = 10` lives in `tier_capacity.py` next to the matrix. No env var, no DB config, no admin UI knob — changing it is a code review + deploy, same gate as changing tier prices.
- **The toggle multiplies base price only.** Seat overage and hour overage rates are flat across billing periods. The "10% off (annual)" badge is true for the base price; muddying it with overage bumps would force fine-print copy.
- **`workspace_request` gains two columns, not one.** `proposed_billing_period` captures the user's choice at submit time; `approved_billing_period` captures the admin's decision at approval time. Both are nullable (null for non-applicable tiers). Capturing both preserves intent for disputes and gives future automated billing a clean source of truth for `workspace.billing_period` backfill.
- **The cadence flows through the existing notification + email channels.** The staff `WORKSPACE_REQUEST_SUBMITTED` notification message becomes `org · tier · cadence` (omitting cadence for pilot/free). The `workspace_request_submitted` email template gains a `proposed_billing_period` field. The approval email surfaces the `approved_billing_period` and an extra sentence when admin overrode the user's choice.
- **No `workspace.billing_period` column yet.** Today billing is manual and the cadence info is fully consumed by the request + email channel. The column will be added when automated billing is built, backfilled from the most-recent approved request per workspace.
- **No feature flag.** The change is additive — the toggle defaults to annual, which matches today's prices and behavior. Rolling back means reverting the deploy.
- **PostHog `workspace_request_submitted` event lands in the same PR**, with `proposed_tier` and `proposed_billing_period` properties. No event on toggle keystroke — interaction noise.

## Consequences
- **The matrix dataclass field `price_eur_monthly` is now load-bearing in two semantic senses.** Internally it still means "matrix per-month rate." At the API boundary it's relabeled as `pricing.annual_billing.per_month_eur`, and `pricing.monthly_billing.per_month_eur` is derived. The field name does not match the API contract — readers of `tier_capacity.py` should treat the value as "annual-billing per-month price" until a future refactor renames it.
- **Two columns to keep in sync at approval time.** A bug that writes `approved_billing_period` without `proposed_billing_period` (or vice versa) would split the audit trail. The submit handler always writes proposed; the approval handler always writes approved. Don't migrate this to a single column without considering the dispute case ("you upgraded me to monthly even though I asked for annual").
- **Overage rates are intentionally flat across cadences.** A monthly-billed Pioneer pays the same €25/seat and €5/hour as an annual Pioneer. If finance later wants symmetric premiums on overage, that's a new ADR — don't quietly multiply.
- **Pilot keeps its `one_time` shape forever, even if we add yearly Pilot variants later.** The nested `pricing` object is the contract — adding a new cadence slot is additive; reusing the existing slots for a different cadence shape is breaking.
- **`TIER_CAPACITY_SHORT` and the i18n fallback strings in `lib/tiers.ts` need to stay in sync with the matrix.** They are the offline fallback when the API call fails; they are not authoritative. Guardian's "custom pricing" copy is removed — its €5,000/mo is the published price.
