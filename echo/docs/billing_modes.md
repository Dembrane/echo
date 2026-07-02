# Billing modes: managed and self-serve

What this feature lets you do, from the perspective of the people using it.

An account can be billed in one of two ways, and dembrane staff can move it
between them. *Managed* means dembrane sends invoices and takes payment
out-of-band. *Self-serve* means the customer pays by card through a subscription
they manage themselves. There is one rule that ties it all together: while a
customer has a live card subscription, staff cannot change their tier or their
billing mode. The customer cancels the subscription first, so it is never left
quietly charging.

There are two people in this story: dembrane *staff*, who set how an account is
billed, and the *customer*, who sees the result on their own billing page.

## The two modes

- **Managed.** dembrane invoices the customer (a payment link or a sales
  invoice). There are no automatic card charges, no dunning, and the plan never
  auto-expires. Staff look after it. The customer keeps full access.
- **Self-serve.** The customer subscribes and pays by card. Charges, renewals,
  and cancellation are all in the customer's hands on their billing page.

An account can be self-serve without an active subscription right now, for
example a free account, one whose subscription was cancelled, or one staff just
moved off managed. It is still self-serve: the customer can subscribe whenever
they choose.

## The one rule: cancel a live subscription first

If an account has a live card subscription, staff cannot change its tier or
switch its billing mode. Both are blocked with a clear message. This is
deliberate: flipping the account while the subscription is still active would
leave it charging the card in the background. Ask the customer to cancel it from
their own billing page, then the change goes through.

## If you are dembrane staff

You manage billing mode from the admin dashboard, on an account's actions (or an
external workspace's actions), in the **Billing mode** section. A badge shows the
current mode: *Managed* or *Self-serve*.

### Set an account to managed

Use *Set to managed billing*. The account moves to invoice billing at its
current tier, with no automatic card charges and no auto-expiry. If the account
has a live card subscription, this is disabled with a reason: the customer
cancels first.

### Move an account to self-serve

Use *Switch to self-serve billing*. You choose what happens to the plan:

- **Downgrade to Free now.** The account drops to the free tier. The customer can
  subscribe to a paid plan whenever they want.
- **Keep the tier until a date.** The account keeps its current tier until the
  date you pick, then reverts to Free unless the customer subscribes before then.
  The customer is reminded before the date.

Pick one. Keeping a paid tier always needs an end date, so a paid account never
sits on self-serve with no path to payment.

### Change an account's tier

Change tier from the same actions. It is blocked while a live card subscription
exists (ask the customer to cancel first); otherwise it applies right away.

## If you are a customer

You see your billing on your own billing page, and it reflects your real state.

- **Managed by dembrane.** You see a managed-billing panel with your dembrane
  contact. You pay by invoice, not by card, and there are no self-serve controls
  to worry about.
- **Subscribed (self-serve).** You see your plan as *Active*, your next invoice,
  and controls to change your plan, update your card, or cancel.
- **Not subscribed, but on a paid tier.** This happens after staff move you to
  self-serve, or after you cancel. You see that there is no active subscription,
  and a *Subscribe* button to set one up. If staff kept your tier until a date,
  you also see when it ends. Subscribe before then to keep it.
- **Free.** You see a plan picker to choose a paid plan whenever you are ready.

You are never shown as "active" when nothing is actually set up to bill you.

## At a glance

| | Managed | Self-serve |
|---|---|---|
| Who pays how | dembrane invoices; no card | Customer subscribes and pays by card |
| Auto-charge / expiry | Off; staff manage it | On, once subscribed |
| Customer billing page | Managed panel + contact | Plan, or Subscribe prompt, or plan picker |
| Set by staff with | *Set to managed billing* | *Switch to self-serve billing* (Free now, or keep tier until a date) |
| Change tier | Anytime | Blocked while a live subscription exists (cancel first) |
