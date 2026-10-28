import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  max,
  min,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

const { directus_activity, directus_revisions, directus_users } = schema;

/** Who may see which rows; the settings route always passes the caller's own scope. */
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

  const select = () =>
    db
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
      .leftJoin(directus_users, eq(directus_users.id, directus_activity.user));

  return {
    /**
     * Rows in id order, which is time order: ids and timestamps rise together, to within a
     * second. `after` is the last id of the previous page, so a page never skips or repeats a
     * row and costs the same however deep it is.
     *
     * The table has no index on who did what, so matches are found by reading. The newest
     * `window` ids are walked first through the primary key, which stops as soon as the page
     * is full: people with recent activity wait milliseconds. Only when that window runs dry
     * does one pass over the rest of the table run, ordered by an expression so Postgres
     * scans it in parallel instead of walking the whole key one row at a time.
     */
    async page(
      scope: AuditScope,
      f: AuditFilter,
      opts: { limit: number; after?: number | undefined; ascending: boolean; window?: number },
    ) {
      const { limit, ascending } = opts;
      const window = opts.window ?? 500_000;
      const id = directus_activity.id;
      const order = ascending ? asc : desc;
      let from = opts.after;
      if (from === undefined) {
        const [edge] = await db
          .select({ id: ascending ? min(id) : max(id) })
          .from(directus_activity);
        if (edge?.id == null) return [];
        from = ascending ? edge.id - 1 : edge.id + 1;
      }
      const near = ascending
        ? and(gt(id, from), lte(id, from + window))
        : and(lt(id, from), gte(id, from - window));
      const far = ascending ? gt(id, from + window) : lt(id, from - window);

      const rows = await select()
        .where(and(where(scope, f), near))
        .orderBy(order(id))
        .limit(limit);
      if (rows.length >= limit) return rows;
      const rest = await select()
        .where(and(where(scope, f), far))
        .orderBy(order(sql`${id} + 0`))
        .limit(limit - rows.length);
      return [...rows, ...rest];
    },

    /** Row counts per action and collection pair, in one pass, for the filter pickers. */
    async counts(scope: AuditScope) {
      return db
        .select({
          action: directus_activity.action,
          collection: directus_activity.collection,
          count: count(),
        })
        .from(directus_activity)
        .where(where(scope, { actions: [], collections: [] }))
        .groupBy(directus_activity.action, directus_activity.collection);
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
