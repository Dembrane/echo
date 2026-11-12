---
name: account-email
description: Read the email between dembrane and one customer organisation, merged across the team's mailboxes and cleaned into chats, through echo's staff API. Use before a call, a follow-up or an offer to catch up on what was said by email. Read-only: replies happen in Gmail.
---

# Account email

echo reads the configured dembrane mailboxes live (Gmail, read-only), keeps the threads with someone of the organisation in them, merges the copies of one conversation across mailboxes and cuts the quoted history from every message. Nothing is stored. Needs a staff API key with `staff:accounts` (see `data-export.md`).

```sh
API=https://api.dembrane.com
H=(-H "Authorization: Bearer $DEMBRANE_STAFF_KEY")
```

## 1. Find the organisation

```sh
curl -sf "${H[@]}" "$API/api/v2/admin/accounts?q=gemeente&limit=20" | jq '.accounts[] | {id, name}'
ORG=<id>
```

Only organisations in echo have email: the match is on their members' own domains, plus the exact address of members at public providers (gmail.com and the like). An organisation with no members has none.

## 2. Read

```sh
curl -sf "${H[@]}" "$API/api/v2/admin/accounts/$ORG/email" | tee email.json \
  | jq '{matched, mailboxes, threads: [.threads[] | {subject, last_message_at, messages: (.messages | length)}]}'
```

Each thread, newest first, carries `messages` oldest first: `from` (`name`, `email`, `side`: `dembrane`, `organisation` or `other`), `sent_at`, and `text`, the part that message added. `gmail` lists the thread's link in each mailbox it lives in; hand that link to a person who wants to reply. `?refresh=true` skips the server's five-minute cache, for example right after someone replied.

A conversation as a transcript:

```sh
jq -r '.threads[0] | "# \(.subject)", (.messages[] | "\(.sent_at) \(.from.name // .from.email): \(.text)\n")' email.json
```

`mailboxes[].ok` false means that mailbox could not be read this time; say so rather than treating its mail as absent. A 503 `account_email.not_configured` means the environment has no Gmail service account yet.

## Care

This is the team's own correspondence. Use it for the account at hand, quote it only to dembrane people, and do not copy it into other tools or notes beyond what the task needs. Never send or draft mail from it: the route is read-only on purpose.
