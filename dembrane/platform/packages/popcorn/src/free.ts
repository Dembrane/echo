import {
  allowanceForCountedProject,
  allowanceForProject,
  freeLimitError,
  freeLimits,
  giveBack,
  take,
  usedThisPeriod,
  withAllowanceLock,
} from "@dembrane/allowance";
import { type Db, schema } from "@dembrane/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Json } from "./py";
import { MIN_CADENCE_MINUTES } from "./settings";

const { agent_loop, agent_loop_run } = schema;
const UNSTAMPED = { free_period_start: null, free_account_id: null };

/** periodStart and accountId are null when nothing was counted. */
export type PopcornAdmit =
  | { readonly ok: true; readonly periodStart: string | null; readonly accountId: string | null }
  | { readonly ok: false; readonly used: number; readonly limit: number };

export interface FreePopcorn {
  readonly used: number;
  readonly limit: number;
  readonly exhausted: boolean;
}

export interface PopcornAllowance {
  admit(projectId: string, now: Date): Promise<PopcornAdmit>;
  /** `startedBefore` gives back only a run not started again since. */
  refund(runId: string, now: Date, opts?: { startedBefore: string }): Promise<boolean>;
  status(projectId: string, now: Date): Promise<FreePopcorn | null>;
  requireRoom(projectId: string, now: Date): Promise<void>;
  cadenceFloorMinutes(projectId: string, now: Date): Promise<number>;
}

// Free popcorn: each analysis that runs takes one of the month's analyses.
export function popcornAllowance(db: Db): PopcornAllowance {
  const counted = (projectId: string, now: Date) => allowanceForCountedProject(db, projectId, now);

  async function status(projectId: string, now: Date): Promise<FreePopcorn | null> {
    const a = await counted(projectId, now);
    if (!a) return null;
    const limit = (await freeLimits(db)).popcorn_analyses_month;
    const used = (await usedThisPeriod(db, a)).popcorn_analyses;
    return { used, limit, exhausted: used >= limit };
  }

  return {
    async admit(projectId, now) {
      const a = await counted(projectId, now);
      if (!a) return { ok: true, periodStart: null, accountId: null };
      const limits = await freeLimits(db);
      const t = await take(db, a, "popcorn_analyses", 1, limits.popcorn_analyses_month);
      if (!t.ok) return { ok: false, used: t.used, limit: t.limit };
      return { ok: true, periodStart: a.periodStart.toISOString(), accountId: a.accountId };
    },

    async refund(runId, now, opts) {
      const stamped = and(
        eq(agent_loop_run.id, runId),
        isNotNull(agent_loop_run.free_period_start),
        opts ? sql`${agent_loop_run.started_at} < ${opts.startedBefore}::timestamptz` : undefined,
      );
      const [r] = await db
        .select({
          projectId: agent_loop.project_id,
          stampMs: sql<string>`(extract(epoch from ${agent_loop_run.free_period_start}) * 1000)::bigint`,
          accountId: agent_loop_run.free_account_id,
        })
        .from(agent_loop_run)
        .leftJoin(agent_loop, eq(agent_loop.id, agent_loop_run.loop_id))
        .where(stamped);
      if (!r) return false;
      const a = r.projectId ? await allowanceForProject(db, r.projectId, now) : null;
      // Legacy rows without an account match any.
      const charged =
        a &&
        Number(r.stampMs) === a.periodStart.getTime() &&
        (r.accountId === null || r.accountId === a.accountId);
      if (!a || !charged) {
        await db.update(agent_loop_run).set(UNSTAMPED).where(stamped);
        return false;
      }
      return withAllowanceLock(db, a, async (tx) => {
        const cleared = await tx
          .update(agent_loop_run)
          .set(UNSTAMPED)
          .where(stamped)
          .returning({ id: agent_loop_run.id });
        if (cleared.length === 0) return false;
        await giveBack(tx, a, "popcorn_analyses", 1);
        return true;
      });
    },

    status,

    async requireRoom(projectId, now) {
      const s = await status(projectId, now);
      if (s?.exhausted) throw freeLimitError("popcorn", { used: s.used, cap: s.limit });
    },

    async cadenceFloorMinutes(projectId, now) {
      if (!(await counted(projectId, now))) return MIN_CADENCE_MINUTES;
      return (await freeLimits(db)).popcorn_cadence_minutes;
    },
  };
}

// Adds the host's free popcorn status (null when unlimited) to a payload.
export async function withFreePopcorn(
  db: Db,
  detail: Json,
  projectId: string,
  now: Date,
): Promise<Json> {
  detail.free_popcorn = await popcornAllowance(db).status(projectId, now);
  return detail;
}
