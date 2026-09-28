# Customer accounts

The customer's organisation in echo is where everything between dembrane and that customer
lives: what to sign, what to do next, invoices and how to pay them, billing details,
questions, and a call with us. Staff run it from one card per organisation. sam drives the
same operations through the same API. Echo owns this data; Attio holds the relationship,
Exact the books, sam's ops objects the process (see sam PR #368, slice 1b).

## The flow

1. A prospect fills the needs form (`pricing_configuration`, WEB- or DEM- reference) and
   books a call through cal.com.
2. After the call, staff or sam seed a synthetic demo (`POST /api/v2/admin/popcorn/demos`)
   for them. Seeding for a prospect also creates their organisation (stage `prospect`),
   links the needs form row, and invites the contact. The public presentation link shows
   "Continue in dembrane", which signs them in with an emailed one-time code.
3. Staff push an offer, the SLA and the DPA. The customer reads and signs each in the app.
   Accepting the offer also confirms the billing details Exact needs (legal entity,
   KvK/VAT/KBO, billing email, PO number, Peppol id) and names the signer; a signer who is
   someone else gets their own one-time-code invitation to sign.
4. Signing emits `account.document.signed`; sam's `invoice_request` takes it from there,
   creates the invoice in Exact and writes a mirror back into echo. The customer sees it with
   a Mollie link when there is one, and bank transfer details always.
5. Staff set arbitrary tasks ("send us your PO", "upload the logo"), the customer completes
   them, staff approve or send back. Questions go through support tickets.

## Signing

Built into echo, no DocuSeal. A simple electronic signature under eIDAS: the signer is
signed in with a verified email (one-time code), reads the exact version, types their name
and role, and confirms they may sign for the named legal entity. The signature row stores
the document's SHA-256, time, IP, user agent and the confirmation text shown, and is never
updated. Echo renders a signed PDF: the document plus an audit page. A signed version is
immutable; a change is a new version that is signed again.

## Data (new tables, expand only)

- `account_document`: org, kind (`offer`, `sla`, `dpa`, `other`), title, version, body
  (markdown) or file, sha256, status (`draft`, `sent`, `viewed`, `signed`, `declined`,
  `void`), offer lines and total in cents, currency, valid until, sent and viewed times.
- `account_signature`: document, signer user, typed name and role, email, legal entity,
  sha256 signed, time, IP, user agent, confirmation text, signed PDF file.
- `account_task`: org, title, body, kind (`generic`, `billing_details`, `sign`, `book_call`,
  `upload`), linked document, due, status (`open`, `submitted`, `approved`,
  `changes_requested`), response text and file, reviewer and note.
- `account_ticket`, `account_ticket_message`: subject, status (`open`, `waiting_on_customer`,
  `waiting_on_dembrane`, `closed`), messages from either side.
- `account_invoice`: org, Exact id, number, issued, due, amounts in cents, currency, status
  (`open`, `paid`, `overdue`, `void`), PDF, Mollie payment URL, payment reference.
- `account_event`: the organisation's timeline (who, what, when), shown on the staff card.
- `billing_account` gains `kvk_number`, `kbo_number`, `billing_email`, `po_number`,
  `peppol_id`. `organisation` gains `account_stage` (`prospect`, `customer`, `churned`) and
  `origin_pricing_configuration_id`.

## API (package `@echo/accounts`)

Customer, org admins and billing role, under `/api/v2/orgs/:orgId/account`: overview (next
steps, unsigned documents, open invoices), documents (list, read, mark viewed, sign,
decline, signed PDF), billing details (read, update), tasks (list, submit), tickets (list,
open, reply), invoices (list, PDF), booking (record a cal.com booking).

Staff and sam, under `/api/v2/admin/accounts`: list with stage, open tasks, unsigned
documents and overdue invoices; the card (everything above plus the needs form answers, the
demo link, members and usage); create and send documents from templates; void; create and
review tasks; reply to and close tickets; upsert invoice mirrors (sam, keyed on the Exact
id); set stage and account manager. sam calls these with a staff API key.

Events out through `@echo/webhooks`: `account.document.signed`, `account.document.declined`,
`account.billing_details.updated`, `account.task.submitted`, `account.ticket.opened`.

## Screens

Extend what people know; one decision per screen.

- Customer, organisation sidebar: **Billing** gains billing details and invoices.
  **Agreements** (new) lists offers, SLA and DPA; signing is its own screen. **Support**
  (new) holds tickets and "Book a call" (the existing cal.com step). **Next steps** from
  dembrane sit at the top of the organisation's landing page, each linking to where it is
  done.
- Staff, admin console: **Accounts** (new tab) is a bounded table of organisations; a row
  opens the organisation card.

## Demo

`preview` carries a fictional customer organisation with a synthetic demo, a sent offer, SLA
and DPA, a task, an open invoice and a ticket. `sameer+28sep@dembrane.com` is its admin;
`sameer+28sep-staff@dembrane.com` is staff. `bun run seed:accounts-demo` rebuilds it.
