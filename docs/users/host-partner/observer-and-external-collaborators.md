---
title: Observer & external collaborators
description: What the free, read-only observer and the paid external collaborator can each do, how to invite them, and how to change a role.
audience: host-partner
---

# Observer & external collaborators

Two roles bring someone from outside your organisation into a workspace. Pick "Observer" when the
client should read along at no cost. Pick "External" when they should work in the projects with
you.

| | Observer | External |
|---|---|---|
| Cost | Free, no seat | Takes a seat |
| Where | Only in a workspace for an external organisation | Any workspace |
| View projects, conversations and reports | Yes | Yes |
| Download transcripts | Yes | Yes |
| Edit project settings and the portal | No | Yes |
| Edit, tag or move conversations | No | Yes |
| Use chat | No | Yes |
| Generate reports | No | Yes |
| Publish or delete reports | No | No |
| Create or delete projects, delete conversations | No | No |
| Invite people, open workspace settings, see usage | No | No |

Neither role adds the person to your organisation. The data owner of an
[external-client workspace](./external-client-workspaces.md) is invited as an observer when the
workspace is created.

## Invite someone

You need to be an admin of the workspace.

1. Open the workspace's "Members" page and choose "Invite people".
2. Enter their email address.
3. Under "Role", pick "Observer" or "External".
4. Under "Add to workspaces", tick the workspace. Both roles exist only inside a workspace.
5. Send the invite.

Someone from outside your organisation is not added at once. The result reads "Sent" and they get
an email with a link. They join when they accept it, signed in with the invited email address.

The invite expires after 7 days. Under "Pending invites" you can use "Copy invite link", "Resend
invite email" or "Revoke invite". The link is personal and works only for that email address.

## When an invite is refused

| Message | What it means |
|---|---|
| "Observers can only join workspaces for an external client. Pick another role." | The workspace is for internal use. Observers exist only in a workspace for an external organisation. |
| "This person is already a member of your organisation, so they cannot join as an outside collaborator." | A person is inside your organisation or outside it, never both. |
| "Your plan is not active. Reactivate it to add members." | The plan that pays for the workspace is cancelled or past due. You can still invite observers. |

## Change a role

Neither role can be changed in place. Remove the person on the "Members" page, then invite them
again with the new role.

- An observer's role is locked in the list. There is no change from "Observer" to "External".
- Changing "External" to "Member", or back, is refused: "You cannot switch between an outside
  collaborator and a member here. Invite them again with the new role."

For a client who needs to do more than read, invite them again as "External". "Member",
"Billing" and "Admin" also add the person to your own organisation.

## Good to know

- Externals and observers have no settings screens, and they cannot find or request your other
  workspaces.
- Externals appear on your organisation's "Members" page with an "External" badge.
- Workspace admins get a notification when an external or an observer joins.
- Removing someone on the organisation's "Members" page ends their external and observer access
  in every workspace of the organisation.

## Related

- [External-client workspaces](./external-client-workspaces.md)
- [Data ownership & handoff](./data-ownership-and-handoff.md)
- [Roles & permissions](../../features/roles-and-permissions.md)
- [Invites & access](../../features/invites-and-access.md)
- [Tiers & billing](../../features/tiers-and-billing.md)
