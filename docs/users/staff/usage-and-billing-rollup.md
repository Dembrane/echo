---
title: Usage & billing rollup
description: The master staff view of every account - usage per account and workspace, revenue class, MRR forecast, admin contacts, CSV export, and a 12-month lookback.
audience: staff
---

# Usage & billing rollup

The billing rollup shows every billing account on dembrane, broken down by workspace, with
what each is using and what each pays. It's the panel's home view and answers the standing
questions: who's paying, who's on a trial, what's our recurring revenue, where is it forecast
to go.

Any [staff](./index.md#getting-in) account can open and export it. The *actions* you reach
from each row - change tier, apply a discount, issue an invoice - have their own gating; see
[the kebab-action model](./admin-panel-overview.md#the-kebab-action-model).

## What's in a row

The rollup nests two levels:

- *Per billing account* - the billing unit. Usually organisation-scoped (one pooled account
  across internal workspaces); for [external-client](../../features/partner-program.md) work
  it's workspace-scoped. The account row carries the revenue class, the MRR figure, and the
  [admin contact](#admin-contacts).
- *Per workspace* - under each account, the workspaces that draw on it, each with its own
  [tier](../../features/tiers-and-billing.md), seat count, and usage.

This mirrors how [billing is organised](../../features/tiers-and-billing.md#how-billing-is-organised):
seats and money attach to the account; usage happens in the workspaces.

## Revenue classes

Every account is sorted into a *revenue class* so you can tell real money from everything else:

| Class | What it means |
|---|---|
| *paying* | A genuine paying customer - Mollie subscription or a paid managed invoice. This is the money. |
| *trial* | On a [reverse trial](./discounts-trials-and-tiers.md#granting-a-reverse-trial) or otherwise trialling - revenue *if* they convert, not yet. |
| *managed* | Billed offline by bank transfer rather than self-serve Mollie. See [managed & offline billing](./managed-and-offline-billing.md). |
| *comped* | Complimentary - a [discount](./discounts-trials-and-tiers.md#discounts) brings them to no or reduced cost. Real usage, intentionally not (fully) billed. |

> [!TIP]
> The classes are the quickest sanity check on the business. Trials that never become paying
> are a conversion problem; a growing comped column is generosity worth reviewing. Use the
> [status filter](#filters) to isolate one class.

## MRR forecast

Each account contributes to a *monthly recurring revenue (MRR) forecast* - what dembrane
expects to earn from it monthly, derived from its tier, seats, and billing cadence. Tiers are
[billed yearly by default with a 15% monthly premium](../../features/tiers-and-billing.md#monthly-vs-yearly),
so the forecast normalises those to a comparable monthly figure. The rollup totals it across
the accounts in view, so a [filter](#filters) re-totals the forecast for that slice.

> [!NOTE]
> The forecast is a forecast, not booked revenue. Unconverted trials and unpaid managed
> invoices are potential, not banked. Cross-check the
> [payments rollup](./managed-and-offline-billing.md#the-payments-rollup) for what's actually arrived.

## Admin contacts

Each account row surfaces its *admin contact* - the person to email. That's what turns the
rollup into an outreach tool: you spot an at-risk or expiring account and already have the
name and address, without digging through the member list.

If the listed admin is unreachable, that's the case
[change admin](./discounts-trials-and-tiers.md#changing-the-admin) exists for.

## The 12-month lookback

Use the month lookback to step back through the last 12 months.
The current month is the default, then last month, and so on. Use it to see what an
account looked like before a downgrade, compare months, or pull a historical month for a
finance reconciliation.

## Filters

The rollup is large, so filter to the slice you need:

- *Search* - by account or workspace name (and admin contact), to jump to one customer.
- *Tier* - Free, Innovator, Changemaker, or Guardian only. Handy for "who's still on Free and
  using a lot?"
- *Status / revenue class* - isolate paying, trial, managed, or comped.

Filters re-total the [MRR forecast](#mrr-forecast) for the visible set, so they double as
quick aggregates.

## CSV export

Any view - filtered or not, this month or a lookback month - exports to *CSV*: a finance
hand-off, a revenue-class slide, or a spreadsheet pivot beyond what the table shows. The
export reflects the current filters and month, so set those first.

## How you'd use it

1. Open the rollup on the current month.
2. Glance at the totals - MRR forecast, the split across revenue classes.
3. Filter to *paying* for banked recurring revenue; to *trial* for the conversion pipeline.
4. Search any account you've been asked about; read its tier, seats, usage, and admin contact.
5. From a row's [kebab](./admin-panel-overview.md#the-kebab-action-model), take whatever
   action the situation needs - or note the contact and reach out.
6. Export to CSV if someone downstream needs the numbers.

## Related

- [The admin panel](./admin-panel-overview.md) - where the rollup sits and the kebab actions
  it offers.
- [Account health & at-risk](./at-risk-and-account-health.md) - the rollup pre-triaged into
  who needs attention.
- [Managed & offline billing](./managed-and-offline-billing.md) - what "managed" means and the
  payments rollup behind real money.
- [Discounts, trials & tiers](./discounts-trials-and-tiers.md) - what "comped" and "trial"
  mean and how to set them.
- [Tiers & billing](../../features/tiers-and-billing.md) - per-seat pricing, billing accounts,
  and the yearly/monthly split the forecast normalises.
