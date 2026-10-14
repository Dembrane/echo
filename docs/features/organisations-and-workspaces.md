---
title: Organisations & workspaces
description: How dembrane is structured. An organisation holds people, workspaces and a plan. A workspace holds projects and has its own members.
audience: all
---

# Organisations & workspaces

An organisation is your company or institution in dembrane. It holds your people, your
workspaces and your plan. A workspace sits inside it, holds your
[projects](./projects.md), and has its own members.

| Your situation | Make |
|---|---|
| New work for the same group of people | a project in a workspace you have |
| Work that other people should see, and not everyone you work with now | a workspace, because it has its own members and access setting |
| Work for a client who owns the data | a workspace "For an external organisation" |

## Organisations

- You name your first organisation when you sign up without an invite. It starts on the
  free plan with one workspace called "Default", and you are its owner.
- To make another, open the account menu and choose "Create organisation".
- The organisation has three pages in the sidebar: "Overview", "Members" and "Settings".
  Settings has "General", "Usage", "Billing" and "MCP access". "Tasks" and "Documents" appear
  when your organisation has tasks or documents from dembrane. See
  [offers & invoices](./offers-and-invoices.md).
- "General" holds "Organisation name" and "Description". Only organisation admins can edit
  them. A field saves when you leave it.
- You cannot delete an organisation yourself. The "Danger" block in "General" says
  "Deleting an organisation is a support-assisted operation." and asks you to email
  support@dembrane.com. All workspaces must be empty and deleted first.

## Workspaces

Only organisation admins can create a workspace. Everyone else sees "You can't create a
workspace yet". Nobody at dembrane has to approve it.

The create screen has four steps:

1. "Name".
2. "Ownership". "For internal use" puts the workspace on your organisation's plan. "For an
   external organisation" asks for "Owning organisation" and "Data owner email", and gives
   the workspace its own billing. See [the partner program](./partner-program.md).
3. "Access". Who in your organisation can find and join it. See
   [visibility & discovery](./visibility-and-discovery.md).
4. "Review".

On the free plan an organisation has one workspace on its own plan: "Free plan allows 1
workspace per organisation". A workspace for an external organisation does not count
towards that.

Workspace settings have three sections, and "Members" is its own entry in the sidebar:

| Section | Who sees it | What is in it |
|---|---|---|
| "General" | workspace admins change it | "Name", "Description", "Assistant context", "Logo", "Access", the [support access](./staff-support-access.md) switch, data ownership, legal basis, assistant memory and methodologies |
| "Usage and billing" | everyone except externals and observers | usage of the month, and billing for those who may see it |
| "Danger zone" | workspace admins | "Delete this workspace" |

Other people who open "General" read: "Only workspace admins can change these settings. Ask
an admin if something needs updating."

A custom logo ("Custom workspace logo shown to participants.") needs the Changemaker plan
or above. Use a PNG, JPEG or WebP of at most 5 MB. The upload crops it to 3:1.

To delete a workspace, delete its projects first. Then type the workspace name to confirm
and choose "Delete workspace".

## Two kinds of membership

Being in an organisation and being in a workspace are separate things.

- You can be in an organisation and in none of its workspaces.
- You can be in a workspace and not in its organisation. That is what the
  [external and observer](./roles-and-permissions.md#external-and-observer) roles are.
- Accepting a workspace invite as Member, Billing or Admin also makes you a member of the
  organisation.

An organisation role alone gives this much access to a workspace:

| Organisation role | Access without being a member of the workspace |
|---|---|
| owner | admin access to every workspace |
| admin | admin access to workspaces set to "Everyone in your organisation" |
| member | none |
| billing | none |

One exception: a workspace that was set before version 3 to let every organisation member
in still does. The setting itself no longer exists.

If you are a member of the workspace, that role is the one that counts, even when your
organisation role would give you more. Access that comes only from an organisation role
takes no [seat](./tiers-and-billing.md#seats).

If an admin removes you from a workspace, your organisation role does not let you back in.
This holds for owners too. You come back through a new invite.

## Moving projects between workspaces

- You need to be an admin of both workspaces.
- Both workspaces must be billed the same way: both on your organisation's plan, or the
  same separately billed workspace. A project cannot move between an internal workspace and
  a workspace for an external organisation.
- You can move up to 500 projects in one go. If one of them is not allowed to move, none
  move.
- Each move is recorded on the project: from where, to where, by whom and when.
- No plan is needed.

## Related

- [Roles & permissions](./roles-and-permissions.md): who can do what at each level.
- [Invites & access](./invites-and-access.md): adding people to an organisation or a workspace.
- [Visibility & discovery](./visibility-and-discovery.md): who can find and join a workspace.
- [Tiers & billing](./tiers-and-billing.md): plans, seats and billing accounts.
- [Projects](./projects.md): what lives inside a workspace.
- [Managing your workspace](../users/host/managing-your-workspace.md): the same, as a host.
