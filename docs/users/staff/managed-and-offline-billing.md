---
title: Managed billing
description: How dembrane staff put an account on managed billing, name an account manager, issue a payment link or an invoice, record a paid invoice, and move an account off managed billing.
audience: staff
---

# Managed billing

A managed account pays by invoice, not by card. dembrane does not charge it automatically and its
tier has no end date. Every feature of its tier stays on.

The customer's billing page then shows the badge "Managed by dembrane" and the line "Your plan is
managed by dembrane. Contact your account manager to make changes.", with "Seats", "Account
manager", their invoices and the billing details form.

> [!NOTE]
> Invoices for a signed offer do not come from this screen. dembrane's accounting system makes and
> sends them. See [customer accounts](./customer-accounts.md#the-invoice).

## Put an account on managed billing

1. Open the account actions on "Usage and billing" (the three-dot button on the account's row).
2. Under "Billing mode", select "Set to managed billing".
3. Confirm with "Set to managed".

The account keeps its tier. Changing an account to a paid tier also puts it on managed billing.
See [tiers and discounts](./discounts-trials-and-tiers.md).

An account that pays by card subscription cannot be switched: "This account has a live Mollie
subscription. Cancel it first." The customer cancels it from their own billing page.

## The managed billing screen

"Managed billing" has no sidebar entry. Open it at `/admin/managed-billing`, then pick the
customer under "Account". Accounts that are already managed are marked "(managed)".

| You want to | Use |
|---|---|
| Put the account on managed billing at a tier | "Tier", then "Set managed" |
| Name the customer's contact at dembrane | "Account manager", then "Assign" |
| Give the customer a link to pay online | "Payment link amount, EUR", then "Issue payment link" |
| Issue an invoice | "Invoice amount, EUR", then "Issue invoice" |
| Record an invoice the customer has already paid | "Invoice amount, EUR" and "Payment reference", then "Mark invoice paid" |

Good to know:

- "Account manager" takes the dembrane user id of a colleague. Only an account with an
  @dembrane.com address is accepted. The customer sees their account manager on their billing
  page.
- The screen says of the amounts: "Amounts default to the account's seats times the per-seat
  price. Override only when you need to."
- "Issue payment link" opens the link in a new tab. Send it to the customer yourself.
- Tick "E-invoice" to issue the invoice as an e-invoice.
- "Mark invoice paid" is for money that already arrived by bank transfer. It records a new
  invoice as paid, with your "Payment reference". It does not settle an invoice you made earlier
  with "Issue invoice".

## Leave managed billing

1. Open the account actions on "Usage and billing".
2. Under "Billing mode", select "Switch to self-serve billing".
3. Choose what happens to the plan:
   - "Downgrade to Free now": the account moves to Free.
   - "Keep {tier} until a date": pick the date under "Access ends on". The account keeps its tier
     until then.
4. Select "Switch to self-serve".

An account that keeps its tier until a date carries the "Trial" badge on "Usage and billing". When
the date passes:

- The account moves to Free within the hour.
- The workspace's admins, owners and billing members get a notice in the app and the email
  "{workspace_name} is now on the free plan".
- A workspace billed on its own account also gets one warning 3 days before: "{workspace_name}
  moves to the free plan on {date}". Workspaces on an organisation account get no warning email,
  so tell that customer the date yourself.

## Related

- [Tiers and discounts](./discounts-trials-and-tiers.md): change the tier and set a discount.
- [Usage, billing and payments](./usage-and-billing-rollup.md): where managed accounts show, and the payments screen.
- [Customer accounts](./customer-accounts.md): offers, and the invoices that follow a signed offer.
- [Tiers and billing](../../features/tiers-and-billing.md): the billing page as the customer sees it.
