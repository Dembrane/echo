# Customer accounts

The customer's organisation in echo holds everything between dembrane and that customer on
one page: what to do next, what to sign, billing details, documents and invoices, questions,
and a call with us. Simple for the customer, automated for us: every open task reminds the
customer every seven days until it is done, every signature reaches us in Slack, and sam can
push documents and tasks at any moment. Echo owns this data; Attio holds the relationship,
Exact the books, sam's ops objects the process (sam PR #368, slice 1b).

## The flow

1. A prospect fills the needs form (`pricing_configuration`) and books a call.
2. Staff or sam seed a synthetic demo. Every demo names a contact person's email. Seeding
   creates the organisation (stage `prospect`), links the needs form row, and creates the
   contact as the organisation's admin (a one-time code sign-in; a password only for
   demos). The public presentation link shows "Continue in dembrane".
3. When an offer is pushed, the customer sees it the moment they sign in, as the task
   "Review and sign the offer". A "Billing details" task exists from the start, greyed out,
   and opens the moment the offer is signed; it is the most important step after signing.
4. Signing posts to our Slack channel and emits `account.document.signed`. sam's
   `invoice_request` creates the invoice in Exact and pushes it back into the documents,
   with dembrane's bank details. Most customers pay by bank transfer; a Mollie link is shown
   only when one exists.
5. Anything else is ad hoc: staff or sam push documents (a DPA for separate signing, a
   workshop plan) and tasks ("send us your PO number"). Staff approve or send back what the
   customer submits.

## The offer

The offer copies today's Google Doc templates (subscription and event, English and Dutch,
in `accounts-reference/`): dembrane's letterhead (address, VAT, IBAN, KvK), "<Name> x
dembrane", date and offer id, a greeting, the lines table (description with bullets,
quantity, unit price, total excl. VAT), the total, and the acceptance block. Acceptance
names the signer, the organisation and its address, and states that signing accepts the
agreement made of: the offer, the General Terms and Conditions, Annex A (SLA, not for
single events) and Annex B (DPA). An offer is valid 14 days. Amounts are integer cents.

The terms, SLA and DPA are the published texts at dembrane.com/legal, stored per version
with their SHA-256; an offer pins the versions it was sent with. If the signer may not
agree to data processing for their organisation, the DPA becomes its own document and task
for an authorised representative (art. 3.6 of the terms).

## Signing

Built into echo, with a DocuSeal-like experience. A document carries fields placed on its
pages: signature, initials, name, role, date, and text or checkbox fields the customer fills
(organisation, address, PO number). The signer is signed in with a verified email and is
walked field by field ("Next" jumps to the next required field) through the document as it
will be signed. A signature is drawn, typed in a script face, or uploaded as an image, and
can be reused for initials. One line says why signing matters: it completes the agreement,
so we can invoice and the terms, SLA and data processing are in force.

Offers place their fields from the template's acceptance block automatically. For any other
PDF (a customer's own DPA, a purchase order form) staff place the fields on the pages in a
small field editor before sending, as in DocuSeal's template builder.

Echo stamps the values and the signature image onto the PDF, appends an audit page (signer,
email, organisation, time, IP, user agent, SHA-256 of the unsigned document and of the
signature image, the confirmation text) and stores it. The signature row is insert only; a
signed version is immutable and a change is a new version signed again. This is a simple
electronic signature under eIDAS.

## Reminders

Every open task has a reminder schedule: an email seven days after it opened and every seven
days after, until it is done or withdrawn. A task that is waiting on us does not remind the
customer; staff see it on the card instead. The interval is config, per task overridable.

## Data (new tables, expand only)

- `account_document`: org, kind (`offer`, `dpa`, `invoice`, `other`), title, language,
  version, body (structured for offers, markdown or file otherwise), sha256, pinned legal
  versions, status (`draft`, `sent`, `viewed`, `signed`, `declined`, `void`), offer lines,
  totals in cents, valid until, invoice fields (Exact id, number, due, paid, payment URL).
- `account_document_field`: document, page, position and size, kind (`signature`,
  `initials`, `name`, `role`, `date`, `text`, `checkbox`), label, required, signer role.
- `account_signature`: insert only; document, signer, field values, signature image and its
  sha256, how it was made (`drawn`, `typed`, `uploaded`), email, organisation, sha256 of the
  unsigned document, time, IP, user agent, confirmation text, signed PDF.
- `legal_text`: kind (`terms`, `sla`, `dpa`), version, dated, body, sha256, source URL.
- `account_task`: org, title, body, kind (`sign`, `billing_details`, `upload`, `generic`),
  linked document, locked until (a document signed), due, status (`locked`, `open`,
  `submitted`, `done`, `changes_requested`, `withdrawn`), response, reviewer, next reminder.
- `account_ticket`, `account_ticket_message`: questions and answers.
- `account_event`: the organisation's timeline.
- `billing_account` gains `kvk_number`, `kbo_number`, `billing_email`, `po_number`,
  `peppol_id`. `organisation` gains `account_stage` and `origin_pricing_configuration_id`.

## API (package `@dembrane/accounts`)

Customer (org admins and billing role), `/api/v2/orgs/:orgId/account`: the page in one read
(tasks, documents, billing details, tickets), document read, viewed, sign, decline, PDF;
billing details update; task submit; tickets open and reply; booking recorded.

Staff and sam, `/api/v2/admin/accounts`: list and card; push an offer from lines and a
template; push any document; create, approve, send back and withdraw tasks; reply to
tickets; upsert invoices (sam, keyed on the Exact id); set stage. sam uses a staff API key,
and sam's skills call these (push offer, push document, push task).

Events out: `account.document.signed`, `account.document.declined`,
`account.billing_details.updated`, `account.task.submitted`, `account.ticket.opened`.
Slack: a signature, submitted billing details and a new question post to the configured
channel webhook.

## Screens

- Customer: one page inside the organisation. At the top, the next steps (open tasks, the
  locked billing task greyed out). Below, a documents table (offers, signed PDFs, invoices
  with bank details), billing details, questions and answers, and "Book a call" (the
  existing cal.com step). Signing is its own screen, opened from the task: the document with its fields, a
  guided Next button, and the signature drawn, typed or uploaded.
- Staff: an Accounts tab in the admin console, a bounded table; a row opens the
  organisation card (stage, needs form answers, demo link, timeline, documents, tasks,
  questions, billing details), and the field editor for sending a PDF to sign.

## Demo

`preview` carries a fictional customer, "Gemeente Voorbeeldstad", with a synthetic demo, a
sent subscription offer, the "Review and sign the offer" task, the locked billing task, a
question and a timeline. `sameer+28sep@dembrane.com` is its admin,
`sameer+28sep-staff@dembrane.com` is staff. `bun run seed:accounts-demo` rebuilds it.
