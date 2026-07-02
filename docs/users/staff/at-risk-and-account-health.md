---
title: Account health & at-risk
description: The staff at-risk list - pilot hard-blocks, at-cap and approaching-cap accounts, recent downgrades - sorted by severity, and the outreach you'd do for each.
audience: staff
---

# Account health & at-risk

The at-risk list is the billing rollup pre-triaged: just the accounts that need a human right
now - hit a wall, about to, or just lost capacity - sorted with the most urgent on top. It's
the staff "needs attention" inbox.

Any [staff](./index.md#getting-in) account can read it. The remedies you reach from it -
[resetting usage](./discounts-trials-and-tiers.md#resetting-usage), a
[discount](./discounts-trials-and-tiers.md#discounts), a
[tier change](./discounts-trials-and-tiers.md#changing-a-tier) - carry their own gating.

## The categories

Accounts land on the list for one of four reasons, in descending urgency.

### Pilot hard-block

The most urgent. A *pilot* account that has hit a hard block and is now *stopped*, not merely
warned - recording or other gated activity is blocked. These are live problems: someone is
trying to use dembrane and can't.

> [!IMPORTANT]
> Pilot hard-blocks are the only category where the customer is actively blocked rather than
> nudged. Treat them as time-sensitive.

### At-cap

The account has reached its limit - most commonly the one-hour recording cap on
[Free](../../features/tiers-and-billing.md#free), the only tier with an hour cap. Often the
right move is an upgrade conversation, or a temporary
[usage reset](./discounts-trials-and-tiers.md#resetting-usage) or
[trial](./discounts-trials-and-tiers.md#granting-a-reverse-trial) to unblock them while it happens.

### Approaching-cap

Not at the limit yet, but close at the current rate. The *best* time to reach out - before
frustration, while the upgrade is a suggestion rather than a rescue.

### Recently-downgraded

An account that dropped a tier - a churn signal. Something changed: budget, a champion left,
the value wasn't landing. Worth a check-in, and sometimes a
[discount](./discounts-trials-and-tiers.md#discounts) to keep them.

> [!TIP]
> Severity ordering means you can work the list top-down: clear pilot hard-blocks first, then
> at-cap, approaching-cap, downgrades. You rarely need to read past where your time runs out.

## The admin-logins proxy

The list also shows *admin logins* - how recently and often an account's admin has logged in,
a cheap signal of whether anyone's actually using dembrane. Read it alongside the category:

- *Approaching-cap + frequent logins* → an engaged account growing into a paid tier. A warm
  upgrade conversation.
- *At-cap + no recent logins* → they hit the wall and walked away. Re-engagement, not upsell.
- *Recently-downgraded + healthy logins* → they're staying, just spending less. Worth
  understanding what changed.

## The outreach

For each row:

1. *Read the category and login proxy* to understand the kind of problem.
2. *Grab the [admin contact](./usage-and-billing-rollup.md#admin-contacts)* to write to. If
   unreachable, that's a [change-admin](./discounts-trials-and-tiers.md#changing-the-admin) case.
3. *Pick the remedy* from the row's
   [kebab](./admin-panel-overview.md#the-kebab-action-model):
   - Blocked or at-cap and you want to unblock now →
     [reset usage](./discounts-trials-and-tiers.md#resetting-usage) (with a reason) or a
     [reverse trial](./discounts-trials-and-tiers.md#granting-a-reverse-trial).
   - Genuine upgrade → help them, or
     [change the tier](./discounts-trials-and-tiers.md#changing-a-tier) once they agree.
   - Price is the blocker → a [discount](./discounts-trials-and-tiers.md#discounts) to keep a
     good account.
4. *Note the reason* where the action asks for one - it's the audit trail.

> [!WARNING]
> Resetting usage or granting a trial unblocks the customer immediately and is visible to
> them. Don't reset silently to make a number look better - use the reason field and pair it
> with a real conversation, or you'll be back here next month.

## Related

- [Usage & billing rollup](./usage-and-billing-rollup.md) - the full list this view triages
  from, and where admin contacts come from.
- [Discounts, trials & tiers](./discounts-trials-and-tiers.md) - every remedy: reset usage,
  trials, discounts, tier changes.
- [The admin panel](./admin-panel-overview.md) - the kebab-action model behind the remedies.
- [Tiers & billing](../../features/tiers-and-billing.md) - the Free hour cap that puts
  accounts at-cap.
