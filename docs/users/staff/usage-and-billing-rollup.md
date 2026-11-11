---
title: Usage, billing and payments
description: The staff view of every billing account for a month (tier, hours, seats and forecast), its filters and CSV export, the payments screen, and AI costs per account.
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

## AI costs

"AI costs" (`/admin/ai-costs`) shows what AI cost for "This month" or "Last month": every AI
call on every tier, priced in euros at the providers' list prices. Paid accounts are recorded
the same way as free ones; they just have no budget.

Under the month selector are two strips of figures.

- "Spend" splits the month's cost four ways, and the parts add up to the total:
  - "Total cost": every priced AI call, on every tier.
  - "Charged to accounts": the sum of the account rows below. It also includes calls billed
    to accounts that have since been removed entirely (no longer in the list). The caption then
    says "incl. €x from removed accounts". A soft-deleted account is still a row, with a
    "Deleted" badge. If no account was charged, the caption says "No account was charged".
  - "Unattributed": calls that no account could be matched to (see below).
  - "Internal": calls that belong to no account and are never charged: staff demo building,
    voice input used outside any project or workspace, and dev tools ("Demos, voice outside
    projects, dev tools").
- "Accounts and providers" shows "Accounts with AI calls", "Free accounts at or over budget"
  (100% or more), and one total per provider with its share of the total. A provider whose
  calls all cost €0 gets no tile. Use the provider totals for the monthly invoice check:
  compare "Provider: Google Vertex" with the Vertex AI line of the Google invoice (cost
  before credits), and "Provider: Scaleway" with the Generative APIs line of the Scaleway
  invoice. A gap above about 5% means the prices or the recording need a look.

Below the strips, "By account" lists one row per billing account, most expensive first:

- "Account" is the organisation's name, else the workspace's, else the account's label. The
  line under it gives the tier and the kind of account, for example "Free, organisation
  account". Hover a cut-off name to read it in full. A deleted account is still listed,
  with a "Deleted" badge, so its cost still adds up.
- "Cost" is the account's AI cost this month.
- "Budget" is one line:
  - "€5.00 default" when a free account uses the free plan default
  - "€20.00 until Dec 31, 2026" or "€20.00 custom" for the account's own budget. The date
    is the last day on that budget, the same day the "Until" field shows
  - "No limit" (or "No limit until ...") for an account with no limit
  - "Paid plan" for a paid account
- "Used" shows a free account's share of its budget as a percentage with a small bar. The bar
  turns yellow from 80% and red from 100%. Other accounts show "-".
- "Top feature group" names the group that cost the most and its share, for example
  "Recording 97%".

Amounts never show a cost as €0.00 when it is not zero. From €1 up they have two decimals.
Below €1 they show up to four decimals (€0.035, €0.0035). Anything under €0.0001 shows as
"< €0.0001".

- Click a row (or its arrow) to open or close its breakdown:
  - "By feature group" lists the account's cost per group: Chat, Assistant, Reports, Map,
    Analysis, Canvas, Portal, Recording, Voice input and Other. Each group shows its calls,
    cost, share and a bar. Under each group are its parts in plain words, such as
    "Transcription" or "Suggestions", each with its cost and share. Under each name is the
    raw operation key the platform records, such as `conversations.chunk` or
    `GET /api/chats/:chat_id/suggestions`, so you can trace it in the logs. An operation
    the page does not know lands in "Other" under its raw key.
  - "By model" lists each model with its provider, calls, cost and share. Providers show by
    name: "Google Vertex", "Scaleway" (our EU deployment, recorded as `openai-compatible`),
    "Test" for the test provider and "Unknown" when none was recorded. Any other provider
    shows as recorded.
- The three-dot button at the end of a row opens the account actions, where "AI budget" sets
  the account's own budget. See
  [tiers and discounts](./discounts-trials-and-tiers.md#set-an-accounts-ai-budget). Clicking
  the row itself only opens the breakdown.
- On a phone, each account is a card with the same figures, the same three-dot button and
  the same breakdown.
- An account that moved down to Free during the month adds the paid part and the free part of
  the month in "Cost". "Used" counts only the free part, as the budget does.

If the month has no AI cost at all, the page only says "No AI costs recorded this month." (or
names the month). If there was spend but no account was charged, the strips stay and "By
account" says "No account was charged this month.".

"Unattributed" is AI cost that no account or internal reason was found for. It should stay
near zero. Each night a job posts to the AI cost Slack channel when yesterday's unattributed
share passes 1%. The same channel gets every price change, with large changes (more than 3x)
flagged, and any model that has no price: at each start, for configured models still unpriced
after a price sync, and from each running server the first time it charges a model with no
price. Such a call is charged at the highest price held, so it never costs nothing.

Sample projects' AI shows in the account's "Cost" and features but never counts toward "Used"
or the budget. Staff demo building and dev tools are recorded as internal and belong to no
account. Prices update on their own every day from models.dev, plus a hand-kept file for the
Scaleway models, the Vertex embedding model and Google Search lookups.

## Related

- [The staff console](./admin-panel-overview.md): the sections, and where the account and workspace actions open.
- [Tiers and discounts](./discounts-trials-and-tiers.md): change what an account has and pays, its AI budget, and the free tier limits.
- [Managed billing](./managed-and-offline-billing.md): accounts that pay by invoice.
- [Support access](./support-access.md): "Join for support" in the workspace actions.
- [Tiers and billing](../../features/tiers-and-billing.md): the same accounts from the customer's side.
