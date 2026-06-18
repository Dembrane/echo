# Self-serve billing and payments (Mollie)

## Status

Draft for discussion (2026-06-16). Builds on `billing-account-split.md` (the
billing_account entity is in place) and `docs/adr/0005-per-seat-tier-overhaul.md`
(the new per-seat tiers). This doc is about the user flow and the payment
integration that lets the workspace_request approval flow be deleted.

## The core shift

The whole `workspace_request` approval flow exists for one reason: there was no
automated billing, so a human had to approve and invoice. Once Mollie collects
payment, **payment is the approval.** Self-serve creation comes back, and the
request collection + admin approve/deny UI + decide endpoint + request
notifications all get deleted.

## Tiers and who can self-serve

Full definitions + feature matrix live in ADR 0005. Summary:

- **Free**: instant, no payment. 1 hour, single seat, secure transcription.
- **Innovator** ($20/seat/mo): unlimited hours, bring-your-own-LLM via the MCP.
  Purchasable once the MCP ships; "coming soon" until then.
- **Changemaker** (€75/seat/mo): the tier most customers land on. Adds built-in
  analysis (Gemini 3.5 Flash), audit logs, white labeling. **Self-serve via
  Mollie checkout** — the launch path.
- **Guardian** (€150/seat/mo): EU-sovereign stack (OVH, sovereign LLMs).
  Sales-assisted until the sovereign infra is stood up.
- **Bespoke**: "contact sales"; staff provisions an offline account.

## User flow

### 1. Onboarding (first workspace)

Unchanged in spirit: a new user gets a personal org + a default workspace on a
**Free** billing account. No payment, usable immediately.

### 2. Add a workspace (replaces "Request workspace")

1. Host clicks **Create workspace**, names it, picks visibility.
2. Picks a plan:
   - **Free** -> created instantly on a Free account. Done.
   - **Changemaker** -> the workspace is created immediately on a Free account,
     then checkout starts for the upgrade (see below). The workspace is never
     blocked from existing while payment is pending.
   - **Coming-soon / bespoke** -> "contact sales", no checkout.
3. Billing period: annual (default) or monthly (+20%). Price shown = seats x
   per-seat. At creation seats = 1 (the creator); seats meter up as members are
   invited.
4. **Mollie hosted checkout** (test mode first): redirect, pay.
5. Return URL lands on a "finishing up" state. The tier activates when the
   **webhook** confirms `paid` (not on the redirect alone). Polling the payment
   status on return is a fast-path; the webhook is authoritative.
6. Abandon or fail -> the workspace stays on Free, resumable. No orphan, no
   block.

### 3. Change plan (replaces tier_upgrade requests)

Billing-role host goes to workspace (or org) billing settings -> **Change plan**
-> pick tier -> Mollie subscription create/update -> webhook confirms -> tier
changes. Downgrade applies frozen-feature effects (whitelabel etc.) and lands at
period end (Mollie proration). No request, no staff.

### 4. Seats (metered, never blocked)

Inviting a `member` / `admin` / `owner` / `external` adds a billable seat ->
subscription quantity +1 (Mollie prorates). The invite is never blocked; the UI
shows "this adds about EUR X/mo". Removing a member -> quantity -1. `billing`
role is free and unlimited. Quantity sync is debounced so rapid membership
changes don't thrash the subscription.

### 5. Payment method, invoices, dunning

Billing role sees invoices and payment method (from Mollie). A failed recurring
charge -> Mollie retries -> account `past_due` -> in-app "update payment" banner
-> grace period -> if still unpaid, downgrade to **Free** (never delete data,
never block recording).

### 6. Offline / enterprise (staff)

Staff create an org- or workspace-scoped account with `payment_mode=offline`,
set tier + provisioned seats, and invoice out of band. No Mollie. This is the
Guardian / bespoke path.

## Partner billing & the "bill separately" choice

`org.is_partner` is a **staff-set boolean** on the org. It gates whether the
partner branching shows at all — non-partners never see it.

Workspace creation:

- **Non-partner org:** the workspace bills under the org account (default). No
  choice shown.
- **Partner org:** show two big buttons — "Is this for internal use, or for
  another client?"
  - **For internal use** -> bill under your own org (the org account), same as
    the default.
  - **For another client** -> per the partner agreement, create a **new
    subscription / workspace-scoped billing account** for that client, so it can
    be cleanly handed off later (re-pointed to the client's own org account).
    Surface incentives here (partner margin, clean handoff, the client can take
    it over without data movement).

So "bill this workspace separately" is, concretely, the partner "for another
client" path: a workspace-scoped account created with handoff in mind. Only
partners see it; everyone else is org-billed.

## Mollie integration model (from the Mollie docs, via MCP)

Mollie has **no plan / product / tier catalog**. We do not create tiers in
Mollie. A subscription is `{amount, interval, description, metadata, webhookUrl}`
on a customer; the tier lives only in `tier_capacity.py`.

Flow:
1. **Customer** per billing account (`POST /customers`) -> store `cst_…` on
   `billing_account.mollie_customer_id`.
2. **First payment** with `sequenceType=first` -> hosted checkout -> creates a
   **mandate** (background-chargeable). Can be €0.01.
3. **Subscription** (`POST /customers/{id}/subscriptions`): `amount`, `interval`
   (`1 month` / `12 months`, max 12), `description`, and **`metadata`** carrying
   `billing_account_id` (forwarded onto every generated payment). Store `sub_…`.
4. Mollie auto-charges and calls our **webhook per payment** (no per-subscription
   webhook). The payment carries `subscriptionId` + our metadata.

Per-seat nuance: Mollie subscriptions have **no quantity** — only a flat
`amount`. So per-seat pricing = `amount = seats × tier_price`, and a seat change
means **PATCH the subscription amount** (`update-subscription`). Annual ->
`interval "12 months"`, monthly -> `"1 month"`.

Dunning is built in: Mollie retries a failed charge up to 5× (daily) then
cancels; some bank reasons cancel immediately. We map failed -> `past_due`,
canceled -> downgrade to Free.

`billing_account` Mollie fields: `mollie_customer_id`, `mollie_subscription_id`,
`status` (pending / active / past_due / canceled). Subscription `metadata` =
{ account_id, org_id, tier } so Mollie's financial data (payments, settlements,
balances) joins back to our entities.

