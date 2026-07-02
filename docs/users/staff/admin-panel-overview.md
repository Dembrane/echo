---
title: The admin panel
description: How to reach the dembrane admin panel, how its sections fit together, and the kebab-action model that runs through all of it.
audience: staff
---

# The admin panel

The admin panel is where you watch the health of every account, change tiers, approve
upgrades, issue invoices, grant trials, and run trainings - everything a customer can't do
to their own account. This page is the map: how to get in, what each section is for, and the
*kebab menu* you'll use over and over.

You reach it with a staff account - see [getting in](./index.md#getting-in). A few of the most
sensitive actions need extra permission on top of that; where one applies, that action's page
says so.

## Getting in

You reach the panel from the dashboard, the same way you'd reach your own settings - you just
see more. If it isn't there, your account isn't set up as staff yet; ask whoever manages staff
access.

## The sections

### Usage & billing

The master rollup: every billing account and its workspaces, what they use, what they pay,
and what they're forecast to pay. It carries the revenue classification (trial / managed /
comped / paying), the MRR forecast, admin contacts, CSV export, and a 12-month lookback.

→ [Usage & billing rollup](./usage-and-billing-rollup.md).

### At-risk

The rollup pre-triaged for outreach: pilot hard-blocks, at-cap, approaching-cap, and
recently-downgraded accounts, sorted with the most urgent on top.

→ [Account health & at-risk](./at-risk-and-account-health.md).

### Payments

The Mollie side of billing: transactions taken, their statuses, and deep links into Mollie to
chase a failed or pending payment. Managed (offline) invoices reconcile against real money here.

→ [Managed & offline billing](./managed-and-offline-billing.md).

### Training

The compliance-training admin: the catalogue, scheduling sessions, completing them (which
grants every attendee a one-year licence), and the roster.

→ [Trainings & licences](./trainings-and-licences.md).

> [!TIP]
> Two jobs don't have their own tab but run through the panel: *upgrade requests* (the
> approve/deny queue - see [upgrade requests](./upgrade-requests.md)) and *partner ops* (the
> toggle, referral ledger, external-led-orgs signal - see
> [partner administration](./partner-administration.md)).

## The kebab-action model

Most of what you *do* happens through a *kebab menu* - the three-dot (⋮) button next to a
row. The rollup and at-risk lists are tables of accounts and workspaces; each row's kebab
opens the actions you can take against that account or workspace.

*Workspace actions* (per workspace row):

- *Change tier* - needs extra staff permission. See
  [discounts, trials & tiers](./discounts-trials-and-tiers.md#changing-a-tier).
- *Change admin* - for when the named admin is unreachable. See
  [discounts, trials & tiers](./discounts-trials-and-tiers.md#changing-the-admin).
- *Reset usage* - with a *reason*. See
  [discounts, trials & tiers](./discounts-trials-and-tiers.md#resetting-usage).
- *Discount* - scholarship / staff discount / trial, as a percentage. See
  [discounts, trials & tiers](./discounts-trials-and-tiers.md#discounts).

*Account actions* (per billing account):

- *Grant reverse trial* - one month of Changemaker, auto-reverting. See
  [discounts, trials & tiers](./discounts-trials-and-tiers.md#granting-a-reverse-trial).
- *Discount* - the canonical place to set one is the account level. See
  [discounts, trials & tiers](./discounts-trials-and-tiers.md#discounts).
- *Set managed / assign account manager / issue payment link / issue invoice / mark paid* -
  the whole offline-billing flow. See
  [managed & offline billing](./managed-and-offline-billing.md).

*Organisation actions*:

- *Partner toggle* - see
  [partner administration](./partner-administration.md#the-partner-toggle).

> [!WARNING]
> Kebab actions take effect immediately and most are visible to the customer (a tier change, a
> reset, a discount on their next invoice). There's no draft state. Read the action's page
> first, and use the *reason* field where one is offered - it's the audit trail.

## A typical visit

1. Open *Usage & billing*, pick the month, scan revenue and the MRR forecast.
2. Jump to *At-risk* to see who needs a nudge; use each row's kebab to reset usage, apply a
   discount, or grab the [admin contact](./usage-and-billing-rollup.md#admin-contacts) to email.
3. Clear the *upgrade-request* queue - approve the genuine ones, deny the rest.
4. If finance needs it, open *Payments* to reconcile a managed invoice or chase a failed Mollie charge.
5. If you ran a training, open *Training* and complete the session to grant licences.

## Related

- [Staff overview](./index.md) - what the panel is and how to get in.
- [Usage & billing rollup](./usage-and-billing-rollup.md) - the master table you start from.
- [Account health & at-risk](./at-risk-and-account-health.md) - the pre-triaged outreach list.
- [Tiers & billing](../../features/tiers-and-billing.md) - the plans you change from here.
- [Roles & permissions](../../features/roles-and-permissions.md) - the customer roles the
  rollup shows.
- [Roles & policies in code](../developer-internal/roles-and-policies.md#staff-policies) - the
  gate, staff policies, and admin API, for engineers.
