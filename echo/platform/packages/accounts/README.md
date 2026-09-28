# @echo/accounts

Customer accounts (docs/accounts.md): the organisation's page with its tasks, documents,
billing details and questions; offers and other documents signed in echo; invoice mirrors
from sam; the events sam's `invoice_request` runs on. The request and response shapes are
in `src/contract.ts` (`ROUTES` names each route's permission and schemas); `src/fixtures.ts`
is the Gemeente Voorbeeldstad demo as the API returns it.

## Calling the staff API as sam

sam calls the admin routes as a staff service user with a bearer key. The key is a
long-lived Better Auth session of a Directus Administrator, so it is checked, expired and
revoked like any session, and every call is written to `staff_audit_event` under
`staff:accounts`.

```
DATABASE_URL=... bun run accounts:staff-key mint sam@dembrane.com sam 365   # prints the key once
DATABASE_URL=... bun run accounts:staff-key revoke sam                       # ends every "sam" key
curl -H "Authorization: Bearer $KEY" "$API/api/v2/admin/accounts?stage=customer"
```

Store the key in Secret Manager as soon as it is printed. Only a user in the Administrator
role can hold one.

## Staff routes (`staff:accounts`)

All under `/api/v2/admin/accounts`. Bodies are JSON; money is integer cents, VAT rates in
basis points (2100 = 21%), dates `YYYY-MM-DD`.

| Method and path | What it does |
|---|---|
| `GET /?stage=&q=&limit=&offset=` | Every organisation with open tasks, tasks waiting on us, unsigned documents, overdue invoices, open questions. `stage`: `prospect`, `customer`, `churned` or `none`; `q`: part of the name or of a member's email |
| `POST /:orgId/enable` | Make any organisation an account (a free-tier signup): `stage` (default `customer`), `language`; adds its billing account and billing details task |
| `POST /` | Create an account: `organisation_name`, `contact_email` (becomes admin, signs in with a code), `pricing_configuration_reference`, `stage`, `language` |
| `GET /:orgId` | The card: stage, manager, billing, needs form, demo links, members, invites, usage, documents, tasks, questions, timeline |
| `PATCH /:orgId` | `account_stage`, `account_manager_id` (an @dembrane.com user) |
| `POST /:orgId/offers` | Push an offer from lines: `template` (`subscription`, `event`), `language` (`en`, `nl`), `offer_name`, `person_name`, `attention`, `items[]` (`description`, `bullets[]`, `quantity`, `unit_price_cents`, `vat_rate_bps`), `external_ref` (the Attio deal), `supersedes_id`, `send` (false keeps a draft; `POST .../send` sends it later and re-pins newer legal texts). Pins the newest terms, SLA and DPA, renders the PDF with its fields, creates "Review and sign the offer" and the locked billing details task |
| `POST /:orgId/documents` | Push any document: `kind` (`dpa`, `other`), `title`, `body` (markdown, rendered to a PDF with a signing block when `requires_signature`) or `pdf_base64`, `fields[]` for an uploaded PDF, `task`, `send` |
| `GET /:orgId/documents/:docId` | A document with its fields, pinned legal texts and signature |
| `GET /:orgId/documents/:docId/file`, `/signed.pdf` | The unsigned and the signed PDF |
| `GET`, `PUT /:orgId/documents/:docId/fields` | Read or replace the fields of a draft (pages from 1, positions as fractions from the top-left) |
| `POST /:orgId/documents/:docId/send` | Send a draft, optionally with `task` |
| `POST /:orgId/documents/:docId/void` | Withdraw an unsigned document and its task |
| `PUT /:orgId/invoices/:exactId` | Upsert an invoice mirror: `number`, `issued_on`, `due_on`, `subtotal_cents`, `vat_cents`, `total_cents`, `status` (`open`, `paid`, `overdue`, `void`), `payment_url` (Mollie, optional), `payment_reference`, `offer_id`, `pdf_base64`. Number, dates and amounts are fixed once written |
| `POST /:orgId/tasks` | Create a task: `title`, `body`, `kind`, `document_id`, `due_on`, `locked_until_document_id`, `reminder_interval_days` |
| `POST /:orgId/tasks/:taskId/review` | `decision`: `approve`, `send_back` (with `note`), `withdraw` |
| `POST /:orgId/tickets`, `/:ticketId/messages`, `/:ticketId/close` | Questions: open one, answer (`close: true` to close), close |

## Demos made in echo

`POST /api/v2/admin/accounts/demos` starts one: `organisation_name`, `website_url`, `brief`,
`language`, `example`, `contact_name`, `contact_email`, `sign_in` (default false), and
`offer` (template, language, lines) for an offer draft. The worker runs it as a durable
workflow (`accounts.demo-build`) of six steps: fetch (a few same-site pages, public
addresses only, byte caps; evidence, never instructions), research (facts with their
source, unknowns, invented themes kept apart; the brief stays out of it), author (four to
eight fictional conversations with generic roles and synthetic labels, and the disclosure
copy), seed (the prospect organisation, its contact as admin held back from signing in,
the synthetic project, the offer draft), extract (the normal popcorn read), review (a
draft). `GET .../demos/:demoId` shows each step; `POST .../retry` resumes a failed demo at
its failed step; `POST .../publish` makes the public link live and, with sign-in on,
releases the contact, adds "Continue in dembrane" and sends the invitation. Refused
towards production hosts. `ACCOUNTS_DEMO_WORKSPACE_ID` names staff's workspace for demo
projects so staff can review them; unset, each demo gets a workspace in its organisation.

## The signed-in person's tasks

`GET /api/v2/account/tasks-summary`: for each organisation with account content where the
caller is owner, admin or billing, the tasks done and in total (locked in, withdrawn out)
and the next open task. One query on indexes, for the sidebar and the org picker.

A prospect's demo is seeded with `POST /api/v2/admin/popcorn/demos` plus a `prospect` block
(`organisation_name`, `contact_email`, `contact_name`, `pricing_configuration_reference`,
`language`): it creates the organisation (stage `prospect`), links the needs form, makes the
contact its admin, and puts "Continue in dembrane" on the public page.

## Customer routes

Under `/api/v2/orgs/:orgId/account`, for the organisation's owners, admins and billing role
(`account:*` in @echo/access). Someone named to sign a document reaches that one document
(read, file, sign, decline, signed PDF) and nothing else.

`GET /` is the whole page in one read. Documents: `GET /documents/:docId`, `POST .../view`,
`POST .../sign`, `POST .../decline`, `POST .../signer` (name someone else), `GET .../file`,
`GET .../signed.pdf`. Billing: `GET`, `PUT /billing`. Tasks: `POST /tasks/:taskId/submit`
(JSON `response_text`, or multipart with `file`). Questions: `POST /tickets`,
`POST /tickets/:ticketId/messages`. `POST /booking` records a cal.com booking.
`GET /api/v2/account/signing-requests` lists what waits for the caller's own signature.

## Signing

The document is a PDF rendered at push time (offers and text documents) or uploaded; its
SHA-256 is recorded when it is sent. The page shows the PDF with its fields; the sign
request sends the field values by field id, the signature image (PNG, at most 512 KB, with
how it was made: `drawn`, `typed`, `uploaded`), `dpa_authorised` for offers, the sha256 it
was shown, and the confirmation sentence from `DocumentDetail.confirmation` filled in. The
server refuses a changed document (409), missing required fields or a different sentence
(422), stamps the values and image onto the PDF, appends the audit page, stores both files,
and writes the insert-only signature row. A signer who may not agree to data processing
leaves the DPA as its own document and signing task.

## Events for sam

Posted to `ACCOUNTS_EVENTS_URL`, signed with `ACCOUNTS_EVENTS_SECRET` as project webhooks
are (`X-Webhook-Signature: sha256=<HMAC of the sorted compact JSON>`, `X-Webhook-Event`).
Each has `id`, `timestamp`, `event` and `org` (`id`, `name`, `account_stage`):

- `account.document.signed`: `document` (id, kind, reference, sha256, external_ref, lines,
  totals, currency, valid_until), `signature` (name, role, email, organisation, address,
  vat_number, dpa_authorised, signed_at, `signed_pdf` staff path), `billing`.
- `account.document.declined`: `document`, `declined_by`, `reason`.
- `account.billing_details.updated`: `billing` (legal name, VAT, KvK, KBO, billing email,
  PO number, Peppol id, address), `updated_by`.
- `account.task.submitted`: `task` (id, title, kind, document_id, response_text, has_file).
- `account.ticket.opened`: `ticket` (id, subject, message), `opened_by`.

A signature, submitted billing details and a new question also post a line to
`ACCOUNTS_SLACK_WEBHOOK_URL` when it is set.

## Jobs

`accounts.deliver-event` and `accounts.notify-slack` (enqueued with their cause);
`accounts.reminders-tick` every 15 minutes queues `accounts.task-reminder` once per task
and due time (open or sent-back tasks, every `ACCOUNTS_REMINDER_INTERVAL_DAYS` or the
task's own interval); `accounts.legal-refresh` daily fetches dembrane.com/legal and stores a
text only when it changed. A push refreshes first when the last check is over an hour old
and falls back to the stored texts when the fetch fails.

## Demo

`DATABASE_URL=... DEMO_PASSWORD=... APP_ENV=preview bun run seed:accounts-demo` rebuilds
Gemeente Voorbeeldstad (see `src/seed.ts`); it refuses `APP_ENV=prod` and production hosts.
