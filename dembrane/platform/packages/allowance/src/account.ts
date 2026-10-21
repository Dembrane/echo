import { isUuid } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type SQL, sql } from "drizzle-orm";
import { isFreeTier } from "./free";
import { periodStart } from "./period";

export interface AllowanceAccount {
  readonly accountId: string;
  readonly free: true;
  readonly periodStart: Date;
  readonly orgId: string | null;
}

interface Row extends Record<string, unknown> {
  own_id: string;
  own_tier: string;
  own_org_id: string | null;
  own_downgraded_at: string | null;
  pool_id: string | null;
  pool_tier: string | null;
  pool_org_id: string | null;
  pool_downgraded_at: string | null;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

// Own account, plus the org's oldest live pooled account (mirrors tenancy orgBillingAccountId).
function resolve(db: Db, from: SQL, where: SQL) {
  return db.execute<Row>(sql`
    select own.id as own_id, own.tier as own_tier, own.org_id as own_org_id,
      to_char(own.downgraded_at at time zone 'UTC', ${sql.raw(ISO)}) as own_downgraded_at,
      pool.id as pool_id, pool.tier as pool_tier, pool.org_id as pool_org_id,
      to_char(pool.downgraded_at at time zone 'UTC', ${sql.raw(ISO)}) as pool_downgraded_at
    ${from}
    join billing_account own on own.id = w.billing_account_id
    left join lateral (
      select b.id, b.tier, b.org_id, b.downgraded_at from billing_account b
      where b.org_id = w.org_id and b.deleted_at is null
      order by b.created_at asc nulls last, b.id asc
      limit 1
    ) pool on true
    where ${where}
    limit 1`);
}

function pick(row: Row | undefined, now: Date): AllowanceAccount | null {
  if (!row || !isFreeTier(row.own_tier)) return null;
  const pooled = row.own_org_id === null && row.pool_id !== null && isFreeTier(row.pool_tier);
  const [id, tier, orgId, downgradedAt] = pooled
    ? [row.pool_id as string, row.pool_tier, row.pool_org_id, row.pool_downgraded_at]
    : [row.own_id, row.own_tier, row.own_org_id, row.own_downgraded_at];
  return {
    accountId: id,
    free: true,
    periodStart: periodStart(now, tier, downgradedAt),
    orgId,
  };
}

// Null means unlimited. Soft-deleted workspaces still resolve.
export async function allowanceForWorkspace(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<AllowanceAccount | null> {
  if (!isUuid(workspaceId)) return null;
  const rows = await resolve(db, sql`from workspace w`, sql`w.id = ${workspaceId}`);
  return pick(rows[0], now);
}

// Null when the project has no workspace. Soft-deleted projects still resolve.
export async function allowanceForProject(
  db: Db,
  projectId: string,
  now: Date,
): Promise<AllowanceAccount | null> {
  if (!isUuid(projectId)) return null;
  const rows = await resolve(
    db,
    sql`from project p join workspace w on w.id = p.workspace_id`,
    sql`p.id = ${projectId}`,
  );
  return pick(rows[0], now);
}

// The account a project's usage counts against; null when unlimited or a sample project.
export async function allowanceForCountedProject(
  db: Db,
  projectId: string,
  now: Date,
): Promise<AllowanceAccount | null> {
  const a = await allowanceForProject(db, projectId, now);
  if (!a) return null;
  const rows = await db.execute<{ is_sample: boolean | null }>(
    sql`select is_sample from project where id = ${projectId}`,
  );
  return rows[0]?.is_sample === true ? null : a;
}
