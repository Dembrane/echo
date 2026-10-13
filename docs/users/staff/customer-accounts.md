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

A customer who wants a paid plan answers a short needs form in the dashboard and books a call.
Their answers show under "Needs form and demo". There is no upgrade request for you to approve.

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
look through the demo and select "Publish".

- The conversations in a demo are fictional.
- The build creates the prospect's organisation, with your contact as its admin. Nothing reaches
  them until you publish.
- "Publish" makes the public demo link live. With "Send the sign-in invitation" on, the contact
  gets the email "Your dembrane account for {org_name}" and signs in with a code. With it off, the
  page says "No email went out; share the demo link yourself."

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
| "Your offer from dembrane is ready to sign" | You send an offer. |
| "Still open for {org_name}: {task_title}" | You select "Remind" on a task and send it. |
| "{document_title} has been withdrawn" | You select "Email the customer" on a withdrawn document and send it. |

The last two never go out by themselves. You see a preview first and can add "Your own line
(optional)". An open task does not remind the customer on its own: "The customer gets no automatic
reminder. After seven days the account manager is asked to check in."

## The invoice

When an offer with an amount is signed and the billing details are complete, dembrane is asked
once to send the invoice. The order of the two does not matter. The "Timeline" shows "Ready to
invoice".

dembrane's accounting system makes and sends the invoice. A copy with its PDF then appears under
"Documents", for you and for the customer.

A customer who chose "Through an invoice portal" gets no invoice by email or Peppol. Their
"Billing details" name the portal: add each invoice there by hand. The same card says when a
customer in another EU country has no VAT number.

Signing an offer does not change the customer's tier. Set it under
[tiers and discounts](./discounts-trials-and-tiers.md).

## Related

- [Offers and invoices](../../features/offers-and-invoices.md): signing, tasks, billing details and paying, from the customer's side.
- [Tiers and discounts](./discounts-trials-and-tiers.md): set the tier after an offer.
- [Managed billing](./managed-and-offline-billing.md): accounts that pay by invoice.
- [The staff console](./admin-panel-overview.md): where "Accounts" sits.
