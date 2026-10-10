import { schema } from "@dembrane/db";
import { and, asc, eq, gte, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { Conn } from "../db";

const { project, conversation, project_chat, project_chat_message, project_report } = schema;

/**
 * Not a sample copy (packages/samples): every count and sum of usage, and every free-tier
 * allowance, leaves the invented project out, along with its chats and reports.
 */
export const notSample = eq(project.is_sample, false);

/**
 * Every project a workspace ever had, soft-deleted ones included: deletion keeps billable
 * hours. Usage reads these, so a sample copy is not among them.
 */
export async function workspaceProjects(db: Conn, workspaceId: string) {
  return db
    .select({ id: project.id, name: project.name, deleted_at: project.deleted_at })
    .from(project)
    .where(and(eq(project.workspace_id, workspaceId), notSample))
    .orderBy(asc(project.id));
}

/** The workspaces' projects for usage rollups, soft-deleted ones included, samples not. */
export async function projectsIn(db: Conn, workspaceIds: readonly string[]) {
  if (!workspaceIds.length) return [];
  return db
    .select({
      id: project.id,
      workspace_id: project.workspace_id,
      deleted_at: project.deleted_at,
    })
    .from(project)
    .where(and(inArray(project.workspace_id, [...workspaceIds]), notSample))
    .orderBy(asc(project.id));
}

/** The workspace's own live projects: a sample copy neither counts nor keeps it from deletion. */
export async function countLiveProjects(db: Conn, workspaceId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(${project.id})::int` })
    .from(project)
    .where(and(eq(project.workspace_id, workspaceId), isNull(project.deleted_at), notSample));
  return row?.n ?? 0;
}

/** A deleted workspace's sample copy goes with it; nothing else of it is deleted. */
export async function deleteSampleProjects(db: Conn, workspaceId: string, nowIso: string) {
  await db
    .update(project)
    .set({ deleted_at: nowIso, updated_at: nowIso })
    .where(
      and(
        eq(project.workspace_id, workspaceId),
        eq(project.is_sample, true),
        isNull(project.deleted_at),
      ),
    );
}

/** Live project counts per workspace, samples left out. */
export async function liveProjectCounts(db: Conn, workspaceIds: readonly string[]) {
  if (!workspaceIds.length) return new Map<string, number>();
  const rows = await db
    .select({ ws: project.workspace_id, n: sql<number>`count(${project.id})::int` })
    .from(project)
    .where(
      and(inArray(project.workspace_id, [...workspaceIds]), isNull(project.deleted_at), notSample),
    )
    .groupBy(project.workspace_id);
  return new Map(rows.map((r) => [r.ws ?? "", r.n]));
}

/**
 * sum(duration) and count(id) over conversations of the given projects, as Directus
 * aggregates computed them: the sum stays a float4 so it rounds the way the old API saw it.
 */
async function conversationAggregate(
  db: Conn,
  projectIds: readonly string[],
  extra?: SQL,
): Promise<{ sum: number; count: number }> {
  if (!projectIds.length) return { sum: 0, count: 0 };
  const [row] = await db
    .select({
      sum: sql<string | number | null>`sum(${conversation.duration})`,
      count: sql<number>`count(${conversation.id})::int`,
    })
    .from(conversation)
    .where(and(inArray(conversation.project_id, [...projectIds]), extra));
  return { sum: Number(row?.sum ?? 0) || 0, count: row?.count ?? 0 };
}

/**
 * The four card figures: hours all time and this month (deleted conversations and projects
 * keep their billable time), conversation counts all time and this month (live ones of live
 * projects only).
 */
export async function cardAggregates(
  db: Conn,
  projectIds: readonly string[],
  liveProjectIds: readonly string[],
  monthStartIso: string,
) {
  const live = isNull(conversation.deleted_at);
  const inMonth = gte(conversation.created_at, monthStartIso);
  const [total, liveAll, month, liveMonth] = await Promise.all([
    conversationAggregate(db, projectIds),
    conversationAggregate(db, liveProjectIds, live),
    conversationAggregate(db, projectIds, inMonth),
    conversationAggregate(db, liveProjectIds, and(inMonth, live)),
  ]);
  return {
    hoursSeconds: total.sum,
    count: liveAll.count,
    monthSeconds: month.sum,
    monthCount: liveMonth.count,
  };
}

/** Rows (project, duration) for sums done in code, where the old API summed in Python. */
/** Every conversation's duration, deleted ones included (billable time is kept). */
export function allConversationDurations(db: Conn, projectIds: readonly string[]) {
  return conversationDurations(db, projectIds);
}

/** Durations of conversations created in [start, end), deleted ones included. */
export function conversationDurationsIn(
  db: Conn,
  projectIds: readonly string[],
  startIso: string,
  endIso: string,
) {
  return conversationDurations(
    db,
    projectIds,
    and(gte(conversation.created_at, startIso), lt(conversation.created_at, endIso)),
  );
}

async function conversationDurations(db: Conn, projectIds: readonly string[], extra?: SQL) {
  if (!projectIds.length) return [];
  return db
    .select({ project_id: conversation.project_id, duration: conversation.duration })
    .from(conversation)
    .where(and(inArray(conversation.project_id, [...projectIds]), extra))
    .orderBy(asc(conversation.id));
}

/** Per project hours, summed by the database and grouped, for the project list cells. */
export async function hoursByProject(db: Conn, projectIds: readonly string[]) {
  if (!projectIds.length) return new Map<string, number>();
  const rows = await db
    .select({
      pid: conversation.project_id,
      sum: sql<string | number | null>`sum(${conversation.duration})`,
    })
    .from(conversation)
    .where(and(inArray(conversation.project_id, [...projectIds]), isNull(conversation.deleted_at)))
    .groupBy(conversation.project_id);
  return new Map(rows.map((r) => [r.pid, Number(r.sum ?? 0) || 0]));
}

// ── free tier counters ──────────────────────────────────────────────────

/** Chats with at least one user message: an opened but unused chat does not spend the allowance. */
export async function countUsedChats(db: Conn, projectIds: readonly string[]) {
  if (!projectIds.length) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${project_chat_message.project_chat_id})::int` })
    .from(project_chat_message)
    .innerJoin(project_chat, eq(project_chat.id, project_chat_message.project_chat_id))
    .where(
      and(
        inArray(project_chat.project_id, [...projectIds]),
        isNull(project_chat.deleted_at),
        eq(project_chat_message.message_from, "user"),
      ),
    );
  return row?.n ?? 0;
}

