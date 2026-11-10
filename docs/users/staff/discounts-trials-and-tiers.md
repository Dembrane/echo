---
title: Tiers and discounts
description: How dembrane staff change an account's tier, set a discount, give an account its own AI budget and mark a partner organisation from the account actions, and change the free tier limits.
audience: staff
---

# Tiers and discounts

A new customer does not buy a plan in the dashboard. There is no checkout, and signing an offer
does not change the tier. You set the tier here. The same place holds the discount, an account's
own AI budget and the partner mark. The values every free account gets are under
[free tier limits](#free-tier-limits).

## Open the account actions

1. Open "Usage and billing" in the [staff console](./admin-panel-overview.md).
2. Find the account. The search takes an account, workspace or organisation name, or a workspace
   admin's email.
3. Select the three-dot button at the end of its row.

## Change the tier

1. Under "Change tier", choose the new tier. The screen offers Free and Changemaker.
2. Select "Apply".
3. Confirm with "Change tier".

What the change does:

- The tier belongs to the billing account. On an organisation account it changes every internal
  workspace of that organisation at once.
- A workspace billed on its own account is changed from its own workspace actions. Expand the
  account row and use the three-dot button on the workspace.
- Moving to Changemaker puts the account on [managed billing](./managed-and-offline-billing.md).
  The confirmation reads: "This puts the account on dembrane-managed billing: no automatic Mollie
  charges or auto-expiry."
- Moving to Free: "This returns the account to standard free billing."

A move down takes effect at once ("A downgrade limits features immediately."):

- Private projects, private workspaces and webhooks that exist stay. No new ones can be made.
- The workspace's own logo is removed.
- The workspace's admins, owners and billing members get a notice in the app and the email
  "{workspace_name} moved to {to_tier}". The workspace shows a banner for 7 days.

> [!IMPORTANT]
> You cannot change the tier of an account that pays by card subscription. The screen says: "This
> account has an active subscription. Ask the customer to cancel it from their billing page before
> you change the tier."

## Set a discount

1. Under "Discount", choose the "Type": "Scholarship" or "Staff discount".
2. Enter the "Percent".
3. Select "Save discount".

The discount is stored on the billing account. It applies to every charge of a card subscription,
and the customer's billing page then shows the percentage with "discount applied". The forecast on
"Usage and billing" takes it into account.

## Set an account's AI budget

A free account gets the default monthly AI budget from "Free tier limits" (EUR 5 unless staff
changed it). "AI budget" in the account actions gives one account its own amount, or no limit.

1. Under "AI budget", enter the "Amount per month" in euros, or switch on "No limit".
2. Optionally pick "Until", the last day on this budget. The day you pick is included: the
   account returns to the default at 00:00 UTC the day after. The earliest day is today in
   UTC, so late in the day west of UTC the calendar may start at tomorrow.
3. Select "Save AI budget". "Clear" returns the account to the default at once.

What it does:

- It sits on the paying account. For a client workspace that shares its organisation's free
  allowance, set it on the organisation account.
- It applies only while the account is on the free plan. Paid accounts are never limited.
- "No limit" skips the budget check only. The account's AI is still recorded and shows on
  "AI costs" with "No limit". Audio, project and the other free limits still apply.
- The amount goes up to EUR 1,000 a month. EUR 0 blocks all AI for the account.
- It takes effect on the account's next AI action. Every save and clear is in the audit trail.

Use it for a prospect's sales-meeting project, a pilot, or an account that needs a little more
this month.

## Free tier limits

"Free tier limits" (`/admin/free-tier-limits`) holds "Free plan limits", the values every free
account gets. Each row shows the "Current" value, the "Default", who changed it last, and a
"New value" with "Save". A change reaches every server within a minute.

| Limit | Default | Notes |
|---|---|---|
| "Audio per month" | 5 h | |
| "Audio per conversation" | 1 h | |
| "Projects" | 1 | |
| "Minimum popcorn interval" | 5 min | How often a free live popcorn session may analyse. |
| "AI budget per month" | EUR 5.00 | In euros, up to EUR 1,000. Stored in micro-euros (EUR 1 = 1,000,000). |
| "AI budget enforced" | On | The emergency off switch, see below. |

The AI budget is what a free account may spend on AI in a month, at the providers' list prices.
It resets on the 1st at 00:00 UTC. Customers never see euros: their card shows "AI this month"
as a percentage. When the budget is used up, AI features and new recordings stop for that
account until the 1st, and its admins get one email.

> [!WARNING]
> "AI budget enforced" set to "Off: costs are recorded, nobody is blocked" turns off every
> budget check for every free account within a minute. Costs are still recorded and priced.
> Customers see no AI banner while it is off; their card still shows "AI this month".
> Use it only when the budget blocks people by mistake, and switch it back on after.

## Mark a partner organisation

On an organisation account, tick "Partner" under "Partner organisation".

The mark is for dembrane's own records. It does not change what the organisation can do: every
organisation owner or admin can create a workspace for an external organisation, with or without
the mark.
See [external-client workspaces](../host-partner/external-client-workspaces.md).

## A paid tier with an end date

To let a paid tier run until a date and then end, use "Keep {tier} until a date" when you move the
account off managed billing. See
[leave managed billing](./managed-and-offline-billing.md#leave-managed-billing).

## Related

- [Managed billing](./managed-and-offline-billing.md): what a paid tier set by staff means for billing.
- [Usage, billing and payments](./usage-and-billing-rollup.md): the table these actions open from.
- [Customer accounts](./customer-accounts.md): the offer that comes before a tier change.
- [AI costs](./usage-and-billing-rollup.md#ai-costs): what each account's AI cost, and its budget.
- [Tiers and billing](../../features/tiers-and-billing.md): what each tier includes, for the customer.
- [Partner program](../../features/partner-program.md): workspaces for external organisations.
