---
title: Customer accounts
description: How dembrane staff run a customer account in the staff console, from building a demo and sending an offer to tasks, questions and the invoice.
audience: staff
---

# Customer accounts

"Accounts" in the [staff console](./admin-panel-overview.md) holds the commercial side of each
customer: the demo, the offer, the documents they sign, the tasks you set them and the questions
they ask. What you send appears for the organisation's owners, admins and billing members under
"Tasks" and "Documents".

## Find an account

- Search with "Search by name or member email".
- Filter with "All", "Prospects", "Customers", "Churned" or "No account".
- Each row counts what is open: "Open tasks", "Waiting on us", "Unsigned", "Overdue" and
  "Questions".
- "Demos" above the list shows the demos that still need you: "building", "ready to publish" or
  "failed".

Select a row to open the account card.

## The account card

| Part | What it is for |
|---|---|
| "Documents" | Offers, agreements and invoices. "Push offer" and "Upload PDF" start a new one. |
| "Tasks" | What the customer still has to do, and their answers. |
| "Questions" | Questions from the customer, and your replies. |
| "Stage" | Prospect, Customer or Churned. A prospect becomes a customer when they sign an offer. |
| "Needs form and demo" | The customer's needs form (reference, email, booked call, answers) and the link to their demo. |
| "Billing details" | What the customer filled in for their invoices. You read it, and you can change how invoices are delivered. |
| "Timeline" | Every event on the account, marked "Customer", "Staff" or "System". |

An organisation that signed up on its own shows "This organisation has no account yet". Choose
the "Stage" and the "Language", then select "Enable account". After that you can push offers and
tasks.

A customer who wants a paid plan goes from the dashboard to the pricing calculator on
dembrane.com, and can book a call there. What they fill in is saved with their account's email,
workspace and organisation. There is no upgrade request for you to approve.

## Build a demo

1. On the accounts list, select "New demo".
2. Fill in "Organisation name", "Website" and "Brief". The brief is "What they want to hear from
   whom, and why now." "Event or customer example" is optional.
3. Choose the "Demo language" and fill in "Contact name" and "Contact email".
4. Decide on "Let them sign in with an email code" and on "Prepare an offer". The second one puts
   a draft offer on their account for you to send after the demo.
5. Select "Build the demo".

The build runs through "Website", "Research", "Corpus", "Seeding", "Extraction" and "Draft ready".
If a step fails, select "Retry". When the page says "The draft is ready. Check it, then publish.",
select "Open the draft (EN)" to look through the demo, then select "Publish".

- The conversations in a demo are fictional.
- "Open the draft" shows the deck as the public link will show it, under a bar that says it is a
  draft and not public yet. Only staff can open it, and each time is written to the account's
  timeline.
- The build creates the prospect's organisation, with your contact as its admin. Nothing reaches
  them until you publish.
- The build makes you, the staff member who started it, an admin of the demo's workspace (not of
  the organisation), so the draft is in your own workspace list before you publish. Only a
  @dembrane.com account is added, and only you: an account manager who did not start the demo
  is not. If you are the demo's contact yourself, you are not added at the build: you get your
  place when it is published, like any contact. You stay in the workspace after publishing, in
  its member list like anyone, and its admins can remove you. You take no seat there. Demos
  built before this change got their builder added the same way, under the same rules.
- Outside the customer's organisation the dashboard shows you as "External" there. You can open
  the demo project, change it in the portal editor and edit its brief. You cannot open the
  workspace's settings, make a new project or a copy, pin a project or delete a conversation.
- "Publish" makes the public demo link live. With "Send the sign-in invitation" on, the contact
  gets the email "Your dembrane account for {org_name}" and signs in with a code. With it off, the
  page says "No email went out; share the demo link yourself."
- A contact you invite to sign in also joins the demo's workspace, "dembrane demo", as an admin,
  and the demo project is pinned on that workspace's card. Every time they sign in, their
  organisation page shows the workspace with the demo one click away, also after the "Check out
  the demo" step under "Get started" is done.
- "Unpublish" on a published demo takes the public link down and makes the demo a draft again.
  When you publish again the same link is live, and a contact who already has the sign-in
  invitation gets no second email.

### A demo for someone who already uses dembrane

Once you type the contact's email, the form checks it. "New to dembrane. The demo gets a new
organisation." means they have no account, and the demo goes as above. When they have one, the
form lists their organisations under "Where the demo goes", next to "A new organisation", and
picks the first of their own organisations.

- Choose one of their organisations and the demo gets a workspace of its own there, named after
  the "Organisation name" you typed (for example "Brent Council"), with the demo project pinned on
  it. No organisation is created, no "Get started" steps are added, and the organisation's account
  manager, stage, billing details and the contact's role in it stay as they are. "Prepare an offer"
  is not offered: push an offer from the account card instead.
- Choose "A new organisation" and everything goes as above, the "Your dembrane account for
  {org_name}" email included.
- If there is already a demo for that email or that name, or an organisation with that name the
  contact is not in, the form says so with a link to it ("Open it", "Open the account"). It never
  stops you from building.
- While the demo builds and while it is a draft, nobody in that organisation sees the workspace or
  the project, its owner included, and nobody gets an email or a notification about it. You do:
  the build made you its admin, so it is in your own workspace list and the demo project opens
  for you, as above. Support access to it cannot be asked for.
- "Email them the demo" on: publishing adds the contact to the workspace as an admin, opens the
  workspace to the organisation like any new workspace, and sends them "Your demo is ready:
  {demo_name}" in their own language, with a button that opens the demo project (they sign in
  first if they are signed out). The page then says "Published. {email} has the email with the
  link to the demo."
