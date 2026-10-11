import { type AccessStore, DrizzleAccessStore } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import { sql } from "drizzle-orm";

/**
 * The access the demo build reads with. The popcorn read acts as the demo project's owner,
 * the contact, who is held until staff release them and so is no member yet. The build's
 * own read counts a held contact as the admin they become, in the organisation of their
 * demo only. Nothing else may use this store: every request reads the plain one, where a
 * held contact has no role.
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
}
