import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import type { Signed } from "./deps";

const STAFF_ROLE = "Administrator";

/**
 * Maps a Better Auth user (same id as directus_users) to the app_user id memberships
 * use, and whether they are staff. A user who never onboarded has no app_user row but is
 * still signed in. Staff comes from the Directus Administrator role until named staff
 * permissions replace the blanket flag. A suspended or archived user has no principal,
 * whatever sessions they still hold: suspension set outside the API (Directus, SQL)
 * would otherwise leave those sessions working until they expire.
 */
export function principalLookup(db: Db) {
  return async (userId: string): Promise<Signed | null> => {
    const [row] = await db
      .select({
        appUserId: schema.app_user.id,
        roleName: schema.directus_roles.name,
        status: schema.directus_users.status,
      })
      .from(schema.directus_users)
      .leftJoin(schema.app_user, eq(schema.app_user.directus_user_id, schema.directus_users.id))
      .leftJoin(schema.directus_roles, eq(schema.directus_roles.id, schema.directus_users.role))
      .where(eq(schema.directus_users.id, userId))
      .limit(1);
    if (!row || row.status === "suspended" || row.status === "archived") return null;
    return {
      appUserId: row.appUserId,
      directusUserId: userId,
      isStaff: row.roleName === STAFF_ROLE,
    };
  };
}
