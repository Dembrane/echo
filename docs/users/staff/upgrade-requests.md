---
title: Upgrade requests
description: The staff queue for workspace upgrade requests - submit, list, approve, deny - its two kinds, how notifications batch into a daily digest, and the expiry crons.
audience: staff
---

# Upgrade requests

An *upgrade request* is how a customer who can't change their own plan asks dembrane to do
it. A [member](../../features/roles-and-permissions.md) without billing rights doesn't pay
the bill, so when they reach for a higher tier or a new workspace they submit a request - and
it lands in a staff queue where you approve or deny it.

Reading and actioning the queue is [staff](./index.md#getting-in) work. Approving a
request that changes a tier performs a
[tier change](./discounts-trials-and-tiers.md#changing-a-tier), so it needs extra staff permission. The customer side - who can submit, and why - is on
[tiers & billing](../../features/tiers-and-billing.md#requesting-an-upgrade).

## The lifecycle

1. *Submit* - a customer with `upgrade:request` raises it from the dashboard. Stored in the
   `workspace_request` collection with its kind, target workspace, and who asked.
2. *List* - it appears in the queue with the requester, workspace, kind, and when it came in.
3. *Approve* - for a tier upgrade, that bumps the workspace's tier; for a new workspace, it
   clears the way for it to exist on the requested footing.
4. *Deny* - decline it, with a note to the requester about why.

> [!TIP]
> Approving a request and changing a tier from the
> [kebab](./admin-panel-overview.md#the-kebab-action-model) reach the same end. Use the queue
> when the customer *asked* (it closes the loop for them); use a direct tier change when
> *you* initiate, e.g. after a renewal call.

## The two kinds

- `new_workspace` - the customer wants a workspace they can't create under their current plan.
  On [Free](../../features/tiers-and-billing.md#free), extra workspaces are gated, so this is
  the route to one.
- `tier_upgrade` - the customer wants their existing workspace moved up (most commonly Free →
  Changemaker, the [self-serve tier](../../features/tiers-and-billing.md#changemaker--75--seat--month)).

Read the kind first: it tells you whether you're approving a new thing or changing an existing
one, and which workspace is affected.

## Notifications and the daily digest

Requests generate [notifications](../../features/notifications.md), and the emails are batched:

- *The first five in a 24-hour window* are emailed individually, so a low-volume queue reaches
  you in real time.
- *After that*, further requests roll into a *daily digest* at *09:00 UTC*, so a busy day
  doesn't flood your inbox.

> [!NOTE]
> That's why you might get a handful of individual emails early and a single digest later.
> The in-app [notifications](../../features/notifications.md) always show the full queue
> regardless of how the emails batched.

## The expiry and prewarning crons

Two scheduled jobs run alongside the queue so time-limited grants don't overstay:

- *Tier-expiry cron* - when a time-limited tier (usually a
  [reverse trial](./discounts-trials-and-tiers.md#granting-a-reverse-trial)) reaches its end
  date, it reverts the workspace. No manual downgrade needed.
- *3-day prewarning cron* - three days before an expiry, a warning goes out so the customer
  (and you) get a heads-up before capacity changes.

So a trial granted today reverts on its own in a month, with a warning three days out - see
[granting a reverse trial](./discounts-trials-and-tiers.md#granting-a-reverse-trial).

> [!IMPORTANT]
> Because expiries auto-revert, don't rely on a trial as a permanent discount. If an account
> genuinely shouldn't pay full price, set a proper
> [discount](./discounts-trials-and-tiers.md#discounts) instead - it doesn't expire out from
> under them.

## Related

- [Notifications](../../features/notifications.md) - how requests notify you and how the
  digest batching works.
- [Discounts, trials & tiers](./discounts-trials-and-tiers.md) - what approving actually does,
  plus trials and the expiry crons.
- [Tiers & billing](../../features/tiers-and-billing.md#requesting-an-upgrade) - the customer
  side: who can request and why.
- [The admin panel](./admin-panel-overview.md) - where the queue lives and the kebab actions
  beside it.
