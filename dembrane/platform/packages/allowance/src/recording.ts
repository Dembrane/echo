import { isUuid, NotFoundError } from "@dembrane/core";
import { type Db, schema } from "@dembrane/db";
import { eq, sql } from "drizzle-orm";
import type { AllowanceAccount } from "./account";
import { withAllowanceLock } from "./ledger";
import { accountWorkspaceIds } from "./projects";

const { billing_account } = schema;

const inList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

async function storedId(db: Db, a: AllowanceAccount): Promise<string | null> {
  const [row] = await db
    .select({ id: billing_account.recording_project_id })
    .from(billing_account)
    .where(eq(billing_account.id, a.accountId));
  return row?.id ?? null;
}

async function eligible(db: Db, a: AllowanceAccount, projectId: string | null): Promise<boolean> {
  if (!isUuid(projectId)) return false;
  const workspaceIds = await accountWorkspaceIds(db, a);
  if (workspaceIds.length === 0) return false;
  const rows = await db.execute(sql`
    select 1 from project
    where id = ${projectId}::uuid and deleted_at is null and is_sample = false
      and workspace_id in (${inList(workspaceIds)})`);
  return rows.length > 0;
}

// Latest live conversation's project, else the newest project.
async function choose(db: Db, a: AllowanceAccount): Promise<string | null> {
  const workspaceIds = await accountWorkspaceIds(db, a);
  if (workspaceIds.length === 0) return null;
  const [row] = await db.execute<{ id: string }>(sql`
    select p.id from project p
    left join lateral (
      select max(c.created_at) as last from conversation c
      where c.project_id = p.id and c.deleted_at is null
    ) c on true
    where p.deleted_at is null and p.is_sample = false
      and p.workspace_id in (${inList(workspaceIds)})
    order by c.last desc nulls last, p.created_at desc nulls last, p.id asc
    limit 1`);
  return row?.id ?? null;
}

async function store(db: Db, a: AllowanceAccount, projectId: string): Promise<void> {
  await db
    .update(billing_account)
    .set({ recording_project_id: projectId })
    .where(eq(billing_account.id, a.accountId));
}

// The account's recording project, chosen and stored on first need.
export async function recordingProject(db: Db, a: AllowanceAccount): Promise<string | null> {
  const fast = await storedId(db, a);
  if (fast && (await eligible(db, a, fast))) return fast;
  return withAllowanceLock(db, a, async (tx) => {
    const current = await storedId(tx, a);
    if (current && (await eligible(tx, a, current))) return current;
    const chosen = await choose(tx, a);
    if (chosen) await store(tx, a, chosen);
    return chosen;
  });
}

export async function setRecordingProject(
  db: Db,
  a: AllowanceAccount,
  projectId: string,
): Promise<void> {
  await withAllowanceLock(db, a, async (tx) => {
    if (!(await eligible(tx, a, projectId))) throw new NotFoundError("project.not_found");
    await store(tx, a, projectId);
  });
}
