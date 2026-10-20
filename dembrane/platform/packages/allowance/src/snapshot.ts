import type { Db } from "@dembrane/db";
import { sql } from "drizzle-orm";
import { type AllowanceAccount, allowanceForWorkspace } from "./account";
import { usedThisPeriod } from "./ledger";
import { freeLimits, type LimitKey } from "./limits";
import { nextReset } from "./period";

export type Meter = { used: number; limit: number };

export interface AllowanceSnapshot {
  free: boolean;
  period_start: string | null;
  resets_at: string | null;
  audio_seconds: Meter | null;
  chats: Meter | null;
  reports: Meter | null;
  maps: Meter | null;
  popcorn_sessions: Meter | null;
  projects: Meter | null;
}

const METERS = {
  audio_seconds: "audio_seconds_month",
  chats: "chats_month",
  reports: "reports_month",
  maps: "maps_month",
  popcorn_sessions: "popcorn_sessions_month",
} as const satisfies Record<string, LimitKey>;

const NOT_FREE: AllowanceSnapshot = Object.freeze({
  free: false,
  period_start: null,
  resets_at: null,
  audio_seconds: null,
  chats: null,
  reports: null,
  maps: null,
  popcorn_sessions: null,
  projects: null,
});

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

async function liveProjects(db: Db, workspaceIds: string[]): Promise<number> {
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

export async function allowanceSnapshot(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<AllowanceSnapshot> {
  const a = await allowanceForWorkspace(db, workspaceId, now);
  if (!a) return NOT_FREE;
  const [limits, used, projects] = await Promise.all([
    freeLimits(db),
    usedThisPeriod(db, a),
    accountWorkspaceIds(db, a).then((ids) => liveProjects(db, ids)),
  ]);
  const meter = (k: keyof typeof METERS): Meter => ({ used: used[k], limit: limits[METERS[k]] });
  return {
    free: true,
    period_start: a.periodStart.toISOString(),
    resets_at: nextReset(now).toISOString(),
    audio_seconds: meter("audio_seconds"),
    chats: meter("chats"),
    reports: meter("reports"),
    maps: meter("maps"),
    popcorn_sessions: meter("popcorn_sessions"),
    projects: { used: projects, limit: limits.projects },
  };
}
