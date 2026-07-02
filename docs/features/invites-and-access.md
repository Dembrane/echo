---
title: Invites & access
description: How people join a workspace or organisation in dembrane - invites by email or link, accepting, pending invites, access requests, and how seats are counted.
audience: all
---

# Invites & access

To add someone, open the invite modal, pick their [role](./roles-and-permissions.md), and
either enter their email or generate a link. dembrane works out the rest - whether they
already have an account, whether they're already a member, and whether they need an email.

You need *member management* rights to do this: workspace *owner* or *admin* to invite into a
workspace, org *owner* or *admin* to invite into an organisation. Plain members and the
lighter roles can't invite.

## Add someone

1. Open the invite modal in the workspace (or organisation) you want them in.
2. Pick a [role](./roles-and-permissions.md). Which roles you can offer depends on where you
   are:
   - *Workspace* - admin, member, billing, external, or observer.
   - *Organisation* - member, admin, billing, or owner. There's no external at the org level -
     external only exists inside a workspace.
3. Invite *by email* (dembrane sends a secure link that expires after 7 days) or *by link*
   (you generate it and share it however you like - handy when you don't have someone's exact
   email, or you're inviting a group). Either way, the role you chose is baked in.

## What happens next

You don't manage these outcomes - dembrane picks the right one and you'll see it in the member
list:

- *Already a member* - nothing to do, they're in.
- *Reactivated* - they were a member before and are restored.
- *Added* - they already have a dembrane account, so they're in straight away.
- *Invited* - they're new, so a pending invite is created and the link is emailed (valid 7
  days).

When the recipient opens their link they land on the accept page. If they're logged out, they
sign in or register first and the invite then applies. If they're signed in as a different
account than the invite was for, dembrane tells them so they can switch.

> [!TIP]
> People don't need an account before you invite them. If they're new, accepting walks them
> through registration, then drops them into the workspace with the role you chose.

## You can't grant above your own role

The workspace hierarchy is *observer < external < member < billing < admin < owner*. You can
never grant a role higher than your own - an admin can invite admins, members, billing,
externals, and observers, but not an owner. Only an owner can grant owner. This stops anyone
escalating access beyond what they hold. (Full hierarchy in
[roles & permissions](./roles-and-permissions.md#workspace-roles).)

## Pending invites and access requests

Two lists keep things tidy:

- *Pending invites* - people you've invited who haven't accepted. Re-send or cancel as needed;
  email invites expire after 7 days.
- *Access requests* - people asking to join on their own, rather than being invited. Anyone
  who can *discover* a workspace - an org admin browsing
  [discoverable workspaces](./visibility-and-discovery.md), or a member who found an open one -
  can request access, and a workspace admin approves or denies it.

For organisations, admins get a single matrix bringing members, workspaces, access requests,
and pending invites together - see
[organisations & workspaces](./organisations-and-workspaces.md).

## How invites affect seats

Inviting touches [seats](./tiers-and-billing.md#seats), but gently:

- *Never blocked.* You can always send an invite - dembrane counts the seat and bills it
  rather than walling you off because you're "out of seats."
- *Pending invites count.* A billable seat is reserved the moment you invite someone, not just
  when they accept.
- *Observer invites are free.* Because [observer](./roles-and-permissions.md#the-free-read-only-observer)
  is free, inviting one doesn't add to your seat count.

So invite freely and watch the count. If someone only needs to *see* results, an observer
costs nothing.

> [!NOTE]
> When a [partner](./partner-program.md) creates an external-client workspace, dembrane
> auto-invites the named data owner as a free observer - they can always watch their own data
> being handled, at no cost. See [data ownership & compliance](./data-ownership-and-compliance.md).

## Related

- [Roles & permissions](./roles-and-permissions.md) - the roles you grant, and the hierarchy that limits you.
- [Visibility & discovery](./visibility-and-discovery.md) - what lets people find and request a workspace in the first place.
- [Tiers & billing](./tiers-and-billing.md) - how seats are counted as you add people.
- [Organisations & workspaces](./organisations-and-workspaces.md) - the org vs workspace distinction that decides which roles are available.
