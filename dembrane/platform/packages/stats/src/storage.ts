import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, eq, gte, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";

const { directus_users, directus_roles, project, conversation } = schema;

export interface StatsStore {
  /** Directus users in the Administrator role, whose projects never count. */
  adminUserIds(): Promise<string[]>;
  /** Live projects created since 2024 by anyone but staff, sample copies left out. */
  countedProjectIds(excluded: readonly string[]): Promise<string[]>;
  /** Live conversations of those projects: how many, and their summed duration in seconds. */
  conversationTotals(projectIds: readonly string[]): Promise<{ count: number; seconds: number }>;
}

export function statsStorage(db: Db): StatsStore {
  return {
    async adminUserIds() {
      const rows = await db
        .select({ id: directus_users.id })
        .from(directus_users)
        .innerJoin(directus_roles, eq(directus_roles.id, directus_users.role))
        .where(eq(directus_roles.name, "Administrator"));
      return rows.map((r) => r.id);
    },
    async countedProjectIds(excluded) {
      const conds = [
        gte(project.created_at, "2024-01-01T00:00:00Z"),
        isNull(project.deleted_at),
        // Every workspace's seeded sample would otherwise count as a project and its
        // invented conversations as recorded ones.
        eq(project.is_sample, false),
      ];
      // Directus `_nin` left rows without an owner out as well (NULL NOT IN is not true).
      if (excluded.length)
        conds.push(
          isNotNull(project.directus_user_id),
          notInArray(project.directus_user_id, [...excluded]),
        );
      const rows = await db
        .select({ id: project.id })
        .from(project)
        .where(and(...conds));
      return rows.map((r) => r.id);
    },
    async conversationTotals(projectIds) {
      if (!projectIds.length) return { count: 0, seconds: 0 };
      const [row] = await db
        .select({
          count: sql<number>`count(*)::int`,
          seconds: sql<number>`coalesce(sum(${conversation.duration}), 0)::float8`,
        })
        .from(conversation)
        .where(
          and(inArray(conversation.project_id, [...projectIds]), isNull(conversation.deleted_at)),
        );
      return { count: row?.count ?? 0, seconds: row?.seconds ?? 0 };
    },
  };
}
