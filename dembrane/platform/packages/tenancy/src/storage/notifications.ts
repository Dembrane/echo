import { schema } from "@dembrane/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Conn } from "../db";

const { notification, project, directus_users, directus_roles, app_user, org_membership } = schema;

export async function insertNotification(db: Conn, row: typeof notification.$inferInsert) {
  await db.insert(notification).values(row);
}

export async function projectName(db: Conn, id: string) {
  const [p] = await db
    .select({ name: project.name })
    .from(project)
    .where(eq(project.id, id))
    .limit(1);
  return p?.name ?? null;
}

/** app_user ids of the org's admins and owners, in primary key order. */
export async function orgAdminIds(db: Conn, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ user_id: org_membership.user_id })
    .from(org_membership)
    .where(
      and(
        eq(org_membership.org_id, orgId),
        inArray(org_membership.role, ["admin", "owner"]),
        isNull(org_membership.deleted_at),
      ),
    )
    .orderBy(asc(org_membership.id));
  return rows.map((r) => r.user_id);
}

/**
 * app_user ids of staff, in primary key order. Staff is the Directus Administrator role, the
 * same rule the API's principal lookup applies.
 */
export async function staffAppUserIds(db: Conn): Promise<string[]> {
  const rows = await db
    .select({ id: app_user.id })
    .from(app_user)
    .innerJoin(directus_users, eq(directus_users.id, app_user.directus_user_id))
    .innerJoin(directus_roles, eq(directus_roles.id, directus_users.role))
    .where(eq(directus_roles.name, "Administrator"))
    .orderBy(asc(app_user.id));
  return rows.map((r) => r.id);
}
