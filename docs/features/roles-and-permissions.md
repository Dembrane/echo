---
title: Roles & permissions
description: Who can do what in dembrane, and which role to pick when you invite someone.
audience: all
---

# Roles & permissions

A role decides what someone can do. You pick one each time you invite a person. This page
helps you choose, and shows exactly what each role can and can't do.

## Inviting someone? Pick the role

| You want them to… | Give them |
|---|---|
| Run sessions and analyse the results - the everyday job | *member* |
| Do all that *and* manage people, settings and billing | *admin* |
| Have the final say over everything | *owner* |
| See spend and invoices, but not the conversations | *billing* |
| Collaborate from outside your organisation (edit, chat, build reports) | *external* |
| Only *view* results, nothing else, for free | *observer* |

Most teams need just two: *member* for people who run and analyse sessions, *admin* for
the one or two people who also look after the workspace.

> [!NOTE]
> *observer* is free. Every other role uses a [seat](./tiers-and-billing.md#seats), which
> counts towards your bill. Inviting is never blocked, though - you're billed for seats, not
> stopped from adding people.

## What each role can do

This is the full picture for a workspace. A tick means yes.

| Action | owner | admin | member | billing | external | observer |
|---|---|---|---|---|---|---|
| View projects | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| Create projects | ✓ | ✓ | ✓ | – | – | – |
| Edit projects | ✓ | ✓ | ✓ | – | ✓ | – |
| Delete projects | ✓ | ✓ | – | – | – | – |
| Read conversations | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| Delete conversations | ✓ | ✓ | ✓ | – | – | – |
| Ask (chat) | ✓ | ✓ | ✓ | – | ✓ | – |
| View reports | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| Build reports | ✓ | ✓ | ✓ | – | ✓ | – |
| Invite & manage people | ✓ | ✓ | – | – | – | – |
| Change settings | ✓ | ✓ | – | – | – | – |
| See usage & invoices | ✓ | ✓ | usage only | ✓ | – | – |

The shape to remember: *member* does the work, *admin* runs the place, *billing* sees only
money, *external* is a paid helper from outside, *observer* just watches.

## Two outside-the-team roles

*external* and *observer* are for people who aren't part of your organisation - a client, a
consultant, a partner's contact.

- *external* is a paid collaborator. They can edit projects, ask questions of the data, and
  build reports - but they can't create or delete projects, or invite anyone.
- *observer* is free and read-only. They can open projects, read conversations, and view
  reports. Nothing else. It's the role for a client who should be able to *see* the work
  without touching it. Observers only exist in [external-client workspaces](./partner-program.md)
  (the ones a partner runs for someone else), and the data owner is added as one automatically.

To turn an observer into a paid *external* collaborator, an admin just changes their role.
Turning an outside collaborator into a full team *member* is a bigger step (it brings them
into your organisation), so it's done deliberately: remove them, add them to the
organisation, then re-invite as a member.

## Organisation vs workspace

dembrane has two levels, and roles exist at both:

- An *organisation* is your company's account. Organisation roles decide who can create new
  workspaces and who sees billing across all of them.
- A *workspace* is where projects live. Workspace roles (the table above) decide who can do
  what with the actual work.

Most people only ever need a workspace role. You can belong to a workspace without being in
the organisation at all - that's what *external* and *observer* are. See
[organisations & workspaces](./organisations-and-workspaces.md) for how the levels fit
together.

The organisation roles mirror the workspace ones: *owner* (full control), *admin* (manage
people, settings, billing, and create workspaces), *member* (belongs to the org, does their
work in workspaces), and *billing* (sees spend across every workspace, touches no content).

## Two rules worth knowing

- *You can't give someone a role above your own.* An admin can invite members and other
  admins, but not an owner. See [invites & access](./invites-and-access.md).
- *dembrane staff have separate powers* (changing your tier, moving a workspace) that aren't
  part of these roles. If you're staff, see the [staff guides](../users/staff/index.md).

## Related

- [Invites & access](./invites-and-access.md) - how you actually add people and set roles.
- [Tiers & billing](./tiers-and-billing.md) - what a seat costs and what each plan includes.
- [Organisations & workspaces](./organisations-and-workspaces.md) - the two levels roles live in.
- [The partner program](./partner-program.md) - where external and observer collaborators fit.
