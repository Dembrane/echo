import { randomBytes } from "node:crypto";
import { newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, eq, like, sql } from "drizzle-orm";

/** The label prefix that marks a session as a staff API key. */
export const KEY_AGENT = "staff-api-key:";

/**
 * A staff API key is a long-lived Better Auth session of a staff service user, presented
 * as `Authorization: Bearer <key>` (the bearer plugin is on). The key is the session
 * token, so it is checked, expired and revoked like any session, and every use is a staff
 * action recorded in staff_audit_event. Only Directus Administrators may hold one.
 */
export async function mintStaffKey(
  db: Db,
  email: string,
  label: string,
  opts: { days?: number; now?: Date } = {},
): Promise<{ key: string; userId: string; expiresAt: Date }> {
  if (!/^[a-z0-9-]{2,40}$/.test(label))
    throw new Error("label: 2-40 lowercase letters, digits, dashes");
  const [user] = await db
    .select({ id: schema.auth_user.id, role: schema.directus_roles.name })
    .from(schema.auth_user)
    .leftJoin(schema.directus_users, eq(schema.directus_users.id, schema.auth_user.id))
    .leftJoin(schema.directus_roles, eq(schema.directus_roles.id, schema.directus_users.role))
    .where(sql`lower(${schema.auth_user.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  if (!user) throw new Error(`no user ${email}`);
  if (user.role !== "Administrator") throw new Error(`${email} is not staff (Administrator role)`);
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (opts.days ?? 365) * 86_400_000);
  const key = randomBytes(32).toString("base64url");
  await db.insert(schema.auth_session).values({
    id: newId(),
    userId: user.id,
    token: key,
    expiresAt,
    userAgent: `${KEY_AGENT}${label}`,
    createdAt: now,
    updatedAt: now,
  });
  return { key, userId: user.id, expiresAt };
}

/** Revokes every key with this label; returns how many. */
export async function revokeStaffKeys(db: Db, label: string): Promise<number> {
  const gone = await db
    .delete(schema.auth_session)
    .where(and(like(schema.auth_session.userAgent, `${KEY_AGENT}${label}`)))
    .returning({ id: schema.auth_session.id });
  return gone.length;
}
