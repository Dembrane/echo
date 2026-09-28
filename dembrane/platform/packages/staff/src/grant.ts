import type { StaffAudit } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

const { directus_users, directus_roles, directus_access, directus_policies, directus_settings } =
  schema;

/** The role that makes a user staff: apps/api's principal lookup reads exactly this name. */
export const STAFF_ROLE = "Administrator";
export const STAFF_DOMAIN = "@dembrane.com";

export class GrantError extends Error {}

/**
 * Staff are the users whose Directus role is Administrator: every named staff permission
 * follows from it (access/staff.ts) and the API reads it on each request, so a change holds
 * from the next call. No route grants staff; this runs from the CLI with the database login,
 * and each change is recorded in staff_audit_event under the staff member who made it.
 */
export function staffGrants(db: Db, audit: StaffAudit) {
  const byEmail = async (email: string) => {
    const [row] = await db
      .select({
        id: directus_users.id,
        email: directus_users.email,
        status: directus_users.status,
        role: directus_roles.name,
      })
      .from(directus_users)
      .leftJoin(directus_roles, eq(directus_roles.id, directus_users.role))
      .where(sql`lower(${directus_users.email}) = ${email.trim().toLowerCase()}`)
      .limit(1);
    if (!row) throw new GrantError(`no user ${email}`);
    return row;
  };

  const actor = async (email: string) => {
    const by = await byEmail(email);
    if (by.role !== STAFF_ROLE) throw new GrantError(`--by ${email} is not staff`);
    return { directusUserId: by.id, isStaff: true };
  };

  const roleId = async (name: string) => {
    const [row] = await db
      .select({ id: directus_roles.id })
      .from(directus_roles)
      .where(eq(directus_roles.name, name))
      .limit(1);
    return row?.id ?? null;
  };

  return {
    /** Everyone who passes the staff gate, plus old direct admin-policy grants the gate ignores. */
    async list() {
      const staff = await db
        .select({ id: directus_users.id, email: directus_users.email })
        .from(directus_users)
        .innerJoin(directus_roles, eq(directus_roles.id, directus_users.role))
        .where(eq(directus_roles.name, STAFF_ROLE))
        .orderBy(asc(directus_users.email));
      const direct = await db
        .select({ id: directus_users.id, email: directus_users.email })
        .from(directus_access)
        .innerJoin(directus_policies, eq(directus_policies.id, directus_access.policy))
        .innerJoin(directus_users, eq(directus_users.id, directus_access.user))
        .where(and(eq(directus_policies.admin_access, true), isNotNull(directus_access.user)))
        .orderBy(asc(directus_users.email));
      return { staff, directPolicyOnly: direct.filter((d) => !staff.some((s) => s.id === d.id)) };
    },

    async grant(email: string, by: string) {
      if (!email.trim().toLowerCase().endsWith(STAFF_DOMAIN))
        throw new GrantError(`staff must have a ${STAFF_DOMAIN} address`);
      const who = await actor(by);
      const user = await byEmail(email);
      if (user.status !== "active") throw new GrantError(`${email} is ${user.status}`);
      if (user.role === STAFF_ROLE) return { changed: false, userId: user.id };
      const admin = await roleId(STAFF_ROLE);
      if (!admin) throw new GrantError(`no ${STAFF_ROLE} role in this database`);
      await audit.record(who, {
        permission: "staff:grant",
        action: "staff.grant",
        targetType: "user",
        targetId: user.id,
        detail: { from_role: user.role },
      });
      await db.update(directus_users).set({ role: admin }).where(eq(directus_users.id, user.id));
      return { changed: true, userId: user.id };
    },

    /**
     * Back to the public signup role (Basic User on prod), and any admin policy attached to
     * the user directly is detached, so no older Directus-era grant keeps them staff anywhere.
     */
    async revoke(email: string, by: string) {
      const who = await actor(by);
      const user = await byEmail(email);
      if (user.id === who.directusUserId) throw new GrantError("staff cannot revoke themselves");
      const admins = await db
        .select({ id: directus_policies.id })
        .from(directus_policies)
        .where(eq(directus_policies.admin_access, true));
      const direct = admins.length
        ? await db
            .select({ id: directus_access.id })
            .from(directus_access)
            .where(
              and(
                eq(directus_access.user, user.id),
                inArray(
                  directus_access.policy,
                  admins.map((a) => a.id),
                ),
              ),
            )
        : [];
      if (user.role !== STAFF_ROLE && !direct.length) return { changed: false, userId: user.id };
      const [settings] = await db
        .select({ role: directus_settings.public_registration_role })
        .from(directus_settings)
        .limit(1);
      await audit.record(who, {
        permission: "staff:grant",
        action: "staff.revoke",
        targetType: "user",
        targetId: user.id,
        detail: { from_role: user.role, direct_policies: direct.length },
      });
      await db.transaction(async (tx) => {
        if (user.role === STAFF_ROLE)
          await tx
            .update(directus_users)
            .set({ role: settings?.role ?? null })
            .where(eq(directus_users.id, user.id));
        if (direct.length)
          await tx.delete(directus_access).where(
            inArray(
              directus_access.id,
              direct.map((d) => d.id),
            ),
          );
      });
      return { changed: true, userId: user.id };
    },
  };
}
