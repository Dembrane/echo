import { schema } from "@dembrane/db";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type Conn, isUuid } from "../db";

const { project, project_membership } = schema;

export type ProjectRow = typeof project.$inferSelect;

export async function projectById(db: Conn, id: string): Promise<ProjectRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(project).where(eq(project.id, id)).limit(1);
  return row ?? null;
}

export async function insertProject(db: Conn, row: typeof project.$inferInsert) {
  await db.insert(project).values(row);
}

// ── shares ──────────────────────────────────────────────────────────────

export async function sharesOfProject(db: Conn, projectId: string) {
  return db
    .select({
      user_id: project_membership.user_id,
      granted_by: project_membership.granted_by,
      created_at: project_membership.created_at,
    })
    .from(project_membership)
    .where(eq(project_membership.project_id, projectId))
    .orderBy(asc(project_membership.id));
}

export async function shareRowIds(db: Conn, projectId: string, userId: string) {
  if (!isUuid(userId)) return [];
  const rows = await db
    .select({ id: project_membership.id })
    .from(project_membership)
    .where(
      and(eq(project_membership.project_id, projectId), eq(project_membership.user_id, userId)),
    )
    .orderBy(asc(project_membership.id));
  return rows.map((r) => r.id);
}

export async function insertShare(db: Conn, row: typeof project_membership.$inferInsert) {
  await db.insert(project_membership).values(row);
}

export async function deleteShares(db: Conn, ids: readonly string[]) {
  if (ids.length)
    await db.delete(project_membership).where(inArray(project_membership.id, [...ids]));
}

/** Projects the user holds a share on, anywhere. */
export async function sharedProjectIds(db: Conn, userId: string) {
  const rows = await db
    .select({ project_id: project_membership.project_id })
    .from(project_membership)
    .where(eq(project_membership.user_id, userId));
  return rows.map((r) => r.project_id);
}

/** (project, user) share pairs for the given projects, in primary key order. */
export async function sharePairs(db: Conn, projectIds: readonly string[]) {
  if (!projectIds.length) return [];
  return db
    .select({ project_id: project_membership.project_id, user_id: project_membership.user_id })
    .from(project_membership)
    .where(inArray(project_membership.project_id, [...projectIds]))
    .orderBy(asc(project_membership.id));
}

// ── the workspace project list ──────────────────────────────────────────

const summaryFields = {
  id: project.id,
  name: project.name,
  updated_at: project.updated_at,
  language: project.language,
  pin_order: project.pin_order,
  visibility: project.visibility,
  // Live conversations only; Directus's count(conversations) also counted deleted rows.
  conversations_count: sql<number>`(select count(*)::int from "conversation" c where c.project_id = "project"."id" and c.deleted_at is null)`,
};

export interface ProjectListQuery {
  readonly workspaceId: string;
  /** Null: every private project is visible. Otherwise only these private ones are. */
  readonly privateVisible: readonly string[] | null;
  /** Words to find in the name; null for no filter. */
  readonly search: string | null;
  /** The old API counted only when no search parameter was sent at all. */
  readonly countTotal: boolean;
  readonly offset: number;
  readonly limit: number;
}

/** Every word must appear somewhere in the name, in any order, ignoring case. */
function nameSearch(term: string): SQL | undefined {
  const tokens = term.split(/\s+/).filter(Boolean);
  if (!tokens.length) return undefined;
  return and(...tokens.map((t) => ilike(project.name, `%${t}%`)));
}

/** One page (plus one row to tell whether more exist), the top three pins, and the total. */
export async function projectListPage(db: Conn, q: ProjectListQuery) {
  const visible = q.privateVisible
    ? or(
        ne(project.visibility, "private"),
        isNull(project.visibility),
        q.privateVisible.length ? inArray(project.id, [...q.privateVisible]) : undefined,
      )
    : undefined;
  const search = q.search ? nameSearch(q.search) : undefined;
  const where = and(
    eq(project.workspace_id, q.workspaceId),
    isNull(project.deleted_at),
    visible,
    search,
  );
  const [page, pinned, total] = await Promise.all([
    db
      .select(summaryFields)
      .from(project)
      .where(where)
      .orderBy(desc(project.updated_at))
      .limit(q.limit + 1)
      .offset(q.offset),
    db
      .select(summaryFields)
      .from(project)
      .where(and(where, isNotNull(project.pin_order)))
      .orderBy(asc(project.pin_order))
      .limit(3),
    !q.countTotal
      ? Promise.resolve(null)
      : db
          .select({ n: sql<number>`count(${project.id})::int` })
          .from(project)
          .where(where)
          .then((r) => r[0]?.n ?? 0),
  ]);
  return { page, pinned, total };
}
