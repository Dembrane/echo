---
title: Roles & permissions
description: Which role to give someone in dembrane, and exactly what each workspace role and organisation role can do.
audience: all
---

# Roles & permissions

A role decides what someone can do. You pick one each time you invite a person, and it
applies in the workspace or organisation you invite them to.

## Which role do I pick?

| You want them to | Give them | What the invite screen says |
|---|---|---|
| Run projects and work with the results | "Member" | "Standard access. Collaborates in the workspaces they're added to." |
| Also manage people and settings | "Admin" | "Manages members, workspaces, and organisation settings." |
| See usage and invoices, and no content | "Billing" | "Sees usage and invoices. No project or content access." |
| Work with you from outside your organisation | "External" | "Workspace-only guest. Not added to the organisation." |
| Only look, for free, as your client | "Observer" | "Free, read-only. Sees projects, conversations, and reports. Cannot chat or generate reports." |

Every role except Observer takes a [seat](./tiers-and-billing.md#seats).

There is one more role, and you cannot pick it: owner. The person who creates an
organisation or a workspace is its owner. The dashboard shows an owner as "Admin". In a
workspace's "Members" list the owner's role is locked, with the note "Ownership is locked.
Contact support to transfer."

## What each workspace role can do

| Action | owner | admin | member | billing | external | observer |
|---|---|---|---|---|---|---|
| View projects | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Create projects | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Edit project settings | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| Change a project's legal basis | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Delete projects | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Make a project private or visible again | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Share a private project | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Move projects | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Read conversations | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Edit, tag or move conversations | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| Delete conversations | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Use chat | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| View reports | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| Generate reports | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ |
| Publish reports | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| Delete reports | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Invite people | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Change roles, remove people, see member emails and pending invites, act on access requests | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Workspace settings, delete the workspace, support access | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| View usage | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ |
| View invoices, update payment | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ |
| Webhooks | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| Custom workspace logo | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |

Good to know when you read the table:

- A role is not enough for every row. Private projects and sharing them need the Innovator
  plan or above. The logo and webhooks (the project's "Automation" page, Beta) need
  Changemaker. See [tiers & billing](./tiers-and-billing.md).
- Billing gets no project at all, not even a private project that someone tries to share
  with them.
- Someone who opens a workspace or project they have no access to gets "not found", the
  same answer as for one that does not exist.
- To change a role, use the role picker in the "Members" list. It offers "Member",
  "Billing" and "Admin".

## External and observer

These two roles are for people who are not in your organisation: a client, a consultant, a
partner's contact.

- External is a full collaborator from outside. They read, edit, chat and generate reports.
  They cannot create or delete projects, publish reports or invite anyone. An external
  takes a seat. On the organisation's "Members" page they carry an "External" badge: "No
  organisation role. Access via workspace invites."
- Observer is free and read-only: projects, conversations and reports. You can invite an
  observer only to a workspace made [for an external client](./partner-program.md).
  Anywhere else the invite is refused: "Observers can only join workspaces for an external
  client. Pick another role."
- Neither role has settings screens.

A person is inside your organisation or outside it, never both. If you invite a colleague
as external or observer, dembrane refuses: "This person is already a member of your
organisation, so they cannot join as an outside collaborator."

You also cannot move someone across that line with the role picker ("You cannot switch
between an outside collaborator and a member here. Invite them again with the new role.").
An observer's role is locked in the same way: "Observers are free, read-only guests. To
give edit access, remove them and re-invite as a member." In both cases, remove the person
and invite them again with the new role.

## Organisation roles

An organisation has four roles. Most people only need a workspace role.

| Action | owner | admin | billing | member |
|---|---|---|---|---|
| Open the organisation, see its member list | ✓ | ✓ | ✓ | ✓ |
| See other members' email addresses | ✓ | ✓ | ✗ | ✗ |
| See usage for every workspace of the organisation | ✓ | ✓ | ✓ | only the workspaces they can reach |
| Open the "Usage" and "Billing" sections | ✓ | ✓ | ✓ | ✗ |
| Rename the organisation, edit its description | ✓ | ✓ | ✗ | ✗ |
| Invite people to the organisation | ✓ | ✓ | ✗ | ✗ |
| See, resend and revoke pending invites of the whole organisation | ✓ | ✓ | ✗ | ✗ |
| Change organisation roles, remove people | ✓ | ✓ (not for owners) | ✗ | ✗ |
| Create a workspace | ✓ | ✓ | ✗ | ✗ |
| Join a workspace without being invited | every workspace | open and invite-only | ✗ | ✗ |
| Approve or decline requests to join a workspace | ✓ | ✓ | ✗ | ✗ |
| Request access to an open workspace | joins directly | joins directly | ✓ | ✓ |
| Open "MCP access" in organisation settings | ✓ | ✓ | ✗ | ✗ |
| Offers, billing details, tasks and invoices | ✓ | ✓ | ✓ | ✗ |

- The role picker on a person's card offers "Member" and "Admin". You give "Billing"
  through the invite screen.
- An organisation role is not a workspace role. What an organisation admin can reach
  without an invite depends on each workspace's access setting. See
  [visibility & discovery](./visibility-and-discovery.md).
- The organisation Billing role never opens a workspace or its projects.
- There is no external or observer role for an organisation. Those two exist only in a
  workspace.

## Rules that protect you

- Nobody can give a role above their own. An admin cannot make someone an owner. For this
  rule the order is observer, external, member, billing, admin, owner. The order says
  nothing about what a role can do: Billing sits above Member and can do far less.
- Only an owner can change or remove an owner.
- The last admin stays. A workspace's last admin cannot be removed, demoted or leave, and
  an organisation's last admin cannot be demoted: "This is the last admin. Make someone
  else an admin or owner first."
- Someone who is an external on any workspace of your organisation cannot become its
  organisation admin.
- dembrane staff hold none of these roles. They reach a workspace only when you allow it.
  See [staff support access](./staff-support-access.md).

## Related

- [Invites & access](./invites-and-access.md): how you add people and what they see.
- [Visibility & discovery](./visibility-and-discovery.md): who can find and join a workspace.
- [Organisations & workspaces](./organisations-and-workspaces.md): the two levels roles live in.
- [Tiers & billing](./tiers-and-billing.md): seats and what each plan includes.
- [The partner program](./partner-program.md): workspaces for an external client.
