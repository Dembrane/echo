import { randomBytes } from "node:crypto";
import { STAFF_POLICIES, type StaffPolicy } from "@dembrane/access";
import { newId } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { eq, like, or, sql } from "drizzle-orm";

/** The label prefix that marks a session as a staff API key. */
export const KEY_AGENT = "staff-api-key:";

/**
 * What a key may do when minted without a scope: the operational skills (customer
 * accounts, data subject requests, demos, announcements). Never support sessions,
 * billing, tiers or staff grants: a leaked key must not open customer data.
 */
export const KEY_DEFAULT_SCOPE: readonly StaffPolicy[] = [
  "staff:accounts",
  "staff:privacy",
  "staff:workspaces",
  "staff:announcements",
];

const DEFAULT_DAYS = 365;

export interface StaffKeyClaims {
  readonly label: string;
  /** Hard end of the key. Better Auth slides a used session's expiry; this does not move. */
  readonly until: Date;
  readonly scope: readonly StaffPolicy[];
}

/**
 * The claims a staff key session carries in its user agent, or null for any other
 * session. Keys minted before scopes existed read as the default scope, valid for a
 * year from creation.
 */
export function staffKeyClaims(
  userAgent: string | null | undefined,
  createdAt: Date,
): StaffKeyClaims | null {
  if (!userAgent?.startsWith(KEY_AGENT)) return null;
  const [label = "", ...parts] = userAgent.slice(KEY_AGENT.length).split("|");
  const fields = new Map(parts.map((p) => p.split("=", 2) as [string, string]));
  const until = fields.has("until")
    ? new Date(Number(fields.get("until")) * 1000)
    : new Date(createdAt.getTime() + DEFAULT_DAYS * 86_400_000);
  const scope = fields.has("scope")
    ? (fields.get("scope") ?? "")
        .split(",")
        .filter((p): p is StaffPolicy => (STAFF_POLICIES as readonly string[]).includes(p))
    : KEY_DEFAULT_SCOPE;
  return { label, until: Number.isNaN(until.getTime()) ? new Date(0) : until, scope };
}

/**
 * A staff API key is a long-lived Better Auth session of a staff service user, presented
 * as `Authorization: Bearer <key>` (the bearer plugin is on). The key is the session
 * token, so it is checked and revoked like any session; on top, the API holds it to its
 * own hard expiry and its scope of named staff permissions, never the whole staff set,
 * and every use is a staff action recorded in staff_audit_event. Only Directus
 * Administrators may hold one.
 */
export async function mintStaffKey(
  db: Db,
  email: string,
  label: string,
  opts: { days?: number; now?: Date; scope?: readonly StaffPolicy[] } = {},
): Promise<{ key: string; userId: string; expiresAt: Date; scope: readonly StaffPolicy[] }> {
  if (!/^[a-z0-9-]{2,40}$/.test(label))
    throw new Error("label: 2-40 lowercase letters, digits, dashes");
  const scope = opts.scope ?? KEY_DEFAULT_SCOPE;
  const unknown = scope.filter((p) => !(STAFF_POLICIES as readonly string[]).includes(p));
  if (unknown.length || !scope.length)
    throw new Error(`scope: unknown policies ${unknown.join(",")}`);
  if (scope.includes("staff:grant")) throw new Error("scope: a key never grants staff");
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
  const expiresAt = new Date(now.getTime() + (opts.days ?? DEFAULT_DAYS) * 86_400_000);
  const key = randomBytes(32).toString("base64url");
  await db.insert(schema.auth_session).values({
    id: newId(),
    userId: user.id,
    token: key,
    expiresAt,
    userAgent: `${KEY_AGENT}${label}|until=${Math.floor(expiresAt.getTime() / 1000)}|scope=${scope.join(",")}`,
    createdAt: now,
    updatedAt: now,
  });
  return { key, userId: user.id, expiresAt, scope };
}

/** Revokes every key with this label; returns how many. */
export async function revokeStaffKeys(db: Db, label: string): Promise<number> {
  const gone = await db
    .delete(schema.auth_session)
    .where(
      or(
        eq(schema.auth_session.userAgent, `${KEY_AGENT}${label}`),
        like(schema.auth_session.userAgent, `${KEY_AGENT}${label}|%`),
      ),
    )
    .returning({ id: schema.auth_session.id });
  return gone.length;
}
