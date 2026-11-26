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

1. Open the organisation's card under "Accounts" in the [staff console](./admin-panel-overview.md)
   (see [customer accounts](./customer-accounts.md)).
2. Find the workspace under "Support access". Each row has one status, the next step as a
   button, and the rest under the three-dot button. On a phone the status sits under the
   workspace's name, and the next step stays a button.

| Status | It means | Next step | Under the three-dot button |
|---|---|---|---|
| "No access" | Support access is off and you have not asked. | "Request access". An admin of the workspace decides. | |
| "Request sent" | You asked and the admins have not answered yet. The line under the name says when the request expires. | "Cancel request" takes it back. | "Join read-only", while the switch is on |
| "Read access on" | The customer has support access switched on. | "Join read-only". Your visit starts at once. | "Ask to edit" |
| "Read only" | You are in to read, until the time under the name. If you asked to edit, the line says "Request to edit sent". | "Open" | "Ask to edit" (or "Cancel request"), "Extend visit by 24 hours", "End visit now" |
| "Can edit" | An admin approved your request. You can edit until the time under the name. | "Open" | "Extend visit by 24 hours" (while the switch is on), "End visit now" |
| "Demo draft" | The workspace holds a demo that is not published yet. | Nothing. Open the draft from the demo's page. | |

A green status means you are in the workspace now. Blue means your request waits on the admins.

The same steps still sit in "Usage and billing", under their older names: expand the account,
select the three-dot button on the workspace and look under "Join for support". There joining is
"Join for support (24h)", extending is "Extend 24h" and ending is "Leave now".

### Join

After "Join read-only" the row says "Read only", with the time your visit ends under the name.
Select "Open" to go in.

The workspace's admins get a notification and the email "dembrane staff joined {workspace_name}
for support".

### Request access

1. Select "Request access". Where you can already read, the step is "Ask to edit" under the
   three-dot button; it sends the same request.
2. Write what you need access for. The note is optional, and the admins of that workspace read
   it. For example: "investigating the report issue you emailed about".
3. Select "Send request".

The workspace's admins get a notification and the email "dembrane staff requested access to
{workspace_name}". In their workspace a dialog opens with your name, the workspace and your note,
with "Approve for 24 hours" and "Decline".

- While you wait, the row says "Request sent" and "Cancel request".
- When an admin approves, your visit starts at once and you can edit for 24 hours.
- You can also ask while you are in to read. When an admin approves, the same visit can edit for
  24 hours from the approval.
- A request nobody answers expires after 7 days.
- If the customer switches support access on while you wait, the request is cancelled and you
  can join directly.

## What a session lets you do

| How it started | What you can do |
|---|---|
| You joined while support access was switched on | View projects, conversations, reports and usage. Nothing else. |
| An admin approved your request, before you joined or while you were in to read | What a workspace admin can do, except invite people, manage members, change workspace settings, or delete projects, reports and conversations. |

No session can turn support access on or off, approve or decline a support request, approve who
joins the workspace, remove members, change roles, share projects or delete the workspace.

You are not listed under the workspace's "Members" and you take no seat.

## Extend or end a visit

Open the row's three-dot button. The line under the workspace's name says until when your visit
runs.

- "Extend visit by 24 hours" restarts the 24 hours and notifies the admins. It shows while the
  customer has support access switched on. It does not extend the right to edit: that still ends
  24 hours after the approval, and the rest of the visit reads only. With the switch off there is
  no extend step: when the visit ends, send a new request.
- "End visit now" ends your visit. End it when you are done.
- When a visit ends, so does any approval to edit. Joining again later reads only until an admin
  approves a new request.

## How it ends

- Each session ends by itself after 24 hours.
- When the last session on a workspace ends, the customer's support switch turns itself off.
  The admins get "Support access to {workspace_name} turned off". To come back you need the
  switch on again, or a new request.
- If the customer turns the switch off, every open session ends at once.

> [!TIP]
> If yours is the only open session, "End visit now" also turns the customer's switch off. Finish
> what you came for before you end it.

## What the customer sees

The workspace's admins and owners find "Access history" in their workspace settings. It lists
every step with your name and the time, for example "dembrane staff requested access", "dembrane
staff joined for support", "dembrane staff extended their session" and "dembrane staff left".

They get an email when you request access and when you join, and a notification when you extend
or leave.

## Related

- [Staff support access](../../features/staff-support-access.md): the same thing from the customer's side.
- [Customer accounts](./customer-accounts.md): the account card, where "Support access" sits.
- [Usage, billing and payments](./usage-and-billing-rollup.md): the other table where the workspace actions open.
- [The staff console](./admin-panel-overview.md): what the console shows and what it does not.
- [Roles and permissions](../../features/roles-and-permissions.md): what a workspace admin can do.
