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