- With it off, publishing only makes the public link live. The workspace stays hidden and the
  contact gets nothing; share the link yourself.
- The demo's workspace takes no seats, before or after publishing: the contact and you add none
  to the organisation's bill, and someone who already has a seat there keeps that one seat.
- A @dembrane.com account in a customer's workspace takes no seat on its account unless it is a
  member of the customer's organisation: that covers you in a demo's workspace and anyone at
  dembrane a customer adds to a workspace for help.
- If the contact has left the organisation, or the organisation was deleted, before the build
  reached "Seeding", that step fails and says why. Fix it and select "Retry", or start a new demo.
  Publishing with the email on checks the same again: if either changed since, nothing is
  published and the page says why. Publishing with the email off still works.
- A draft never published, or published with the email off, leaves its workspace hidden from
  the organisation. There is no button to discard it yet. You stay its only admin and cannot
  leave it; nobody in the organisation can see it to remove you. When an organisation is
  deleted its hidden demo workspace goes with it: it is not one of the workspaces the customer
  has to empty and delete first, and they could not see it to do so.

## Send an offer

1. On the account card, select "Push offer".
2. Choose the "Template" ("Subscription", "Event" or "Custom") and the "Language" (English or
   Dutch).
3. Add the lines: "Description", "Bullets", "Quantity", "Unit price (EUR)" and "VAT %".
4. Select "Save draft" to look at the PDF first, or "Send offer".

A draft is yours alone: "Only staff see this draft. When you send it, it gets that day's date and
is valid for 14 days." Open it with "Review and send", edit it with "Change", and send it with
"Send offer".

What sending does:

- The offer is valid for 14 days. After that it cannot be signed.
- It pins the versions of the terms, the SLA and the DPA in force that day. An event offer has no
  SLA.
- Each owner, admin and billing member of the organisation gets the email "Your offer from
  dembrane is ready to sign".
- The customer gets their tasks: "Tell us who signs the offer", "Review and sign the offer",
  "Sign the data processing agreement" and "Fill in billing details". The last one opens after
  they sign.
- "Get started" steps the prospect has not done yet are withdrawn.

A sent offer cannot be changed. Select "Withdraw" and push a new one. A signed document cannot be
withdrawn. When it is signed, "Open signed PDF" gives you the copy with the signature and its
audit page.

## Send another document

1. On the account card, select "Upload PDF". The file can be 10 MB at most.
2. Give it a "Title", choose "Document" or "DPA", and choose the language.
3. Leave "Needs a signature" off to send it right away, to read ("Upload and send"). Turn it on to
   place the fields first ("Upload and place fields").

In the field editor, select "Add a field" and choose its kind: "Signature", "Initials", "Name",
"Role", "Date", "Text" or "Checkbox". Drag a field to move it and pull its corner to resize it.
The document needs a name field and a signature field before "Send to sign" works. After sending,
the fields are fixed.

## Set a task

1. On the account card, select "New task".
2. Fill in the "Title" and, if you like, "What we ask".
3. Under "The customer answers with", choose "A text answer" or "A file".
4. To hold the task back until a document is signed, pick that document under "Opens after
   signing".
5. Select "Create task".

When the customer answers, the task reads "Waiting on dembrane". Select "Approve", or "Send back"
and write "What to change". "Withdraw" takes back a task you no longer need.

## Answer a question

A customer's question lands under "Questions". Write your answer and select "Reply", or "Reply and
close" when it is settled. The customer reads it on their own page. "New message" starts a thread
from your side.

## What the customer gets by email

| Email subject | When |
|---|---|
| "Your dembrane account for {org_name}" | You publish a demo with the sign-in invitation on. |
| "Your demo is ready: {demo_name}" | You publish a demo in an organisation they already work in, with "Email them the demo" on. |
| "Your offer from dembrane is ready to sign" | You send an offer. |
| "Still open for {org_name}: {task_title}" | You select "Remind" on a task and send it. |
| "{document_title} has been withdrawn" | You select "Email the customer" on a withdrawn document and send it. |

The last two never go out by themselves. You see a preview first and can add "Your own line
(optional)". An open task does not remind the customer on its own: "The customer gets no automatic
reminder. After seven days the account manager is asked to check in."

## The invoice

When an offer with an amount is signed, the billing details are complete and, where the DPA is a
document of its own, that DPA is signed too, dembrane is asked once to send the invoice. The order
of the three does not matter. An offer whose signer agreed to the DPA together with the offer waits
for no second signature. The "Timeline" shows "Ready to invoice".

Until then "Documents" says what the offer still waits for, for example "Invoice waits for the DPA
signature", and the "Timeline" says the same each time the answer changes.

dembrane's accounting system makes and sends the invoice. A copy with its PDF then appears under
"Documents", for you and for the customer.

A customer who chose "Another way" gets no invoice by email or Peppol. What they wrote
arrives as a question under "Questions", and their "Billing details" say: "Send each invoice
by hand." Agree the way with them there. The same card says when a customer in the EU has no
VAT number.

Signing an offer does not change the customer's tier. Set it under
[tiers and discounts](./discounts-trials-and-tiers.md).

## Related

- [Offers and invoices](../../features/offers-and-invoices.md): signing, tasks, billing details and paying, from the customer's side.
- [Tiers and discounts](./discounts-trials-and-tiers.md): set the tier after an offer.
- [Managed billing](./managed-and-offline-billing.md): accounts that pay by invoice.
- [The staff console](./admin-panel-overview.md): where "Accounts" sits.
