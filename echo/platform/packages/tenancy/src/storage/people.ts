import { schema } from "@echo/db";
import { asc, eq, inArray } from "drizzle-orm";
import { type Conn, isUuid } from "../db";

const { app_user, directus_users } = schema;

export interface AppUserRow {
  id: string;
  directus_user_id: string | null;
  display_name: string | null;
  email: string | null;
}

const appUserFields = {
  id: app_user.id,
  directus_user_id: app_user.directus_user_id,
  display_name: app_user.display_name,
  email: app_user.email,
};

export async function appUser(db: Conn, id: string): Promise<AppUserRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select(appUserFields).from(app_user).where(eq(app_user.id, id)).limit(1);
  return row ?? null;
}

/** In primary key order, as Directus returned an unsorted `_in` read. */
export async function appUsersByIds(db: Conn, ids: readonly string[], limit?: number) {
  const valid = [...new Set(ids.filter(isUuid))];
  if (!valid.length) return [];
  const q = db
    .select(appUserFields)
    .from(app_user)
    .where(inArray(app_user.id, valid))
    .orderBy(asc(app_user.id));
  return limit === undefined ? q : q.limit(limit);
}

export async function appUserByEmail(db: Conn, email: string): Promise<AppUserRow | null> {
  const [row] = await db
    .select(appUserFields)
    .from(app_user)
    .where(eq(app_user.email, email))
    .orderBy(asc(app_user.id))
    .limit(1);
  return row ?? null;
}

export async function appUserByDirectusId(db: Conn, directusId: string) {
  const [row] = await db
    .select(appUserFields)
    .from(app_user)
    .where(eq(app_user.directus_user_id, directusId))
    .limit(1);
  return row ?? null;
}

/** directus_users.id to avatar file id, for the avatar bubbles. */
export async function avatars(db: Conn, directusIds: readonly (string | null | undefined)[]) {
  const ids = [...new Set(directusIds.filter(isUuid))];
  if (!ids.length) return new Map<string, string | null>();
  const rows = await db
    .select({ id: directus_users.id, avatar: directus_users.avatar })
    .from(directus_users)
    .where(inArray(directus_users.id, ids));
  return new Map(rows.map((r) => [r.id, r.avatar]));
}

/** Exact, case-sensitive match, as a Directus `_eq` filter on directus_users.email. */
export async function directusUserByEmail(db: Conn, email: string) {
  const [row] = await db
    .select({ id: directus_users.id, email: directus_users.email })
    .from(directus_users)
    .where(eq(directus_users.email, email))
    .orderBy(asc(directus_users.id))
    .limit(1);
  return row ?? null;
}
