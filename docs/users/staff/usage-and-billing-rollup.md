---
title: Usage, billing and payments
description: The staff view of every billing account for a month (tier, hours, seats and forecast), its filters and CSV export, and the payments screen.
audience: staff
---

# Usage, billing and payments

"Usage and billing" is the first screen of the [staff console](./admin-panel-overview.md). It
shows which tier each account is on, what it used in a month and what it is expected to pay.
"Payments" shows the card and direct debit payments that came in.

## Read the table

Pick the month at the top: "This month", "Last month", "2 months ago" or "3 months ago".

Each row is one billing account.

| Column | What it shows |
|---|---|
| "Account" | An organisation's name with "Organisation account", or a workspace's name with "Workspace account". |
| "Tier" | The account's tier. |
| "Hours" | Hours of audio recorded that month in the account's workspaces. |
| "Seats" | People in a paid role in the account's workspaces. Observers are free and not counted. |
| "Forecast" | What the account is expected to pay per month, worked out from its tier, seats, billing period and discount. |

An "Organisation account" is the one plan that an organisation's internal workspaces share. A
"Workspace account" belongs to a workspace that is billed on its own, such as one made for an
external organisation.

Two badges can sit next to the name:

- "Trial": a paid tier with an end date and no payment. Its forecast is €0.
- "Managed": the account is on [managed billing](./managed-and-offline-billing.md). The tooltip
  reads "Invoiced offline, no Mollie mandate."

Expand a row to see its workspaces with "Status" ("Active" or "Inactive"), "Hours" and "Seats".
A workspace is active when it has members or recorded audio in that month. "Breakdown by tier"
under the table counts the workspaces on each tier.

## Paying revenue

"Paying revenue this month" adds up the forecast of the accounts in view. Two kinds of account
count as €0:

- an account on a trial;
- an account on a paid tier that neither pays by card nor is on managed billing.

A badge such as "3 comped" says how many there are. Its tooltip reads "Trial and comped accounts,
excluded from the paying total."

> [!NOTE]
> The forecast is what an account is expected to pay, not money received. For money received by
> card or direct debit, see [Payments](#payments).

## Find an account

- Search: "Search account, workspace, organisation, email, tier". The email is that of a
  workspace admin.
- "All tiers": pick one or more tiers.
- "All", "Active" or "Inactive".

The paying revenue total follows your search and filters.

## Export

"Export CSV" downloads the accounts in view for the chosen month, one line per workspace: the
account, tier, billing mode, discount, hours, seats, forecast and a workspace admin's email. Set
the month and the filters first.

## Payments

"Payments" lists "Recent payments across all accounts": the charges taken by card or direct debit
through Mollie, grouped by month.

- Four totals sit at the top: "Paid", "Failed", "Pending" and "Accounts billed".
- Filter by status ("All", "Paid", "Failed", "Pending", "Open") or search with "Search account,
  status, description".
- Each payment shows "Date", "Account", "Tier", "Amount", "Status", "Type" ("Initial", "Renewal"
  or "One-off") and "Description".
- "Open" on a row opens that payment at Mollie. "Open Mollie dashboard" opens the dashboard
  itself.

A failed charge does not stop the customer's plan. They get one notice in the app and the email
"Your payment to dembrane didn't go through", and their billing page shows "We couldn't charge
your payment method" with "Try again" and "Change payment method". Watch the "Failed" total and
follow up yourself.

Invoices for a signed offer are not on this screen. See
[customer accounts](./customer-accounts.md#the-invoice).

## Related

- [The staff console](./admin-panel-overview.md): the sections, and where the account and workspace actions open.
- [Tiers and discounts](./discounts-trials-and-tiers.md): change what an account has and pays.
- [Managed billing](./managed-and-offline-billing.md): accounts that pay by invoice.
- [Support access](./support-access.md): "Join for support" in the workspace actions.
- [Tiers and billing](../../features/tiers-and-billing.md): the same accounts from the customer's side.
