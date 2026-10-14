---
title: External-client workspaces
description: How to create a workspace for a client who owns the data, and what that changes for billing, limits and access.
audience: host-partner
---

# External-client workspaces

Create one when the data belongs to a client. The workspace is billed on its own, it names the
client's data owner, and that person is invited as a free observer.

Only admins of your organisation can create a workspace. On the free plan, "Create workspace"
opens the upgrade form as soon as your organisation has one workspace ("Free plan allows 1
workspace per organisation"), so your organisation needs a paid plan first.

## Create one

1. Open your organisation's "Overview" and choose "Create workspace".
2. "Name": name the workspace.
3. "Ownership": pick "For an external organisation". The screen describes it as "A separate
   data-ownership and billing context."
4. "Owning organisation": the client organisation that owns the data.
5. "Data owner email": the person at the client who owns this data. They must be outside your
   organisation.
6. "Access": keep "Everyone in your organisation". The other two options need a paid plan on the
   workspace, and a new one starts free.
7. "Review": check that "Ownership" reads "Separate (client)", then choose "Create workspace".

If the data owner is one of your own people, the screen refuses: "This data owner is already in
your organisation. For an external client, name someone outside it, or create an internal
workspace instead."

## What happens next

- The data owner gets an email invite to join as an
  [observer](./observer-and-external-collaborators.md). They join when they accept it, signed in
  with that email address. This invite stays valid for 30 days.
- You become the workspace's admin.
- The workspace's plan badge ends in "(partner)", for example "Free (partner)", with the note
  "Billed separately, not part of the organisation's plan."

## Billing and limits

The workspace starts on its own free plan, whatever plan your organisation has. The free limits
count for this workspace alone. The ones you meet first:

- One hour of recorded audio in total. Participants are never stopped, but conversations finished
  after that hour are locked for you: their transcript and summary stay hidden until the
  workspace is on a paid plan.
- One chat with three questions, and one report.

To arrange a paid plan, open the workspace's settings and go to "Usage and billing". It reads
"This workspace is billed separately". Choose "Tell us what you need": a short form, then a call
with dembrane, then an offer. For prices, ask dembrane.

Seats are counted on this workspace's own account:

- A colleague you add takes a seat here, on top of their seat on your organisation's plan.
- An [external collaborator](./observer-and-external-collaborators.md) takes a seat. An observer
  does not.

Your organisation's "Billing" page lists the workspace under "Workspaces billed separately", with
a "Manage" button.

## Who can find it

A new client workspace is set to "Everyone in your organisation": "Anyone in your organisation can
find this workspace. Admins can join; members can request access." Your organisation's admins
can open it without joining.

To close it to colleagues, put the workspace on a paid plan first ("Private workspaces come with
a paid plan."). Then open workspace settings, "General", "Access", pick "Invite only" or
"Private", and choose "Save access".

## The client's logo

A logo is not special to client workspaces. Any workspace on Changemaker or above can set one in
workspace settings, "General", "Logo". Participants see it in the portal.

## Related

- [Observer & external collaborators](./observer-and-external-collaborators.md)
- [Data ownership & handoff](./data-ownership-and-handoff.md)
- [Organisations & workspaces](../../features/organisations-and-workspaces.md)
- [Tiers & billing](../../features/tiers-and-billing.md)
- [Visibility & discovery](../../features/visibility-and-discovery.md)
