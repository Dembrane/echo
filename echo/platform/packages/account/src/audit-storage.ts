import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { and, asc, count, desc, eq, inArray, or, type SQL } from "drizzle-orm";

const { directus_activity, directus_revisions, directus_users } = schema;

/** Who may see which rows: staff see all activity, everyone else their own. */
export type AuditScope = { readonly all: true } | { readonly all: false; readonly userId: string };

export interface AuditFilter {
  readonly actions: readonly string[];
  readonly collections: readonly string[];
}

/**
 * The settings page's audit log over directus_activity. A user's own rows are the ones they
 * did or the ones done to their user record, the row filter Directus applied.
 */
export function auditStorage(db: Db) {
  const where = (scope: AuditScope, f: AuditFilter): SQL | undefined =>
    and(
      scope.all
        ? undefined
        : or(eq(directus_activity.user, scope.userId), eq(directus_activity.item, scope.userId)),
      f.actions.length ? inArray(directus_activity.action, [...f.actions]) : undefined,
      f.collections.length ? inArray(directus_activity.collection, [...f.collections]) : undefined,
    );

  return {
    async page(
      scope: AuditScope,
      f: AuditFilter,
      opts: { limit: number; offset: number; ascending: boolean },
    ) {
      return db
        .select({
          id: directus_activity.id,
          action: directus_activity.action,
          collection: directus_activity.collection,
          item: directus_activity.item,
          timestamp: directus_activity.timestamp,
          ip: directus_activity.ip,
          user_agent: directus_activity.user_agent,
          userId: directus_users.id,
          email: directus_users.email,
          first_name: directus_users.first_name,
          last_name: directus_users.last_name,
        })
        .from(directus_activity)
        .leftJoin(directus_users, eq(directus_users.id, directus_activity.user))
        .where(where(scope, f))
        .orderBy(
          opts.ascending ? asc(directus_activity.timestamp) : desc(directus_activity.timestamp),
          opts.ascending ? asc(directus_activity.id) : desc(directus_activity.id),
        )
        .limit(opts.limit)
        .offset(opts.offset);
    },

    async total(scope: AuditScope, f: AuditFilter): Promise<number> {
      const [row] = await db.select({ n: count() }).from(directus_activity).where(where(scope, f));
      return row?.n ?? 0;
    },

    /** Row counts per value of one column, sorted by the value, for the filter pickers. */
    async counts(scope: AuditScope, column: "action" | "collection") {
      const col = directus_activity[column];
      return db
        .select({ value: col, count: count() })
        .from(directus_activity)
        .where(where(scope, { actions: [], collections: [] }))
        .groupBy(col)
        .orderBy(asc(col));
    },

    async deltas(activityIds: readonly number[]) {
      if (!activityIds.length) return [];
      return db
        .select({ activity: directus_revisions.activity, delta: directus_revisions.delta })
        .from(directus_revisions)
        .where(inArray(directus_revisions.activity, [...activityIds]))
        .orderBy(asc(directus_revisions.id));
    },
  };
}

export type AuditStorage = ReturnType<typeof auditStorage>;
