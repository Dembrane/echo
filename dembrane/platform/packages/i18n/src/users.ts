import { type Db, schema } from "@dembrane/db";
import { eq, inArray, sql } from "drizzle-orm";
import { type Locale, resolveLocale } from "./runtime";

/**
 * Where a person's language comes from: the dashboard's language setting on their user
 * (directus_users.language, what the frontend shows them in). Null when they have no
 * account or never chose one, so the caller falls back to the inviter's or the
 * organisation's language.
 */

type Conn = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
const { app_user, directus_users } = schema;

export async function localeOfEmail(db: Conn, email: string): Promise<Locale | null> {
  const [row] = await db
    .select({ language: directus_users.language })
    .from(directus_users)
    .where(eq(sql`lower(${directus_users.email})`, email.trim().toLowerCase()))
    .limit(1);
  return row?.language ? resolveLocale(row.language) : null;
}

/** Each app user's language, by app user id; users without one are left out. */
export async function localesOfAppUsers(
  db: Conn,
  appUserIds: readonly string[],
): Promise<Map<string, Locale>> {
  const ids = [...new Set(appUserIds)];
  const out = new Map<string, Locale>();
  if (!ids.length) return out;
  const rows = await db
    .select({ id: app_user.id, language: directus_users.language })
    .from(app_user)
    .innerJoin(directus_users, eq(directus_users.id, app_user.directus_user_id))
    .where(inArray(app_user.id, ids));
  for (const r of rows) if (r.language) out.set(r.id, resolveLocale(r.language));
  return out;
}
