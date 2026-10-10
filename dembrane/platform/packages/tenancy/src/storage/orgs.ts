import { schema } from "@dembrane/db";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Conn } from "../db";
import { notSample } from "./usage";

const {
  org,
  org_membership,
  workspace,
  workspace_membership,
  project,
  conversation,
  referral_ledger,
} = schema;

export async function insertOrg(db: Conn, row: typeof org.$inferInsert) {
  await db.insert(org).values(row);
}

export async function updateOrg(db: Conn, id: string, patch: Partial<typeof org.$inferInsert>) {
  await db.update(org).set(patch).where(eq(org.id, id));
}

export async function insertOrgMembership(db: Conn, row: typeof org_membership.$inferInsert) {
  await db.insert(org_membership).values(row);
}

export async function updateOrgMembership(
  db: Conn,
  id: string,
  patch: Partial<typeof org_membership.$inferInsert>,
) {
  await db.update(org_membership).set(patch).where(eq(org_membership.id, id));
}

/** Distinct users with an external row on the org's live workspaces and no org row. */
export async function countExternals(db: Conn, orgId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${workspace_membership.user_id})::int` })
    .from(workspace_membership)
    .innerJoin(workspace, eq(workspace.id, workspace_membership.workspace_id))
    .where(
      and(
        eq(workspace.org_id, orgId),
        isNull(workspace.deleted_at),
        eq(workspace_membership.role, "external"),
        isNull(workspace_membership.deleted_at),
        sql`not exists (select 1 from "org_membership" om where om.org_id = ${orgId} and om.user_id = "workspace_membership"."user_id" and om.deleted_at is null)`,
      ),
    );
  return row?.n ?? 0;
}

/** Live counts per workspace: projects, and active membership rows (support rows included). */
export async function countsByWorkspace(db: Conn, workspaceIds: readonly string[]) {
  const projects = new Map<string, number>();
  const members = new Map<string, number>();
  if (!workspaceIds.length) return { projects, members };
  const ids = [...workspaceIds];
  for (const r of await db
    .select({ ws: project.workspace_id, n: sql<number>`count(*)::int` })
    .from(project)
    .where(and(inArray(project.workspace_id, ids), isNull(project.deleted_at), notSample))
    .groupBy(project.workspace_id))
    projects.set(r.ws ?? "", r.n);
  for (const r of await db
    .select({ ws: workspace_membership.workspace_id, n: sql<number>`count(*)::int` })
    .from(workspace_membership)
    .where(
      and(inArray(workspace_membership.workspace_id, ids), isNull(workspace_membership.deleted_at)),
    )
    .groupBy(workspace_membership.workspace_id))
    members.set(r.ws, r.n);
  return { projects, members };
}

/** Top three pinned projects; private ones only for org managers. */
export async function pinnedProjects(db: Conn, workspaceId: string, includePrivate: boolean) {
  return db
    .select({ id: project.id, name: project.name })
    .from(project)
    .where(
      and(
        eq(project.workspace_id, workspaceId),
        isNull(project.deleted_at),
        isNotNull(project.pin_order),
        includePrivate
          ? undefined
          : or(ne(project.visibility, "private"), isNull(project.visibility)),
      ),
    )
    .orderBy(asc(project.pin_order))
    .limit(3);
}

/**
 * Live projects of the given workspaces, newest first, for winding workspaces down: a
 * sample copy is not among them, since it goes with its workspace.
 */
export async function liveProjectsIn(db: Conn, workspaceIds: readonly string[]) {
  if (!workspaceIds.length) return [];
  return db
    .select({
      id: project.id,
      name: project.name,
      workspace_id: project.workspace_id,
      visibility: project.visibility,
      created_at: project.created_at,
    })
    .from(project)
    .where(
      and(inArray(project.workspace_id, [...workspaceIds]), isNull(project.deleted_at), notSample),
    )
    .orderBy(desc(project.created_at));
}

async function durations(db: Conn, projectIds: readonly string[], extra: SQL | undefined) {
  if (!projectIds.length) return [];
  return db
    .select({ project_id: conversation.project_id, duration: conversation.duration })
    .from(conversation)
    .where(and(inArray(conversation.project_id, [...projectIds]), extra))
    .orderBy(asc(conversation.id));
}

/** Durations of live conversations, for per-project totals. */
export function liveConversationDurations(db: Conn, projectIds: readonly string[]) {
  return durations(db, projectIds, isNull(conversation.deleted_at));
}

/** Durations of every conversation created in [start, end), deleted ones included. */
export function conversationDurationsBetween(
  db: Conn,
  projectIds: readonly string[],
  startIso: string,
  endIso: string,
) {
  return durations(
    db,
    projectIds,
    and(gte(conversation.created_at, startIso), lt(conversation.created_at, endIso)),
  );
}

/** Names of partner orgs where the user holds a live external row. */
export async function partnerOrgNamesExternalOf(db: Conn, userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: org.name })
    .from(workspace_membership)
    .innerJoin(workspace, eq(workspace.id, workspace_membership.workspace_id))
    .innerJoin(org, eq(org.id, workspace.org_id))
    .where(
      and(
        eq(workspace_membership.user_id, userId),
        eq(workspace_membership.role, "external"),
        isNull(workspace_membership.deleted_at),
        eq(org.is_partner, true),
      ),
    );
  return [...new Set(rows.map((r) => r.name).filter(Boolean))];
}

export async function referralLedger(db: Conn, orgId: string) {
  return db
    .select()
    .from(referral_ledger)
    .where(and(eq(referral_ledger.partner_team_id, orgId), isNull(referral_ledger.deleted_at)))
    .orderBy(desc(referral_ledger.starts_at));
}

/** Soft-deletes every active row the user holds on the org's live workspaces; returns their workspaces. */
export async function softDeleteMembershipsInOrg(
  db: Conn,
  orgId: string,
  userId: string,
  nowIso: string,
  roles?: readonly string[],
) {
  const rows = await db
    .select({ id: workspace_membership.id, workspace_id: workspace_membership.workspace_id })
    .from(workspace_membership)
    .innerJoin(workspace, eq(workspace.id, workspace_membership.workspace_id))
    .where(
      and(
        eq(workspace.org_id, orgId),
        isNull(workspace.deleted_at),
        eq(workspace_membership.user_id, userId),
        isNull(workspace_membership.deleted_at),
        roles ? inArray(workspace_membership.role, [...roles]) : undefined,
      ),
    )
    .orderBy(asc(workspace_membership.id));
  if (rows.length)
    await db
      .update(workspace_membership)
      .set({ deleted_at: nowIso, updated_at: nowIso })
      .where(
        inArray(
          workspace_membership.id,
          rows.map((r) => r.id),
        ),
      );
  return rows;
}
