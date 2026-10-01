import type postgres from "postgres";

/**
 * Copies Directus identities into Better Auth's tables. Idempotent: runs with every
 * migration job until cutover, so users created through Directus in the meantime can sign
 * in to the new stack with the same password or Google account. Suspended users are left
 * out, and a user already present is never overwritten.
 */
export async function syncIdentitiesFromDirectus(
  sql: postgres.Sql,
): Promise<{ users: number; accounts: number }> {
  const users = await sql`
    insert into auth_user (id, name, email, email_verified, created_at, updated_at)
    select d.id,
           coalesce(nullif(trim(concat_ws(' ', d.first_name, d.last_name)), ''), split_part(d.email, '@', 1)),
           lower(d.email), true, now(), now()
    from directus_users d
    where d.email is not null and d.status = 'active'
    on conflict do nothing
    returning id`;
  const passwords = await sql`
    insert into auth_account (id, user_id, account_id, provider_id, password, created_at, updated_at)
    select gen_random_uuid(), d.id, d.id::text, 'credential', d.password, now(), now()
    from directus_users d
    join auth_user u on u.id = d.id
    where d.password is not null and d.password like '$argon2%'
      and not exists (select 1 from auth_account a where a.user_id = d.id and a.provider_id = 'credential')
    returning id`;
  const google = await sql`
    insert into auth_account (id, user_id, account_id, provider_id, created_at, updated_at)
    select gen_random_uuid(), d.id, d.external_identifier, 'google', now(), now()
    from directus_users d
    join auth_user u on u.id = d.id
    where d.provider = 'google' and d.external_identifier is not null
      and not exists (select 1 from auth_account a where a.user_id = d.id and a.provider_id = 'google')
    returning id`;
  return { users: users.length, accounts: passwords.length + google.length };
}
