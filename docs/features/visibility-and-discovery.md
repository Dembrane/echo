---
title: Visibility & discovery
description: Who in your organisation can find and join a workspace, what organisation admins can reach in each access setting, how access requests work, and how private projects work.
audience: all
---

# Visibility & discovery

Each workspace has an "Access" setting with three options. It decides who in your
organisation can find the workspace, and who can get in without an invite. New workspaces
start on "Everyone in your organisation".

| | "Everyone in your organisation" | "Invite only" | "Private" |
|---|---|---|---|
| Organisation members can find it and request access | ✓ | ✗ | ✗ |
| Organisation admins have admin access without joining | ✓ | ✗ | ✗ |
| Organisation admins can join as admin | ✓ | ✓ | ✗ |
| The organisation owner has admin access without joining | ✓ | ✓ | ✓ |

In words:

- "Everyone in your organisation". Members can find the workspace and ask to join.
  Organisation admins can open it as an admin straight away.
- "Invite only". Members do not see it. Organisation admins have no access until they join,
  and they can join by themselves.
- "Private". Organisation admins cannot join. If they try, they read "This workspace is
  private. Ask a workspace admin to invite you." Only the organisation owner can still get
  in.

The setting does not change what a member of the workspace can do. That is their
[role](./roles-and-permissions.md).

## Change the setting

Open workspace settings, "General", "Access", pick an option and choose "Save access". You
need to be a workspace admin.

- Leaving "Everyone in your organisation" needs the Innovator plan or above. So does
  creating a workspace as "Invite only" or "Private".
- Switching between "Invite only" and "Private", or going back to "Everyone in your
  organisation", needs no plan.
- An option your plan does not include stays visible. Choosing it shows "Private workspaces
  come with a paid plan." See [tiers & billing](./tiers-and-billing.md).
- A workspace for an external organisation starts on its own free plan, so only "Everyone
  in your organisation" is available when you create it.

## Find and join a workspace

The organisation's "Overview" page lists the workspaces you have not joined.

- Organisation admins see all of them, private ones included. They tick the ones they want
  and choose "Join as admin". No approval is needed. Joining a private workspace is refused
  unless you are the organisation owner.
- Organisation members and people with the organisation Billing role see only workspaces
  set to "Everyone in your organisation". They choose "Request access", which then reads
  "Request sent".
- Externals and observers see nothing here and cannot ask to join.

A request notifies the workspace's admins and the organisation's admins. They answer under
"Access requests" on the workspace's "Members" page.

- Approving adds the person as a Member. Someone who holds the organisation Billing role is
  added as Billing. They get a notification.
- Declining is silent: "Decline this access request? The requester won't be notified and
  would need to request access again."

Someone an admin removed from a workspace cannot join it again this way, the organisation
owner included. They need a new [invite](./invites-and-access.md).

## Private projects

Inside a workspace, a project is visible to every member or it is private. A private
project is visible to the workspace's admins and to the people it is shared with. You set
this on the project's "Access" tab.

- "Make private" needs a workspace admin and the Innovator plan or above. Everyone on the
  workspace is told: "{name} is now private".
- "Share with someone" adds people by email. A share only opens the project. What the
  person can do in it is still their workspace role, and a share never reaches into
  another workspace.
- For someone who is not on the workspace yet, choose "Send invite". They get a normal
  workspace invite and the project opens for them when they join: "Invite sent. The project
  is shared once they join." One open invite can carry one project.
- You cannot share with someone whose role is Billing: "Billing members can't open
  projects. Give them another role first."
- Removing a share tells the person: "Your access to {project} was revoked".
- "Share with whole workspace" makes the project visible to everyone again. That needs no
  plan.

## Related

- [Roles & permissions](./roles-and-permissions.md): what people can do once they are in.
- [Invites & access](./invites-and-access.md): adding people yourself.
- [Organisations & workspaces](./organisations-and-workspaces.md): creating a workspace and its settings.
- [Tiers & billing](./tiers-and-billing.md): which plan each option needs.
- [Projects](./projects.md): the rest of a project's settings.
