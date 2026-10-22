---
title: The partner program
description: How an organisation runs dembrane for a client. A workspace for an external organisation, its data owner, free observers, separate billing, and what you can and cannot move.
audience: host-partner
---

# The partner program

If you run sessions for someone else (a municipality, a client, a community), make a
workspace "For an external organisation". It names the client as the owner of the data, is
billed on its own, and lets the client look along for free.

Any organisation admin can do this. You do not need a special status. dembrane can label an
organisation as a partner for its own administration, and that label unlocks nothing: every
organisation admin sees the same options.

## External-client workspaces

1. As an organisation admin, create a workspace.
2. On the "Ownership" step, choose "For an external organisation".
3. Fill in "Owning organisation" and "Data owner email". The data owner cannot be someone
   who is already a member of your organisation.
4. Finish the "Access" and "Review" steps.

dembrane then:

- gives the workspace its own billing account, on the free plan, whatever plan your
  organisation has
- stores the owning organisation and the data owner with the workspace
- invites the data owner by email as a free observer ("You're the data owner for
  {workspace_name} on dembrane"). That invite is valid for 30 days

## What is different from your own workspaces

| | "For internal use" | "For an external organisation" |
|---|---|---|
| Billing | Your organisation's plan and seats | Its own account, plan and seats. The badge reads "{Tier} (partner)": "Billed separately, not part of the organisation's plan." |
| Plan at the start | Your organisation's plan | Free. The free plan's limits apply until this workspace has a paid plan of its own. While your organisation is on Free too, the workspace shares your organisation's free allowance |
| Access setting at the start | Any your plan includes | "Everyone in your organisation" only |
| Observers | Cannot be invited | Can be invited, for free |
| Data owner | None | The client you named |
| One-workspace limit of the free plan | Counts | Does not count |

A colleague who is in a client workspace and in your own workspaces holds a seat on both
accounts. The invite screen warns you: "These workspaces are billed separately. Each person
you add takes a seat in {billingContextCount} billing contexts, each invoiced on its own."

A custom logo is not tied to client workspaces. Any workspace on the Changemaker plan or
above can set one, so a client workspace needs that plan on its own account.

## Your client's people

- Observer is free and read-only: projects, conversations and reports. Observers exist
  only in workspaces for an external client. The data owner is invited as one.
- External takes a seat. An external can read, edit, chat and generate reports.
- To give an observer more, remove them and invite them again with the new role. An
  observer's role cannot be changed in place.

The full table is in [roles & permissions](./roles-and-permissions.md).

## Change who owns a workspace's data

Workspace settings have "Data ownership": "Is this workspace for your organisation's
internal use, or for an external organisation that owns its data?" Only an admin of the
workspace's organisation can change it.

- Switching to external: "This moves the workspace into its own billing and data context.
  Its projects will no longer move freely with the rest of your organisation."
- Switching back: "This returns the workspace to your organisation's shared billing and
  removes its external data owner."
- The switch is refused while the account involved is on a paid or subscribed plan.

The person named as data owner sees a badge in the workspace's sidebar that says they are
the data owner.

## Moving and handing off work

- You can move projects between your internal workspaces, or inside one client workspace's
  account. You cannot move a project between an internal workspace and a client workspace,
  or between two clients. You need to be an admin of both workspaces.
- The create screen says a client workspace "can be handed off to that organisation later
  with no data movement." The dashboard has no control for that handover. Ask dembrane
  before you promise one to a client.

## Related

- [Data ownership & compliance](./data-ownership-and-compliance.md): the data owner, legal basis and anonymisation.
- [Roles & permissions](./roles-and-permissions.md): what observers and externals can do.
- [Tiers & billing](./tiers-and-billing.md): seats, billing accounts and how to get a paid plan.
- [Partner guides](../users/host-partner/index.md): the same, from a partner host's side.
- [External-client workspaces](../users/host-partner/external-client-workspaces.md): the walkthrough.
- [Observer & external collaborators](../users/host-partner/observer-and-external-collaborators.md): working with a client's people.
- [Data ownership & handoff](../users/host-partner/data-ownership-and-handoff.md): the data owner in practice.
