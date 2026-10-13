import { newId } from "@dembrane/core";
import { scheduledTasks } from "@dembrane/queue";
import type { Json } from "../py";
import { type Row, type Sql, TASK_POPCORN_TICK } from "../storage";

/**
 * SQL the tick needs beyond the session's own rows: its run records, saved runs, the
 * run lease and liveness beat, and the popcorn_tick scheduled_task runner.
 *
 * The lease and the beat replace the Redis keys popcorn:run:<loop> and popcorn:alive:
 * <loop>. They live in platform_rate_limit (an unlogged key, count, reset_at table)
 * because it already has exactly the shape a lease needs, so no migration is added: the
 * key names the loop, `count` carries the holder's token and `reset_at` is when the
 * lease lapses. A claim is an upsert that only takes a lapsed lease or one this holder
 * already has; a release deletes it only if it is still this holder's. A crash loses
 * nothing: the lease lapses by itself. Next: a dedicated lease table once another
 * namespace needs one.
 */

export const RUN_LOCK_SECONDS = 5 * 60;
export const STALE_TICK_SECONDS = 90;

const runKey = (loopId: string) => `popcorn:run:${loopId}`;
const aliveKey = (loopId: string) => `popcorn:alive:${loopId}`;

export function tickStore(sql: Sql) {
  const tasks = scheduledTasks(sql);
  return {
    sql,

    async run(id: string): Promise<Row | null> {
      const [r] = await sql`select * from agent_loop_run where id = ${id}`;
      return r ?? null;
    },

    async insertRun(v: {
      id: string;
      loopId: string;
      status: string;
      detail: string | null;
      startedAt: string;
      finishedAt: string;
    }): Promise<Row> {
      const [r] =
        await sql`insert into agent_loop_run (id, loop_id, status, detail, started_at, finished_at)
        values (${v.id}, ${v.loopId}, ${v.status}, ${v.detail}, ${v.startedAt}, ${v.finishedAt})
        returning *`;
      return r as Row;
    },

    /** An on-request tick's retry replaces the failed attempt's row under the same id. */
    async replaceRun(v: {
      id: string;
      loopId: string;
      status: string;
      detail: string | null;
      startedAt: string;
      finishedAt: string;
    }): Promise<Row> {
      const [r] = await sql`update agent_loop_run set loop_id = ${v.loopId}, status = ${v.status},
        detail = ${v.detail}, started_at = ${v.startedAt}, finished_at = ${v.finishedAt}
        where id = ${v.id} returning *`;
      return r as Row;
    },

    async insertVersion(v: {
      reportId: string;
      configId: string | null;
      html: string;
      tickKind: string;
      detail: string;
      now: string;
    }): Promise<Row> {
      const [r] = await sql`insert into canvas_generation
        (id, report_id, config_revision_id, content_html, status, tick_kind, detail, created_at)
        values (${newId()}, ${v.reportId}, ${v.configId}, ${v.html}, 'ok', ${v.tickKind}, ${v.detail}, ${v.now})
        returning *`;
      return r as Row;
    },

    // ── the lease and the beat ────────────────────────────────────────

    async claimLease(loopId: string, token: number): Promise<boolean> {
      const rows = await sql`insert into platform_rate_limit (key, count, reset_at)
        values (${runKey(loopId)}, ${token}, now() + make_interval(secs => ${RUN_LOCK_SECONDS}))
        on conflict (key) do update set count = excluded.count, reset_at = excluded.reset_at
          where platform_rate_limit.reset_at <= now() or platform_rate_limit.count = excluded.count
        returning key`;
      return rows.length > 0;
    },

    async renewLease(loopId: string, token: number): Promise<void> {
      await sql`update platform_rate_limit set reset_at = now() + make_interval(secs => ${RUN_LOCK_SECONDS})
        where key = ${runKey(loopId)} and count = ${token}`;
    },

    async releaseLease(loopId: string, token: number): Promise<void> {
      await sql`delete from platform_rate_limit where key = ${runKey(loopId)} and count = ${token}`;
    },

    async markAlive(loopId: string): Promise<void> {
      await sql`insert into platform_rate_limit (key, count, reset_at)
        values (${aliveKey(loopId)}, 1, now() + make_interval(secs => ${STALE_TICK_SECONDS}))
        on conflict (key) do update set reset_at = excluded.reset_at`;
    },

    async clearAlive(loopId: string): Promise<void> {
      await sql`delete from platform_rate_limit where key = ${aliveKey(loopId)}`;
    },

    async alive(loopId: string): Promise<boolean> {
      const rows = await sql`select 1 from platform_rate_limit
        where key = ${aliveKey(loopId)} and reset_at > now()`;
      return rows.length > 0;
    },

    // ── the popcorn_tick rows of scheduled_task ──────────────────────

    async activeLoops(nowIso: string): Promise<Row[]> {
      return sql`select id, expires_at, cadence_minutes, caps, status from agent_loop
        where status = 'active' and expires_at > ${nowIso}`;
    },

    async pendingTasks(): Promise<Row[]> {
      return (await tasks.pending(TASK_POPCORN_TICK)) as unknown as Row[];
    },

    async failTask(id: string, error: string, now: string): Promise<void> {
      await tasks.settle(id, now, error);
    },

    async resetStaleClaims(now: string, staleBefore: string): Promise<number> {
      return tasks.resetStaleClaims([TASK_POPCORN_TICK], now, staleBefore);
    },

    async claimDue(now: string, limit: number): Promise<Row[]> {
      return (await tasks.claimDue([TASK_POPCORN_TICK], now, limit)) as unknown as Row[];
    },

    async settleTask(id: string, now: string, error: string | null): Promise<void> {
      await tasks.settle(id, now, error);
    },
  };
}

export type TickStore = ReturnType<typeof tickStore>;
export type { Json };
