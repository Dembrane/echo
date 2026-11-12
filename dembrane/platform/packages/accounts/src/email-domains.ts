import { schema } from "@dembrane/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Conn } from "./deps";

const { org_membership, app_user, auth_user } = schema;

/**
 * Mail providers anyone can sign up at: a shared address there says nothing about which
 * organisation someone belongs to. dembrane.com is ours: staff join customers' orgs.
 * The deals work (organisations and their duplicates) reads the same list.
 */
export const PUBLIC_MAIL_DOMAINS = new Set([
  "dembrane.com",
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.nl",
  "live.com",
  "live.nl",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "aol.com",
  "ziggo.nl",
  "kpnmail.nl",
  "kpnplanet.nl",
  "planet.nl",
  "hetnet.nl",
  "home.nl",
  "xs4all.nl",
  "casema.nl",
  "telenet.be",
  "skynet.be",
  "hotmail.be",
]);

/** The organisation's own domain of an address, or null for a public provider or junk. */
export const domainOf = (email: string | null | undefined): string | null => {
  const at = (email ?? "").trim().toLowerCase().split("@")[1];
  return at && !PUBLIC_MAIL_DOMAINS.has(at) ? at : null;
};

/** The lowercased email addresses of an organisation's live members. */
export async function memberAddresses(c: Conn, orgId: string): Promise<string[]> {
  const rows = await c
    .selectDistinct({
      email: sql<string | null>`lower(coalesce(${auth_user.email}, ${app_user.email}))`,
    })
    .from(org_membership)
    .innerJoin(app_user, eq(app_user.id, org_membership.user_id))
    .leftJoin(auth_user, eq(auth_user.id, app_user.directus_user_id))
    .where(and(eq(org_membership.org_id, orgId), isNull(org_membership.deleted_at)));
  return rows.flatMap((r) => (r.email?.includes("@") ? [r.email.trim()] : []));
}

/**
 * Who counts as this organisation in mail: its members' own domains, and the exact
 * address of each member at a public provider (a client on gmail.com is matched as that
 * one person, never as everyone at gmail.com). dembrane's own addresses never count.
 */
export function mailIdentity(addresses: readonly string[]): {
  domains: string[];
  addresses: string[];
} {
  const domains = new Set<string>();
  const exact = new Set<string>();
  for (const a of addresses) {
    const at = a.split("@")[1] ?? "";
    if (!at || at === "dembrane.com") continue;
    const d = domainOf(a);
    if (d) domains.add(d);
    else exact.add(a);
  }
  return { domains: [...domains].sort(), addresses: [...exact].sort() };
}
