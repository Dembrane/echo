# Staff support access

What this feature lets you do, from the perspective of the people using it.

Sometimes a customer hits a problem that is faster to fix from inside their own
workspace than to debug over email. Staff support access lets a customer open a
temporary door for dembrane staff, and lets staff step through it for 24 hours.
The door closes by itself. No one has to remember to revoke anything.

There are two people in this story: the *customer* (a workspace admin or owner)
who decides whether the door exists, and the *staff member* who walks through
it.

## If you are a customer (workspace admin or owner)

You control whether dembrane staff can ever get into your workspace. Access is
off until you turn it on.

### Turning it on

1. Go to Workspace Settings, Access section.
2. Turn on *Allow dembrane staff to access this workspace for support*.

That is the whole step. The toggle saves on its own, there is no Save button.

While it is on, dembrane support staff can join your workspace as an admin to
help you. Each time a staff member joins, their access ends automatically after
24 hours.

### What staff can and cannot do

- A staff member who joins gets the *admin* role, the same level as your own
  admins, so they can see and act on the same things you can.
- Their access is temporary. It expires 24 hours after they join. If they need
  longer they have to deliberately extend it, and it still expires again 24
  hours later.
- Only staff can join, and only while your toggle is on. The moment you turn the
  toggle off, no new staff can join.

### Turning it off

Turn the same toggle off whenever you want. New staff joins are blocked
immediately. Anyone already inside finishes their current 24-hour window, or
leaves early. Turning the toggle off is your signal that you no longer want the
door open.

You usually will not need to turn it off yourself. When the last staff member
leaves or their window expires, the toggle turns itself off, and we send you a
notification and an email saying the session ended and access is now off. Turn
it back on any time you need more help.

### Approving a request when the toggle is off

If the toggle is off and a staff member needs to get in, they can send you a
request instead of joining directly. You get a notification and an email, and a
*Pending access requests* block appears in Workspace Settings, Access. Each
request shows who is asking and an optional note about what they need.

- *Approve* grants that one staff member admin access for 24 hours. It is a
  one-time grant: the toggle stays off, so approving one request does not open
  the door for everyone.
- *Deny* declines the request. The staff member is told either way.

A request that sits unanswered for 7 days expires on its own.

### Access history

The Access section keeps a running history of what happened: toggles, requests,
joins, extensions, and when access ended. Newest first, with *Show more* to page
back. It is there so you can always see who had access and when, without asking
anyone.

### The weekly reminder

If support access stays on but no staff has joined for 7 days, we send a gentle
reminder so a forgotten toggle does not stay open. Turn it off from the
reminder, or leave it on if you still need help.

### Will this affect my bill?

No. A staff member who joins for support does not count as a seat. Support
access never changes what you are charged.

## If you are dembrane staff

You join a customer workspace from the admin dashboard, one workspace at a time,
and only when that customer has opted in.

### Joining

1. Open the admin dashboard and find the workspace in the list.
2. Open its actions, then the *Join for support* control.
3. Click *Join for support (24h)*.

You now have admin access to that workspace for 24 hours. An *Open workspace*
link appears so you can jump straight in.

If the customer has not turned on support access, the join is refused with a
clear message telling you so. You can either ask them to enable the toggle, or
send a request (below).

### Requesting access when the toggle is off

You do not have to wait for the customer to find the toggle. Open the *Join for
support* control and choose *Request access*. Add a short note about what you
need, or leave it blank. The workspace admins get a notification and an email,
and approve or deny from their Workspace Settings.

- If they approve, you get admin access for 24 hours, the same as a normal join.
  Their toggle stays off; the grant is just for you, just this once, so there is
  no *Extend* on an approved session. If you need longer, send another request.
- If they deny, or the request goes unanswered for 7 days, you are told and the
  request closes.

While a request is pending the control shows *Request sent*, with the option to
cancel it.

If you already belong to that workspace as a real member, joining does nothing
harmful: it just tells you that you already have access, and it does not put a
24-hour expiry on your real membership.

### While you are in

The control shows *You have support access to this workspace. It ends
automatically on <date and time>* so you always know when your window closes.

- *Extend 24h*: resets the clock to 24 hours from now. Use this if a support
  session runs long.
- *Leave now*: ends your access immediately, before the 24 hours are up. Good
  hygiene when you are done.

### When access ends

You do not have to do anything. Access is revoked automatically at the
expiry time. Even if something goes wrong with the scheduled revoke, a
background sweep removes expired support access within about 15 minutes, so
access never lingers.

## At a glance

| | Customer | Staff |
|---|---|---|
| Where | Workspace Settings, Access | Admin dashboard, workspace actions |
| Action | Toggle on or off, approve or deny requests | Join, Extend, Leave, Request access, Open workspace |
| Role granted to staff | Admin | (receives admin) |
| Duration | Until staff window expires | 24 hours per join, extendable |
| Auto-revoke | Yes, after 24h | Yes, after 24h |
| Toggle auto-off | Yes, when the last session ends | n/a |
| Told about access events | Notifications, email, and access history | Told when a request is approved or denied |
| Affects billing | No | No |
