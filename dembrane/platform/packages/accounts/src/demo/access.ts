import { type AccessStore, DrizzleAccessStore, HELD_FOR_DEMO } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import { sql } from "drizzle-orm";

/**
 * The access the demo build reads with. The popcorn read acts as the demo project's owner,
 * the contact, who has no place yet where the demo lives: a held contact is no member of
 * the new organisation until staff release them, and in an organisation the contact already
 * works in the demo's workspace is held back from everyone until publishing hands it over.
 * The build's own read counts a held contact as the admin they become, in the organisation
 * of their demo only, and the contact of a held-back workspace as its admin, in that
 * workspace only. Nothing else may use this store: every request reads the plain one, where
 * neither has a role.
 */
export function demoBuildAccess(db: Db): AccessStore {
  return new DemoBuildAccessStore(db);
}

class DemoBuildAccessStore extends DrizzleAccessStore {
  constructor(private readonly demos: Db) {
    super(demos);
  }

  override async orgRole(orgId: string, appUserId: string) {
    const role = await super.orgRole(orgId, appUserId);
    if (role) return role;
    const held = await this.demos.execute(
      sql`select 1 from account_demo d
        join app_user u on u.directus_user_id::text = d.seed->>'contact_user_id'
        where d.org_id = ${orgId} and u.id = ${appUserId} and d.seed->>'contact_held' = 'true'
        limit 1`,
    );
    return held.length > 0 ? "admin" : null;
  }

  override async workspaceMembership(workspaceId: string, appUserId: string, now: Date) {
    const row = await super.workspaceMembership(workspaceId, appUserId, now);
    if (row) return row;
    // Held back for this very demo, and its contact asking.
    const held = await this.demos.execute(
      sql`select 1 from account_demo d
        join app_user u on u.directus_user_id::text = d.seed->>'contact_user_id'
        join workspace w on w.id::text = d.seed->>'workspace_id' and w.org_id = d.org_id
        where w.id = ${workspaceId} and u.id = ${appUserId}
          and w.settings->>${sql.raw(`'${HELD_FOR_DEMO}'`)} = d.id::text
        limit 1`,
    );
    return held.length > 0 ? { role: "admin", customPolicies: null, source: "direct" } : null;
  }
}
