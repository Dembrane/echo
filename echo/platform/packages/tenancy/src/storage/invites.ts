import { schema } from "@dembrane/db";
import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Conn } from "../db";

const { workspace_invite, org_invite } = schema;

/** Not accepted, not revoked, not expired. */
const livePendingWs = (nowIso: string) =>
  and(
    isNull(workspace_invite.accepted_at),
    isNull(workspace_invite.deleted_at),
    gt(workspace_invite.expires_at, nowIso),
  );

export async function pendingWorkspaceInvites(
  db: Conn,
  workspaceIds: readonly string[],
  nowIso: string,
  opts: { projectId?: string; limit?: number } = {},
) {
  if (!workspaceIds.length) return [];
  const q = db
    .select()
    .from(workspace_invite)
    .where(
      and(
        inArray(workspace_invite.workspace_id, [...workspaceIds]),
        livePendingWs(nowIso),
        opts.projectId ? eq(workspace_invite.project_id, opts.projectId) : undefined,
      ),
    )
    .orderBy(desc(workspace_invite.created_at));
  return opts.limit ? q.limit(opts.limit) : q;
}

/** [members, externals, observers] still pending. Observers are free and sit outside the seat pool. */
export async function countPendingInvites(db: Conn, workspaceId: string, nowIso: string) {
  const rows = await db
    .select({ role: workspace_invite.role })
    .from(workspace_invite)
    .where(and(eq(workspace_invite.workspace_id, workspaceId), livePendingWs(nowIso)));
  let m = 0;
  let e = 0;
  let o = 0;
  for (const r of rows) {
    if (r.role === "observer") o++;
    else if (r.role === "external") e++;
    else m++;
  }
  return [m, e, o] as const;
}

export async function insertWorkspaceInvite(db: Conn, row: typeof workspace_invite.$inferInsert) {
  await db.insert(workspace_invite).values(row);
}

export async function pendingOrgInvites(db: Conn, orgId: string, nowIso: string, email?: string) {
  return db
    .select()
    .from(org_invite)
    .where(
      and(
        eq(org_invite.org_id, orgId),
        isNull(org_invite.accepted_at),
        isNull(org_invite.deleted_at),
        gt(org_invite.expires_at, nowIso),
        email ? eq(org_invite.email, email) : undefined,
      ),
    )
    .orderBy(email ? asc(org_invite.id) : desc(org_invite.created_at));
}

export async function insertOrgInvite(db: Conn, row: typeof org_invite.$inferInsert) {
  await db.insert(org_invite).values(row);
}
