import type { Db } from "@dembrane/db";
import { sql } from "drizzle-orm";
import type { AllowanceAccount } from "./account";
import { freeLimitError } from "./errors";
import { freeLimits } from "./limits";

// Live workspaces resolving to this account: its own, plus free workspace-scoped clients when it is the org's pool.
export async function accountWorkspaceIds(
  db: Db,
  a: Pick<AllowanceAccount, "accountId" | "orgId">,
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select w.id from workspace w
    where w.deleted_at is null and (
      w.billing_account_id = ${a.accountId}
      or (
        ${a.orgId}::uuid is not null
        and w.org_id = ${a.orgId}
        and ${a.accountId}::uuid = (
          select b.id from billing_account b
          where b.org_id = ${a.orgId} and b.deleted_at is null
          order by b.created_at asc nulls last, b.id asc
          limit 1
        )
        and exists (
          select 1 from billing_account own
          where own.id = w.billing_account_id and own.org_id is null and own.tier = 'free'
        )
      )
    )`);
  return rows.map((r) => r.id);
}

// Live, non-sample projects across the account's workspaces.
export async function liveProjectCount(
  db: Db,
  a: Pick<AllowanceAccount, "accountId" | "orgId">,
): Promise<number> {
  const workspaceIds = await accountWorkspaceIds(db, a);
  if (workspaceIds.length === 0) return 0;
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from project
    where deleted_at is null and is_sample = false
      and workspace_id in (${sql.join(
        workspaceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`);
  return Number(row?.n ?? 0);
}

// Run inside withAllowanceLock together with the project write.
export async function requireProjectRoom(db: Db, a: AllowanceAccount, incoming = 1): Promise<void> {
  const [limits, used] = await Promise.all([freeLimits(db), liveProjectCount(db, a)]);
  if (used + incoming > limits.projects) {
    throw freeLimitError("projects", { used, cap: limits.projects });
  }
}
