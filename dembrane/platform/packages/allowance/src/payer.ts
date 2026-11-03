import { isUuid } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type SQL, sql } from "drizzle-orm";
import { type AccountRow, accountQuery, pooled } from "./account";

export interface PayingAccount {
  readonly accountId: string;
  readonly tier: string | null;
  readonly downgradedAt: string | null;
  /** False for sample projects: recorded, never spent. */
  readonly counted: boolean;
}

interface PayerRow extends AccountRow {
  key: string;
  counted: boolean;
}

// The billing account that pays, on every tier; same pooling as allowanceFor*.
async function payers(
  db: Db,
  ids: readonly string[],
  from: SQL,
  where: (ids: string[]) => SQL,
  extra: SQL,
): Promise<Map<string, PayingAccount>> {
  const valid = [...new Set(ids.filter(isUuid))];
  const out = new Map<string, PayingAccount>();
  if (valid.length === 0) return out;
  const rows = await db.execute<PayerRow>(accountQuery(from, where(valid), extra));
  for (const r of rows) {
    const pool = pooled(r);
    out.set(r.key, {
      accountId: pool ? (r.pool_id as string) : r.own_id,
      tier: pool ? r.pool_tier : r.own_tier,
      downgradedAt: pool ? r.pool_downgraded_at : r.own_downgraded_at,
      counted: r.counted,
    });
  }
  return out;
}

// Unknown and workspaceless projects are absent; soft-deleted ones still resolve.
export function payingAccountsForProjects(
  db: Db,
  projectIds: readonly string[],
): Promise<Map<string, PayingAccount>> {
  return payers(
    db,
    projectIds,
    sql`from project p join workspace w on w.id = p.workspace_id`,
    (ids) => sql`p.id = any(${sql.param(ids)}::uuid[])`,
    sql`, p.id as key, not p.is_sample as counted`,
  );
}

// Unknown workspaces are absent; soft-deleted ones still resolve.
export function payingAccountsForWorkspaces(
  db: Db,
  workspaceIds: readonly string[],
): Promise<Map<string, PayingAccount>> {
  return payers(
    db,
    workspaceIds,
    sql`from workspace w`,
    (ids) => sql`w.id = any(${sql.param(ids)}::uuid[])`,
    sql`, w.id as key, true as counted`,
  );
}
