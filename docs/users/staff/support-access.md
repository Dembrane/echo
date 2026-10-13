---
title: Support access
description: How dembrane staff get into a customer's workspace to help, by joining when the customer allows it or by requesting access, what a session can do, and how it ends.
audience: staff
---

# Support access

You cannot open a customer's projects from the staff console. To look inside a workspace you start
a support session, and only the customer can allow one. A session lasts 24 hours, and the customer
sees every step.

## Start a session

1. Open "Usage and billing" in the [staff console](./admin-panel-overview.md).
2. Expand the account and select the three-dot button on the workspace.
3. Look under "Join for support".

| You see | It means | Do this |
|---|---|---|
| "Join for support (24h)" | The customer has support access switched on. | Select it. Your session starts at once. |
| "Request access" | Support access is off. | Send a request. An admin of the workspace decides. |

### Join

After "Join for support (24h)" the screen confirms: "Support access granted. It ends automatically
in 24 hours." Select "Open workspace" to go in.

The workspace's admins get a notification and the email "dembrane staff joined {workspace_name}
for support".

### Request access

1. Select "Request access".
2. Write what you need access for. The note is optional, and the admins read it. For example:
   "investigating the report issue you emailed about".
3. Select "Send request".

The workspace's admins get a notification and the email "dembrane staff requested access to
{workspace_name}". In their workspace settings your request shows as "{name} from dembrane" with
"Approve" and "Decline".

- While you wait, the screen shows "Request sent. Waiting for the workspace admins." and "Cancel
  request".
- When an admin approves, your session starts at once and lasts 24 hours.
- A request nobody answers expires after 7 days.
- If the customer switches support access on while you wait, the request is cancelled and you
  can join directly.

## What a session lets you do

| How it started | What you can do |
|---|---|
| You joined while support access was switched on | View projects, conversations, reports and usage. Nothing else. |
| An admin approved your request | What a workspace admin can do, except invite people, manage members, change workspace settings, or delete projects, reports and conversations. |

No session can turn support access on or off, approve or decline a support request, approve who
joins the workspace, remove members, change roles, share projects or delete the workspace.

You are not listed under the workspace's "Members" and you take no seat.

## Extend or leave

Open the workspace actions again. An open session shows "You have support access to this
workspace. It ends automatically on" and the date and time.

- "Extend 24h" restarts the 24 hours and notifies the admins. It shows while the customer has
  support access switched on. A session that came from an approved request has no extend button:
  when it ends, send a new request.
- "Leave now" ends your session. Leave when you are done.

## How it ends

- Each session ends by itself after 24 hours.
- When the last session on a workspace ends, the customer's support switch turns itself off.
  The admins get "Support access to {workspace_name} turned off". To come back you need the
  switch on again, or a new request.
- If the customer turns the switch off, every open session ends at once.

> [!TIP]
> If yours is the only open session, "Leave now" also turns the customer's switch off. Finish what
> you came for before you leave.

## What the customer sees

The workspace's admins and owners find "Access history" in their workspace settings. It lists
every step with your name and the time, for example "dembrane staff requested access", "dembrane
staff joined for support", "dembrane staff extended their session" and "dembrane staff left".

They get an email when you request access and when you join, and a notification when you extend
or leave.

## Related

- [Staff support access](../../features/staff-support-access.md): the same thing from the customer's side.
- [Usage, billing and payments](./usage-and-billing-rollup.md): the table where the workspace actions open.
- [The staff console](./admin-panel-overview.md): what the console shows and what it does not.
- [Roles and permissions](../../features/roles-and-permissions.md): what a workspace admin can do.
