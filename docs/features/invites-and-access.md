---
title: Invites & access
description: How people join an organisation or a workspace in dembrane. Sending an invite, what the invited person sees, accepting, pending invites, and leaving.
audience: all
---

# Invites & access

You add people with "Invite people". A colleague who is already in your organisation is
added to the workspace at once. Anyone else gets an invite and joins only when they accept
it, whether they have a dembrane account or not.

## Send an invite

1. Open the "Members" page of your organisation or of a workspace and choose "Invite
   people".
2. Type one or more email addresses.
3. Pick a "Role". See [roles & permissions](./roles-and-permissions.md) for which one.
4. Under "Add to workspaces", tick the workspaces they should join. The same role applies
   to every workspace you tick.
5. Send.

Who can invite, and to what:

- A workspace admin invites people to the workspaces they administer. They must pick one:
  "Pick at least one workspace to send the invite."
- An organisation admin can also invite to the organisation alone, with no workspace
  ticked: "No workspace picked. They'll be added to {orgName} and can request workspace
  access themselves."
- For a workspace you can give Admin, Member, Billing, External or Observer. For the
  organisation alone you can give Member, Billing or Admin.
- External and Observer need a workspace: "Externals only exist inside a workspace. Pick
  at least one to send the invite." Observer works only in a workspace for an external
  client.
- You cannot give a role above your own, and you cannot invite yourself.
- One person can send 20 workspace invites an hour.

## What happens next

Each address gets a result line.

| Result | What it means |
|---|---|
| "Added" | They are already in the workspace's organisation, so they are in the workspace now. They get a notification and the email "You've been added to {workspace_name}". |
| "Sent" | They must accept first. They get the email "{inviter_name} invited you to collaborate on dembrane" with a link. If they have an account, they also get a notification marked "Action needed". |
| "Already a member" | Nothing changes. |
| "Already invited" | Their invite is still open. No second email goes out. |
| "Rate limited" | You reached 20 workspace invites this hour. |
| "Reactivate plan" | Your plan is cancelled or a payment is overdue. See [seats](#seats). |

An invite to the organisation alone always waits for acceptance, unless the person is
already a member.

The result is the same for an address that has a dembrane account and one that does not.
Sending an invite never tells you whether someone has an account.

## What the invited person does

The link opens a page titled "{inviterName} invited you to join {name}".

- No account yet: "Create an account to join". The email field is filled in and locked:
  "Locked to match the invite. To use a different address, ask the admin to re-invite that
  email." After they verify their email, the welcome screen names your organisation and
  "Continue" accepts every invite waiting for them.
- An account, signed out: "Already have an account? Log in".
- Signed in with the invited address: "Accept and join" or "Not now".
- Signed in with another address: "This invite isn't for this account", with "Log out and
  use the invited email".

People with an account also find their invites under "Pending invites". The account menu
shows "You have a pending invite". Each invite shows the role and who sent it, with "Accept
and join" and "Decline".

Good to know:

- Only the invited email address can accept. Someone who registers with a different address
  gets no invite and starts with an organisation of their own.
- Accepting one invite also accepts every other open invite from the same organisation.
- Accepting a workspace invite as Member, Billing or Admin also makes the person a member
  of your organisation.
- Declining removes the invite. You are told: "{name} declined your invite".
- When someone accepts, you are told: "{name} joined {workspace}". Organisation admins are
  told about a new organisation member. Workspace admins are told when an external or an
  observer joins.

## Links, expiry, resend and revoke

- An invite expires after 7 days. The invited person then reads "Invites expire after 7
  days. Ask {inviterName} to send a new one."
- Every open invite has its own link. "Copy invite link" is on the result line and in the
  "Pending invites" list. The link is personal: it works only for someone signed in with
  the invited address. There is no general join link.
- "Pending invites" lists the email, the role, who invited them, and the workspace name or
  "Org only". Organisation admins see every open invite of the organisation. Workspace
  admins see those of their workspace, on its "Members" page. Other members do not see the
  list.
- "Resend invite email" sends the email again and gives the invite 7 more days. The person
  who sent the invite and organisation admins can do this.
- "Revoke invite" cancels it: "Revoke the invite sent to {email}? You can invite them again
  later." The person who sent it, organisation admins, and the workspace's admins can do
  this.

## Seats

- Every role except Observer takes a seat once the person has joined. An open invite is not
  billed.
- No plan has a seat limit, so an invite is never refused for the number of people.
- One thing does block an invite to a paid role: a plan that is cancelled or has a payment
  overdue. The result line reads "Reactivate plan". Observer invites still go through.
- If you tick workspaces that are billed on their own, the screen warns: "These workspaces
  are billed separately. Each person you add takes a seat in {billingContextCount} billing
  contexts, each invoiced on its own."

The full rules are in [tiers & billing](./tiers-and-billing.md#seats).

## Leaving and removing

- Anyone can leave a workspace with "Leave workspace", except its last owner and its only
  admin.
- When an admin removes someone from a workspace, that person's organisation role does not
  let them back in. They return through a new invite.
- Removing someone from the organisation also removes them from all its workspaces.
- Someone who has lost all access sees on their home screen, for 30 days: "Your access to
  {workspace} ended on {date}."
- You cannot turn an external into a member, or a member into an external, with the role
  picker. Remove the person and invite them again with the new role.

## Asking to join

People in your organisation can also ask to join a workspace they can find, and
organisation admins can join some workspaces without asking. See
[visibility & discovery](./visibility-and-discovery.md).

## Related

- [Roles & permissions](./roles-and-permissions.md): the roles you give.
- [Visibility & discovery](./visibility-and-discovery.md): finding a workspace and asking to join.
- [Organisations & workspaces](./organisations-and-workspaces.md): the two kinds of membership.
- [Tiers & billing](./tiers-and-billing.md): how seats are counted.
- [Notifications](./notifications.md): the notices and emails around invites.
