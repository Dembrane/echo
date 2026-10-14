---
title: Managing your workspace
description: How a workspace admin adds people, picks roles, tracks invites, sets who can find the workspace and gives the assistant standing context.
audience: host
---

# Managing your workspace

A workspace holds your projects and the people who work on them. As an "Admin" you decide who
is in, what they can do and who can find the workspace. You do it in two places in the
workspace sidebar: "Members" and "Settings".

If you do not see the controls on this page, you are not an admin of the workspace. In
"Settings", members see "Usage and billing" only. Guests ("External" and "Observer") have no
settings at all.

The person who creates a workspace is its owner. The dashboard shows an owner as "Admin", with
the note "Ownership is locked. Contact support to transfer."

## Pick a role

You choose a role each time you invite someone.

| You want them to… | Role | Seat |
|---|---|---|
| Run the workspace with you: people, settings, every project | "Admin" | Yes |
| Create projects and work in them: edit, chat, generate and publish reports | "Member" | Yes |
| See usage and invoices, with no access to projects | "Billing" | Yes |
| Work in your projects as a guest from outside your organisation: edit, chat, generate reports | "External" | Yes |
| Read projects, conversations and reports, and nothing more | "Observer" | Free |

- You cannot give a role above your own.
- An "External" cannot create projects, publish reports, or delete projects, conversations or
  reports.
- "Observer" exists only in a workspace made for an external client. See
  [observers and external collaborators](../host-partner/observer-and-external-collaborators.md).
- A person who is already a member of your organisation cannot join as "External" or
  "Observer".

The full list of what each role can do is in
[roles and permissions](../../features/roles-and-permissions.md).

## Invite people

1. Open "Members" and press "Invite people".
2. Type the email addresses and pick a "Role".
3. Under "Add to workspaces", tick the workspaces they should join. The same role applies to
   every workspace you tick.
4. Send. Each address gets a result: "Added", "Sent", "Already a member" or "Already invited".

What happens next depends on who you invited:

- Someone already in your organisation is added at once. They get a notification in the app
  and an email.
- Anyone else gets an invite and joins only when they accept it. This is true whether or not
  they already have a dembrane account.
- An invite expires after 7 days. A person can also decline, and you are told when they do.
- Accepting as "Member", "Billing" or "Admin" also makes the person a member of your
  organisation.

Open invites are listed under "Pending invites" on the "Members" page. Each row has "Copy
invite link", "Resend invite email" and "Revoke invite". Resending moves the expiry 7 days out.

> [!NOTE]
> An invite link is personal. It works only for someone signed in with the invited email
> address, so it is not a link you can post for a group.

## Change a role or remove someone

Use the role picker in the "Members" list to switch between "Member", "Billing" and "Admin".
Two changes cannot be made in place:

- "External" to "Member", or back. Remove the person, then invite them again with the new role.
- "Observer" to anything else. Remove them and invite them again as a member.

Removing someone sticks. If they are still in your organisation, their organisation role does
not let them back in. They return only with a new invite.

Anyone can leave with "Leave workspace". The only admin cannot leave, be removed or change
their own role until someone else is an admin.

## Seats

A seat is one person, not one membership.

- "Admin", "Member", "Billing" and "External" each take a seat. "Observer" is free.
- A person counts once per billing account, however many of its workspaces they are in.
- A workspace for an external client has its own billing account, so the same person can hold
  a seat there and another on your organisation's account.
- Seats are not capped on any plan. An invite is never refused because of a seat count.
- An invite to a paid role is refused while your plan is cancelled or past due. Observer
  invites still go through.
- A pending invite is not billed. It counts once it is accepted.

See [tiers, billing and usage](./tiers-billing-and-usage.md) for where the count shows.

## Set who can find the workspace

Open "Settings", then "General", and look for "Access". Pick one and press "Save access".

| Setting | Who can find and join it |
|---|---|
| "Everyone in your organisation" | Members of your organisation can find it and request access. Organisation admins can open it and join. This is the default. |
| "Invite only" | Hidden from members of your organisation. Organisation admins can still find it and join. |
| "Private" | Only the people you add. Organisation admins do not get in. The organisation owner still can. |

- Leaving "Everyone in your organisation" needs the Innovator plan or higher. Going back, or
  switching between "Invite only" and "Private", needs no plan.
- A member of your organisation who finds the workspace presses "Request access". You approve
  or decline under "Access requests" on the "Members" page. Approving adds them as a member.
  Declining is silent.
- An organisation admin who joins does so with "Join as admin". Nobody has to approve it.

You can also keep a single project private. On the project's "Access" tab, a workspace admin
uses "Make private" and then "Share with someone". Both need the Innovator plan or higher. A
private project is visible to the workspace's admins and to the people it is shared with. See
[visibility and discovery](../../features/visibility-and-discovery.md).

## Give the assistant standing context

In "Settings", "General", the field "Assistant context" holds guidance that
[the assistant](./chat-and-ask.md) gets in every project chat in the workspace. Write it once,
for example:

> We are a research agency. Reports go to municipal clients, so keep summaries formal and in
> Dutch.

- It holds up to 4,000 characters and saves on its own. Only admins can edit it.
- It reaches the assistant, which is the Beta "Agentic" chat. The default "Specific Details"
  chat works from each project's own context and key terms.
- "Assistant memory", in the same settings, lists the notes the assistant saved about the
  workspace. Everyone in the workspace shares them. You can "Remove" a note, not write one.

## The rest of the settings

- "General" also holds the workspace "Name" and "Description", the "Logo", "Data ownership",
  the default legal basis for the workspace's projects, and the switch that lets dembrane staff
  in for support.
- "Logo" is the workspace logo shown to participants. It needs the Changemaker plan or higher.
  Use a PNG, JPEG or WebP file of at most 5 MB, about three times as wide as it is high.
- "Data ownership" says whether the workspace is for your own organisation or for an external
  organisation that owns its data. See
  [external-client workspaces](../host-partner/external-client-workspaces.md).
- Support access is off until you allow it. See [getting help](./getting-help.md).
- "Usage and billing" shows this month's usage and your plan.
- "Danger zone" has "Delete this workspace". Delete the projects in it first, then type the
  workspace name to confirm.

Only an organisation admin can create another workspace. The free plan covers one workspace per
organisation. See
[organisations and workspaces](../../features/organisations-and-workspaces.md).

## Related

- [Roles and permissions](../../features/roles-and-permissions.md): every role and what it can
  do.
- [Invites and access](../../features/invites-and-access.md): sending, accepting and revoking
  invites.
- [Visibility and discovery](../../features/visibility-and-discovery.md): workspaces and
  projects that not everyone can see.
- [Organisations and workspaces](../../features/organisations-and-workspaces.md): how the two
  fit together.
- [Staff support access](../../features/staff-support-access.md): what dembrane staff can and
  cannot do in your workspace.
- [Tiers, billing and usage](./tiers-billing-and-usage.md): plans, seats and the usage screen.
- [Account and settings](./account-and-settings.md): your own account.
