---
title: Managed & offline billing
description: How staff bill customers who don't pay self-serve - set managed, assign an account manager, issue a payment link or invoice, and mark invoices paid by bank transfer.
audience: staff
---

# Managed & offline billing

Most customers pay self-serve through [Mollie](../../features/tiers-and-billing.md#payments) -
card, automatic renewal, no human in the loop. Plenty don't: public-sector bodies, larger
organisations, anyone who needs a formal invoice and pays by bank transfer. For them, dembrane
runs *managed (offline) billing* - staff issue the invoice, the customer pays out-of-band,
staff record the payment.

This page covers that flow plus the *payments rollup* that reconciles it against real money.

It's [staff](./index.md#getting-in) work. Issuing invoices and marking them paid touches
real money - treat it like anything in finance. Customers can't see or perform any of it; from
their side they receive an invoice and pay it.

## Setting an account to managed

Mark a billing account *managed* to flip it out of the self-serve Mollie path. It now classes
as [managed in the rollup](./usage-and-billing-rollup.md#revenue-classes), and the
invoice/payment-link actions become available against it.

> [!NOTE]
> Managed is a billing *mode*, not a tier. A managed account can be on any
> [tier](../../features/tiers-and-billing.md). It changes *how they pay*, not *what they have*.

## Account managers

A managed account usually has a named *account manager* - a dembrane person who owns the
commercial relationship. *Assign* or *clear* it from the account's actions; the address must
be a dembrane one (`@dembrane.com`). Paired with the
[admin contact](./usage-and-billing-rollup.md#admin-contacts) on the rollup, you have both
ends: who at dembrane owns it, and who at the customer to talk to.

## Issuing a payment link

For a managed account that *could* pay online but needs a nudge, *issue a payment link* - a
one-off link the customer follows to pay. The middle ground between full self-serve and a
formal invoice: you control when it goes out, but they still pay through the normal rails.

## Issuing an invoice

For the formal route, *issue an invoice* - the document a finance department needs to release
a bank transfer. It supports:

- *VAT* - the applicable tax, so the customer's finance team can book it.
- *E-invoice* - a structured electronic invoice for customers (often public sector) whose
  systems require it rather than a PDF.

Issue it against the managed account at the agreed amount and tier, with the right VAT
treatment, and send it.

> [!IMPORTANT]
> An issued invoice is unpaid until you say otherwise, and issuing it grants nothing on its
> own - it's a request for money. Combine it with the agreed
> [tier](./discounts-trials-and-tiers.md#changing-a-tier) so the customer has what they're
> paying for, and [mark it paid](#marking-an-invoice-paid) when the money lands.

## Marking an invoice paid

When the bank transfer arrives, *mark the invoice paid*. This is the out-of-band
reconciliation step: dembrane can't know a transfer landed in the company bank account, so a
human records it. Marking it paid moves the account into the *paid* state - what turns a
managed account into genuine
[paying](./usage-and-billing-rollup.md#revenue-classes) revenue in the rollup.

> [!WARNING]
> Only mark an invoice paid once you have confirmation the money arrived. This is the step the
> revenue numbers trust - marking unpaid invoices as paid inflates the
> [rollup](./usage-and-billing-rollup.md) and the
> [MRR forecast](./usage-and-billing-rollup.md#mrr-forecast) with money that isn't there.

## The payments rollup

The payments rollup is the view of what's happened on the
*Mollie* side: transactions and their statuses, with deep links into Mollie to open any
transaction at source. Use it to:

- Confirm a self-serve charge went through, or find out why it didn't.
- Chase a failed or pending Mollie payment via the deep link.
- Reconcile what the [billing rollup](./usage-and-billing-rollup.md) forecasts against what
  Mollie actually collected.

> [!TIP]
> The two views answer different questions. The
> [billing rollup](./usage-and-billing-rollup.md) is "what *should* each account pay?"; the
> payments rollup is "what *did* arrive, through Mollie?". A gap is usually an unpaid managed
> invoice or a failed Mollie charge.

## The managed flow, end to end

1. *Set the account managed* - flip it out of self-serve.
2. *Assign an account manager* (`@dembrane.com`).
3. *Issue the invoice* with the right VAT and, if needed, as an e-invoice.
4. The customer *pays by bank transfer* out-of-band.
5. *Mark the invoice paid* once the money is confirmed.
6. Reconcile in the [payments rollup](#the-payments-rollup) and check the account now reads as
   [paying](./usage-and-billing-rollup.md#revenue-classes).

## Related

- [Usage & billing rollup](./usage-and-billing-rollup.md) - where managed and paid accounts
  show up, and the revenue classes.
- [Discounts, trials & tiers](./discounts-trials-and-tiers.md) - set the tier the invoice bills for.
- [The admin panel](./admin-panel-overview.md) - the kebab actions for managed billing.
- [Tiers & billing](../../features/tiers-and-billing.md#payments) - Mollie and where managed
  invoicing fits.
