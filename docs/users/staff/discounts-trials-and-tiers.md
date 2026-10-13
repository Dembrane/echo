---
title: Tiers and discounts
description: How dembrane staff change an account's tier, set a discount and mark a partner organisation from the account actions in the staff console.
audience: staff
---

# Tiers and discounts

A new customer does not buy a plan in the dashboard. There is no checkout, and signing an offer
does not change the tier. You set the tier here. The same place holds the discount and the partner
mark.

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
- [Tiers and billing](../../features/tiers-and-billing.md): what each tier includes, for the customer.
- [Partner program](../../features/partner-program.md): workspaces for external organisations.