Seeing / using the data: the Mollie **test Dashboard** plus the connected
**Mollie MCP** (`ListSubscriptions`, `ListPayments`, `AggregatePayments`,
`GetBalance`, `ListSettlements`) against the test account. Test caveats: subs
auto-cancel after 10 payments; `changePaymentState` forces payment outcomes.

## Trials / pilots (the "reverse trial" — win-win)

"Pilot" stops being a tier and becomes a mechanism: a time-boxed grant of a
paid tier (Changemaker) that auto-reverts to Free. This is the **reverse trial**
pattern (full premium for a window, then downgrade to free), which the industry
data backs as the strongest model: ~18-32% trial-to-paid (median ~24%) vs
3-15% for plain freemium. It is win-win by construction: the customer gets full
value risk-free; we get high-intent conversions via loss aversion; and a
non-converter stays a Free user (a kept relationship + future upsell), not a
deleted account.

How it works (reuses existing machinery — no new structures):

- Admin grants it: `tier=changemaker`, `tier_expires_at = now + 1 month`,
  `payment_mode=none` (comped, no Mollie), `type_discount="trial"` (marks it).
- `task_send_tier_expiry_prewarning` sends the 3-day "expiring soon" nudge.
- `task_expire_workspace_tiers` auto-downgrades to Free at expiry.
- Conversion is the normal self-serve checkout; on payment we clear
  `tier_expires_at` (the Mollie subscription takes over continuity).

Best practices applied (from SaaS reverse-trial research):

- **No credit card for the comped grant.** Lowest friction; Calendly-style.
  (A self-serve card-on-file variant is possible later via a Mollie
  subscription `startDate = now + 1 month` + a €0 consent payment.)
- **Communicate the downgrade clearly** before it happens (the pre-warning
  cron) and make upgrading one click — loss aversion does the work.
- **Never delete data or hard-block on downgrade.** They drop to Free limits
  but keep everything; this preserves goodwill and keeps the upsell alive.
- **Measure** trial feature adoption and trial-to-paid conversion (PostHog),
  not just signups.

Small additions needed: a `"trial"` value on `billing_account.type_discount`
(added via the proper Directus flow with the rest of the Phase A schema), and a
staff "grant trial" action (the existing admin tier-set path + an expiry + comp).

## What can go wrong, and how we handle it

1. **Webhook never arrives / is late.** Webhook is authoritative but not the
   only path: on the return URL we fetch the payment from Mollie directly, and a
   periodic reconcile job (mirrors the existing catch-up tasks) sweeps accounts
   whose Mollie state and local state disagree. Handler is idempotent.
2. **Webhook spoofing.** Never trust the payload. On any webhook, fetch the
   payment/subscription from Mollie by id over the API and act on that.
3. **Double submit / double charge.** One active subscription per account.
   Starting checkout reuses the pending one; use an idempotency key. Serialize
   changes per account (a short lock) so two admins can't race.
4. **Paid at Mollie but our write failed.** Mollie is the source of truth for
   payment; the reconcile job repairs our state. Activation is idempotent.
5. **Abandoned checkout.** Workspace exists on Free; resumable; no orphan.
6. **Seat thrash.** Debounce quantity syncs; reconcile the true count on a
   schedule.
7. **Refund / cancel.** Cancel subscription -> account -> Free at period end;
   data retained.
8. **Past due.** Grace window + banner before any downgrade; never a hard block.
9. **Test vs live.** Key per environment; test mode in non-prod; never mixed.
10. **Org-shared account.** Seats pool across the org's workspaces; one
    subscription; deleting a covered workspace adjusts the count.
11. **Coming-soon tiers.** Not selectable for checkout; "coming soon" / "contact
    sales" only.
12. **VAT / currency.** EUR; rely on Mollie for VAT handling. Revisit if finance
    needs more.
13. **Existing customers.** Migrated to Changemaker until renewal (ADR 0005),
    with their account `payment_mode` set appropriately (offline for invoiced
    customers, mollie once they self-serve).

## Build order (no skipped steps)

Each phase ends in something demoable.

- **Phase A - new tier matrix.** `tier_capacity.py` + frontend tiers + the
  analysis gate, to the four per-seat tiers. The vocabulary everything else
  speaks. Tests. No payments yet.
- **Phase B - Mollie on the account (test mode), built robustly.** Customer per
  account, subscription/checkout, verified + idempotent webhook, reconcile job,
  account status model (pending / active / past_due / canceled). Standalone and
  testable: this is where you see a real test payment clear.
- **Phase C - self-serve flows.** Add-workspace + change-plan + manage-seats +
  invoices, wired to B. Delete the workspace_request collection, admin
  approve/deny, decide endpoint, and request notifications.
- **Phase D - hardening + migration.** Dunning/grace/downgrade, offline
  accounts, coming-soon gating, existing-customer migration to Changemaker.

## Open product decisions

1. Create-on-Free-then-upgrade (recommended, never blocks) vs gate workspace
   creation on successful payment. The doc assumes the former.
2. Seats at creation = 1 and meter up (recommended) vs let the buyer pre-purchase
   a seat count.
3. Downgrade timing: at period end (Mollie proration, recommended) vs immediate
   with proration.
