import { schema } from "@dembrane/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { type Conn, isUuid } from "../db";

const { access_request } = schema;

export async function accessRequestById(db: Conn, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(access_request).where(eq(access_request.id, id)).limit(1);
  return row ?? null;
}

const livePending = () =>
  and(eq(access_request.status, "pending"), isNull(access_request.deleted_at));

/** The oldest live pending request of a user for a workspace (Directus sorted by requested_at). */
export async function pendingRequestFor(db: Conn, workspaceId: string, userId: string) {
  const [row] = await db
    .select({ id: access_request.id })
    .from(access_request)
    .where(
      and(
        eq(access_request.workspace_id, workspaceId),
        eq(access_request.user_id, userId),
        livePending(),
      ),
    )
    .orderBy(asc(access_request.requested_at))
    .limit(1);
  return row ?? null;
}

export async function pendingRequestsOfUser(
  db: Conn,
  workspaceIds: readonly string[],
  userId: string,
) {
  if (!workspaceIds.length) return [];
  return db
    .select({ id: access_request.id, workspace_id: access_request.workspace_id })
    .from(access_request)
    .where(
      and(
        inArray(access_request.workspace_id, [...workspaceIds]),
        eq(access_request.user_id, userId),
        livePending(),
      ),
    )
    .orderBy(asc(access_request.requested_at));
}

/** Newest first, for the managers' list. */
export async function pendingRequests(db: Conn, workspaceId: string) {
  return db
    .select()
    .from(access_request)
    .where(and(eq(access_request.workspace_id, workspaceId), livePending()))
    .orderBy(desc(access_request.requested_at));
}

export async function insertAccessRequest(db: Conn, row: typeof access_request.$inferInsert) {
  await db.insert(access_request).values(row);
}

export async function updateAccessRequest(
  db: Conn,
  id: string,
  patch: Partial<typeof access_request.$inferInsert>,
) {
  await db.update(access_request).set(patch).where(eq(access_request.id, id));
}
