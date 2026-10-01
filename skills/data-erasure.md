---
name: data-erasure
description: Erase a person's account and personal data. Use for GDPR/AVG erasure requests ("verwijder mijn gegevens", "artikel 17", "delete my account") and to purge accounts suspended by the in-app "delete account" button, which promises a purge within 30 days.
---

# Data erasure

Irreversible. A person confirms the final call; an agent runs the dry run and prepares everything up to it. Needs a staff API key (see `data-export.md`).

```sh
API=https://api.dembrane.com
H=(-H "Authorization: Bearer $DEMBRANE_STAFF_KEY" -H "content-type: application/json")
EMAIL=person@example.org
```

## 1. Find who is waiting

Emailed requests: the sender must be the account's registered address. In-app requests suspend sign-in at once; list the ones not yet purged (no route for this, so SQL with the database login):

```sh
psql "$DATABASE_URL" -c "select email, description from directus_users where status = 'suspended' and description like 'deletion requested%' order by description"
```

Offer an export first if they asked for a copy too (`data-export.md`).

## 2. Dry run

```sh
curl -sf "${H[@]}" -X POST "$API/api/v2/admin/people/erase" -d "{\"email\":\"$EMAIL\"}" | jq
```

It changes nothing and returns `blockers`, `sole_admin_orgs`, what `removes` and what `keeps`.

## 3. Clear what blocks it

- Staff: revoke first (`grant-staff-access.md`).
- `sole_admin_orgs`: they are the last owner or admin of a live organisation. Ask them to hand it over, or get a person's decision that the organisation may be left without one (`"allow_orphan_orgs": true`).

## 4. Erase

```sh
curl -sf "${H[@]}" -X POST "$API/api/v2/admin/people/erase" \
  -d "{\"email\":\"$EMAIL\",\"dry_run\":false,\"confirm_email\":\"$EMAIL\"}" | jq
```

Removed, in one transaction: the sign-in identity, sessions, sign-in methods and 2FA; the profile and every membership; notifications, private chats, connected assistants and what they remembered; invites, pricing requests, support requests and report subscriptions for the address; the avatar and logo files; every earlier export zip.

Kept, and why:

- Signatures and the documents they sign. They are legal evidence of an agreement (GDPR art. 17(3)(b) and (e)), and the database refuses to change or delete them (an insert-only trigger). They keep the signer's name, email and IP as signed.
- Audit rows (staff, assistant, account timeline). They keep only the user id, which no longer resolves to anyone.
- What they made inside an organisation's workspaces: projects, shared chats, webhooks. It is that organisation's data; the rows lose their author.
- Conversations they took part in as a participant (`keeps.conversations_as_participant`). The workspace's organisation controls them. Tell the requester to ask that organisation, or forward the request to its admin.

## 5. Close

- Draft the confirmation reply: what was erased, what was kept and why. A person sends it.
- Attio: a note with the date and what was erased. No copies of the erased data.
- The erasure itself is in `staff_audit_event` (`action = 'person.erase'`) under the user id, without the email.
