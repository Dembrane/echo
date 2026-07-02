---
title: External-client workspaces
description: Creating a workspace that belongs to a client - the data-owner step, separate billing, the free observer, and whitelabel.
audience: host-partner
---

# External-client workspaces

An *external-client workspace* is one you run on behalf of someone outside your organisation.
Where an ordinary internal workspace shares your org's pooled billing and branding, an
external-client workspace:

- *names a data owner* (the client),
- *bills on its own*,
- *auto-invites the data owner as a free [observer](./observer-and-external-collaborators.md)*, and
- can be *whitelabelled* with the client's own logo.

Create one whenever the data really belongs to the client - a municipality's citizen panels,
a client you'll bill separately, work you expect to
[hand over](./data-ownership-and-handoff.md) once it's done. For work that's for your own
organisation, create an ordinary internal workspace instead. You'll need to be a workspace
*owner* or *admin* inside a [partner](./becoming-a-partner.md) org.

## Creating one - the data-owner step

When you create a workspace as a partner, mark it as belonging to an external client. That
asks for three things:

1. *Client / data-owner organisation name* - who the data belongs to.
2. *Data-owner email* - the person at the client who owns the data. This is the address that
   gets auto-invited as a free observer, and the one dembrane uses to recognise the data owner
   in workspace lists.
3. *Partner-agreement checkbox* - you confirm the
   [partner agreement](./becoming-a-partner.md#the-partner-agreement) for this engagement, and
   dembrane records the moment you tick it.

On submit, dembrane marks the workspace as external-client, gives it its own billing account,
and auto-invites the data owner as a free observer.

> [!TIP]
> Get the data-owner email right. It decides who's invited as the observer *and* lets dembrane
> show that person a "you are the data owner" marker in their workspace list - a small,
> privacy-respecting touch that reassures the client the data is theirs.

## Separate billing

An external-client workspace gets its *own* billing account rather than drawing on your org's
pool. That's the point: each client's usage and spend stays cleanly apart from yours and from
every other client, and it makes a clean [handoff](./data-ownership-and-handoff.md) possible
later. For what's metered and how seats count, see
[tiers & billing](../../features/tiers-and-billing.md).

> [!NOTE]
> The free observer doesn't take a seat, so auto-inviting the data owner costs nothing. Paid
> roles - including [external](./observer-and-external-collaborators.md) collaborators - do
> count towards the workspace's own bill.

## The auto-invited free observer

Every external-client workspace starts with the data owner already invited as a free,
read-only observer. They can open projects, read conversations and view reports - and nothing
more (no chat, generate, edit or invite). The client can *see* their own data being handled
from day one, without you having to remember to add them and without it costing a seat. When
they need to do more, an admin upgrades them from observer to
[external](./observer-and-external-collaborators.md#upgrading-an-observer-to-external).

The observer role only exists here - internal workspaces reject observer invites. Full details
in [observer & external collaborators](./observer-and-external-collaborators.md).

## Whitelabel

External-client workspaces can be *whitelabelled* - given the client's own logo in place of
the inherited branding. This is external-only; internal workspaces inherit your org's branding.
It makes the workspace feel like the client's own, which matters when participants record into
it and when the client eventually takes it over.

> [!NOTE]
> Whitelabel arrives with a *Changemaker* workspace or above. See
> [tiers & billing](../../features/tiers-and-billing.md) for what each plan unlocks.

## Related

- [Data ownership & compliance](../../features/data-ownership-and-compliance.md) - internal
  versus external workspaces and who owns the data.
- [Data ownership & handoff](./data-ownership-and-handoff.md) - naming a data owner and handing
  the workspace over.
- [Observer & external collaborators](./observer-and-external-collaborators.md) - the free and
  paid client roles.
- [Becoming a partner](./becoming-a-partner.md) - you need partner status to create these.
- [Tiers & billing](../../features/tiers-and-billing.md) - seats, metering, whitelabel gating.
