---
name: grant-staff-access
description: Give a dembrane team member staff access (the Staff console and every /api/v2/admin route), take it away, or list who has it.
---

# Grant staff access

## What it grants

Staff are the users whose role is Administrator. That role holds every named staff permission (`echo/platform/packages/access/src/staff.ts`): billing, tiers, workspaces, support access, training, feedback, customer accounts, announcements, privacy (export and erase any person) and minting staff API keys. Every use is recorded in `staff_audit_event`. It is broad: confirm with Sameer before granting anyone new.

No route can make someone staff. It needs the database login of the environment.

## Commands

From `echo/platform`, with `DATABASE_URL` for the target environment:

```sh
bun run staff:access list
bun run staff:access grant <email> --by <your-staff-email>
bun run staff:access revoke <email> --by <your-staff-email>
```

- Only `@dembrane.com` addresses can be granted, and only an active account.
- `--by` must already be staff; the change is audited under them (`permission = 'staff:grant'`).
- Revoke puts the user back on the public signup role and detaches any admin policy attached to them directly (older Directus-era grants). Nobody can revoke themselves.
- `list` also shows `policy-only` users: a direct admin policy from the Directus era that no longer makes them staff. Revoke them to clean up.

## After

It holds from their next request; no new sign-in needed. Check with their session or key:

```sh
curl -sf -H "Authorization: Bearer $KEY" https://api.dembrane.com/api/v2/me | jq .is_staff
```

A revoked user's staff API keys stop passing staff checks at once. Delete them too: `DATABASE_URL=... bun run accounts:staff-key revoke <label>`.
