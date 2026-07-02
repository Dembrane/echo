---
title: Discounts, trials & tiers
description: The staff levers on an account - apply a discount, grant a reverse trial, change a tier, change the admin, and reset usage with a reason.
audience: staff
---

# Discounts, trials & tiers

These are the direct levers on a customer's account: knock the price down with a *discount*,
hand them a month of paid capacity with a *reverse trial*, *change the tier* outright,
*change the admin* when the named one is unreachable, and *reset usage* to unblock someone.
They're the remedies behind most [at-risk](./at-risk-and-account-health.md) outreach and
renewal conversations.

All of it is [staff](./index.md#getting-in) work; changing a tier additionally needs extra
staff permission. Each action hangs off the
[kebab](./admin-panel-overview.md#the-kebab-action-model) on an account or workspace row.

## Discounts

A *discount* reduces what an account pays, as a percentage off - the canonical remedy for
"this account should pay less". Three kinds:

| Kind | When you'd use it |
|---|---|
| *scholarship* | A non-profit, community group, or cause you want to support at a reduced or zero price. |
| *staff_discount* | A dembrane-staff-adjacent account that gets a price break. |
| *trial* | A discount tied to a trial arrangement. |

100% is effectively free (this makes an account
[comped](./usage-and-billing-rollup.md#revenue-classes) in the rollup); 50% is half-price.

> [!NOTE]
> Set discounts at the *billing account* level - that's where billing attaches. There's also a
> per-workspace action for when a single workspace needs its own treatment. When in doubt,
> discount the account.

> [!TIP]
> Prefer a discount over a permanent trial. A [reverse trial](#granting-a-reverse-trial)
> *expires*. If an account genuinely shouldn't pay full price long term, a discount is the
> durable answer.

## Granting a reverse trial

A *reverse trial* drops a Free (or lower) account into *Changemaker for one month* - the full
paid experience (built-in analysis, unlimited hours) without paying.

The key word is *reverse*: it auto-reverts. A
[cron](./upgrade-requests.md#the-expiry-and-prewarning-crons) downgrades the account at the
end of the month, with a 3-day prewarning. You don't have to remember to take it away.

Use it when an [at-cap](./at-risk-and-account-health.md#at-cap) Free account needs unblocking
*and* you want to show paid value, or in a sales conversation to let a prospect feel
Changemaker before deciding.

> [!IMPORTANT]
> Because it reverts automatically, never use a reverse trial as a stand-in for a discount.
> It's a time-boxed taste. For anything lasting, use a [discount](#discounts).

## Changing a tier

To move a workspace up or down directly. Needs extra staff permission. You'd change a tier
when:

- A customer agreed to upgrade and you're completing it (or
  [approving their request](./upgrade-requests.md)).
- You're correcting a tier after a
  [managed invoice](./managed-and-offline-billing.md#issuing-an-invoice) is paid.
- You're downgrading a lapsed account.

The tiers themselves - Free, Innovator, Changemaker, Guardian, and what each unlocks - are on
[tiers & billing](../../features/tiers-and-billing.md#the-four-tiers).

> [!WARNING]
> A tier change is immediate and visible. Downgrading removes capabilities the customer may
> rely on (analysis, extra workspaces, white labelling). Make sure billing and the customer
> are aligned, especially downward.

## Changing the admin

When a workspace's named admin is unreachable - left the organisation, email bounces, nobody
else has access - reassign administration to a different person.

This is an unreachable-admin recovery tool, not a routine one. It exists so an account isn't
stranded because its only admin vanished.

> [!NOTE]
> Confirm the customer's request before reassigning - you're handing control of their
> workspace to a different person. Pair it with the
> [admin contact](./usage-and-billing-rollup.md#admin-contacts) so you know who the legitimate
> new owner should be.

## Resetting usage

*Reset usage* clears an account's consumed usage - most usefully the
[Free hour cap](../../features/tiers-and-billing.md#free) - so an
[at-cap](./at-risk-and-account-health.md#at-cap) customer can carry on. It *requires a reason*.

The reason is the audit trail for *why* this account got extra capacity - "founder demo",
"billing error", "goodwill while resolving an upgrade".

> [!WARNING]
> Don't reset usage to make a dashboard look healthier. It unblocks the customer immediately
> and erases the signal that put them on the [at-risk list](./at-risk-and-account-health.md).
> Fill in a truthful reason and pair the reset with a real upgrade conversation, or the same
> account is back at-cap next month.

## Choosing the right lever

| Situation | Reach for |
|---|---|
| Should pay less, long term | [Discount](#discounts) (scholarship / staff) |
| Show paid value, time-boxed | [Reverse trial](#granting-a-reverse-trial) |
| Agreed upgrade / correction | [Change tier](#changing-a-tier) |
| Named admin vanished | [Change admin](#changing-the-admin) |
| Unblock an at-cap account now | [Reset usage](#resetting-usage) (with reason) |

## Related

- [Account health & at-risk](./at-risk-and-account-health.md) - where you decide which lever an
  account needs.
- [Upgrade requests](./upgrade-requests.md) - approving a request, and the expiry/prewarning
  crons behind reverse trials.
- [Managed & offline billing](./managed-and-offline-billing.md) - set the tier an invoice bills for.
- [The admin panel](./admin-panel-overview.md) - the kebab-action model these hang off.
- [Tiers & billing](../../features/tiers-and-billing.md) - the tiers you change and what each
  includes.