export async function oldestLiveChat(db: Conn, projectIds: readonly string[]) {
  if (!projectIds.length) return null;
  const [row] = await db
    .select({ id: project_chat.id })
    .from(project_chat)
    .where(and(inArray(project_chat.project_id, [...projectIds]), isNull(project_chat.deleted_at)))
    .orderBy(asc(project_chat.date_created))
    .limit(1);
  return row?.id ?? null;
}

/** Reports only: a canvas is a project_report row too and must not spend the report allowance. */
export async function countReports(db: Conn, projectIds: readonly string[]) {
  if (!projectIds.length) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(${project_report.id})::int` })
    .from(project_report)
    .where(
      and(
        inArray(project_report.project_id, [...projectIds]),
        isNull(project_report.deleted_at),
        eq(project_report.kind, "report"),
      ),
    );
  return row?.n ?? 0;
}

export async function oldestReport(db: Conn, projectIds: readonly string[]) {
  if (!projectIds.length) return null;
  const [row] = await db
    .select({ id: project_report.id })
    .from(project_report)
    .where(
      and(
        inArray(project_report.project_id, [...projectIds]),
        isNull(project_report.deleted_at),
        eq(project_report.kind, "report"),
      ),
    )
    .orderBy(asc(project_report.date_created))
    .limit(1);
  // bigserial: the old API returned it as a JSON number.
  return row ? Number(row.id) : null;
}

/** Conversations stamped over the free cap, cleared on downgrade so earlier content stays readable. */
export async function clearOverCapStamps(db: Conn, workspaceId: string, nowIso: string) {
  await db
    .update(conversation)
    .set({ is_over_cap: false, updated_at: nowIso })
    .where(
      and(
        eq(conversation.is_over_cap, true),
        inArray(
          conversation.project_id,
          db.select({ id: project.id }).from(project).where(eq(project.workspace_id, workspaceId)),
        ),
      ),
    );
}
