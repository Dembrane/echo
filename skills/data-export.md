---
name: data-export
description: Prepare and deliver a copy of everything dembrane holds about one person. Use for GDPR/AVG access requests ("data opvraag", "artikel 15", "export my data", "copy of my recordings"). The legal deadline is one month from the request; aim for days.
---

# Data export

Needs a staff API key (see "Staff API key" at the end). All commands run from any shell with `curl` and `jq`.

```sh
API=https://api.dembrane.com
H=(-H "Authorization: Bearer $DEMBRANE_STAFF_KEY" -H "content-type: application/json")
EMAIL=person@example.org
```

## 1. Verify

The request must come from the account's registered email address. A matching sender is enough.

## 2. Understand why they asked

Requests rarely come from nowhere. Look at their PostHog trail (`distinct_id` is their email): caps hit, upgrade prompts, errors. The reply can then address the real problem, not only the request.

## 3. Export

```sh
curl -sf "${H[@]}" -X POST "$API/api/v2/admin/people/export" -d "{\"email\":\"$EMAIL\"}" | tee export.json | jq '{key, bytes, files, counts, expires_at}'
curl -sf -o export.zip "$(jq -r .download_url export.json)" && unzip -l export.zip
```

One zip, written to the file bucket at `exports/people/<user id>/<export id>.zip`: account, memberships, projects they created, the conversations in those projects and the ones they took part in by email (transcripts as text, audio as 7-day links), chats they started, documents they signed with the signed PDFs, notifications and audit rows, connected assistants, feedback, invites and pricing requests. Secrets (password hashes, session tokens, 2FA secrets) are never included. `README.md` in the zip is the customer-facing guide.

A 404 means no account uses that address. Tell them so; do not guess another address.

What goes into the package is a product decision: the Notion Decisions entry of 2026-07-13 ("data requests"). Read it before changing the contents.

## 4. Deliver

- `download_url` and the audio links inside work for 7 days. Run the export again for a fresh link; each run is a new file.
- Draft a personal reply from a real address: what is in the export and how long the link works. If step 2 surfaced friction, address it in the same email.
- A person sends it. Drafting is not sending.

## 5. Log

- Attio: a note on the person covering what was requested, what was delivered and when, linking the decision entry.
- The archive of exactly what was sent is the zip at `key`. Every export is also in `staff_audit_event` (`action = 'person.export'`, target the user id).

## Staff API key

A long-lived session of a staff user, minted once by someone with the database login and kept in Secret Manager:

```sh
cd echo/platform && DATABASE_URL=... bun run accounts:staff-key mint <staff-email> <label> [days]
```
