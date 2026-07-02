---
title: Partner administration
description: The staff side of the partner program - the partner toggle, the referral ledger, the external-led-orgs conversion signal, and helping with workspace handoff.
audience: staff
---

# Partner administration

The [partner program](../../features/partner-program.md) lets an agency run dembrane on behalf
of external clients. It's self-serve for the partner *once* their organisation is marked as a
partner - but that mark, and a few commercial and operational levers around it, only staff can
pull: the *partner toggle*, the *referral ledger*, the *external-led-orgs* signal, and
*workspace handoff*.

It's [staff](./index.md#getting-in) work; handoff additionally needs extra staff permission.
Partners can't toggle any of this themselves - that's the point of staff-gating it.

## The partner toggle

Every organisation has a partner flag, off by default. Turning it on is the single gate
that opens the partner program for that organisation.

On, it lets that organisation's workspace admins create
[external-client workspaces](../../features/partner-program.md#external-client-workspaces) -
which carry their own billing account, name a data owner, allow
[free observers](../../features/roles-and-permissions.md), and support white labelling.
Internal work is unchanged; the toggle only *adds* the partner capability.

> [!IMPORTANT]
> Only flip the partner flag on once a partner agreement is in place. It changes how the
> organisation can bill and hand off other people's data. Confirm with whoever owns the
> partner relationship first.

The customer-facing view of what this unlocks is on the
[partner program](../../features/partner-program.md) page; route partner hosts there when they
ask "what can I now do?".

## The referral ledger

Partners bring clients, often with agreed commercial terms. The *referral ledger* is where
those terms live. Each entry records:

- *Kickback %* - what the partner earns on a referred client.
- *Discount %* - any discount the referred client gets.
- *EUR cap* - a ceiling in euros on the arrangement.
- *Expiry* - when the deal lapses.

It's staff-maintained; partners don't edit it. Read it to reconcile what a partner is owed,
check a referred client's discount, and see when an arrangement ends.

> [!NOTE]
> The ledger is the mechanism; the deals are agreed with the partner by whoever owns the
> commercial relationship. If a number looks wrong, check the agreement before editing.

## External-led orgs - the conversion signal

The *external-led orgs* list surfaces organisations that look like they're being led
from outside the partner - a partner's external client that has started behaving like an
independent account.

When a client a partner brought in starts driving their own usage, inviting their own people,
and acting like an owner rather than an observer, they're a candidate to convert to their own
direct dembrane account. Read the list as a pipeline of clients ready to graduate from
partner-hosted to independent.

> [!TIP]
> Pair it with the [referral ledger](#the-referral-ledger): a client showing up as
> external-led, with a referral arrangement near its [cap or expiry](#the-referral-ledger), is
> a clear prompt for a "ready to take this over yourself?" conversation - and to settle the
> partner's kickback.

## Workspace transfer and handoff

When an engagement ends, a partner often hands the workspace to the client so the client owns
it as an independent organisation, billed directly. That transfer is *handoff*, which needs
extra staff permission - so staff usually perform or assist it.

Handoff changes who owns and pays for a workspace, so:

- Confirm timing with *both* the partner and the client before transferring.
- Make sure the client side is ready - they become the owners, billed directly.
- After handoff, the partner organisation no longer administers the workspace.

The same machinery covers project moves and bulk moves between workspaces; the customer-facing
detail is on the
[partner program](../../features/partner-program.md#moving-and-handing-off-work) page.

> [!WARNING]
> Handoff is not easily undone - once a workspace is transferred, the partner loses
> administrative access. Treat it as a one-way door and line everything up first.

## Related

- [The partner program](../../features/partner-program.md) - the full customer-facing picture
  of what the toggle unlocks.
- [Roles & permissions](../../features/roles-and-permissions.md) - the observer and external
  roles partners use.
- [Usage & billing rollup](./usage-and-billing-rollup.md) - where external-client billing
  accounts show up.
- [The admin panel](./admin-panel-overview.md) - the partner toggle as a kebab action.
- [Discounts, trials & tiers](./discounts-trials-and-tiers.md) - discounts you might apply
  alongside a referral deal.
