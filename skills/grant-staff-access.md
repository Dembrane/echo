# Skill: Grant Staff Access

Give a dembrane user access to the staff dashboard (the "Staff" item in the user menu, plus the `/v2/admin/*` backend surface).

## How the gate works

Verify against the current prod release tag before acting (`git tag --sort=-creatordate | head -1`), but as of v2.0.5:

- The frontend shows the staff surface when `meV2.is_staff` is true (`echo/frontend/src/features/sidebar/shell/UserMenu.tsx`).
- The backend sets `is_staff` from the Directus JWT `admin_access` claim (`echo/server/dembrane/api/dependency_auth.py`), and `/v2/admin/*` gates on the same claim.
- Directus sets `admin_access: true` in the JWT when any policy with `admin_access = true` is attached to the user — via their role, or directly via a `directus_access` row.

Prod has exactly one such policy: **Administrator** (`5d44a9e0-3f7c-4992-bacb-f55a6f9bfd51`).

## ⚠️ What this actually grants

There is no staff-only policy yet — the staff gate IS the admin claim. Granting it gives **full Directus admin**: Data Studio app access and read/write on every collection, not just the dashboard. Storage-backed staff policies are planned but not built (see the comment in `echo/server/dembrane/api/v2/__init__.py`).

Confirm with Sameer before granting anyone new.

## Grant pattern

Attach the Administrator policy directly to the user in `directus_access`, keeping their role (Basic User) unchanged. Do NOT switch the user's role to Administrator.

Connect to prod Postgres via `doctl` + the `postgres:16-alpine` container (no local psql — see `doctl databases list` for the cluster id; prod is `dbr-echo-prod-postgres`).

```bash
PGURI=$(doctl databases connection <prod-cluster-id> --format URI --no-header)
podman run --rm docker.io/library/postgres:16-alpine psql "$PGURI" -c "..."
```

```sql
-- 1. Look up the user and the policy (don't trust hardcoded ids across environments)
SELECT id, email, role, status FROM directus_users WHERE email = '<email>';
SELECT id, name FROM directus_policies WHERE admin_access = true;

-- 2. Grant (idempotent)
INSERT INTO directus_access (id, role, "user", policy, sort)
SELECT gen_random_uuid(), NULL, '<user-id>', '<admin-policy-id>', 1
WHERE NOT EXISTS (
  SELECT 1 FROM directus_access
  WHERE "user" = '<user-id>' AND policy = '<admin-policy-id>'
)
RETURNING id;

-- 3. Verify: list all per-user grants
SELECT a.id, u.email, p.name AS policy, p.admin_access
FROM directus_access a
JOIN directus_users u ON u.id = a."user"
JOIN directus_policies p ON p.id = a.policy
ORDER BY u.email;
```

## Revoke pattern

```sql
DELETE FROM directus_access
WHERE "user" = '<user-id>' AND policy = '<admin-policy-id>' AND role IS NULL;
```

## After granting

- The claim lands in newly issued tokens: the user must **log out and back in** (or wait ~15 min for a token refresh).
- If the Staff item still doesn't appear after a re-login, Directus may be serving a stale permissions cache (raw SQL bypasses Directus's cache invalidation) — flush the Directus cache.

## Audit

Per-user grants are visible with the verify query above. Users with the full Administrator *role* (service accounts like `admin@`, `mcp@`, plus any bootstrap/migration users) also pass the gate — check `directus_users.role` joined to `directus_roles` when auditing who has staff access.
