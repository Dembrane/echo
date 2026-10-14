import type postgres from "postgres";

/**
 * One-shot timers in the scheduled_task table: book a task for a time, cancel it, and
 * claim the ones that are due. Every namespace keeps its own task types and runs the rows
 * it claims; this is the one copy of the SQL they share. Times are ISO strings the caller
 * formats, so each namespace's rows keep the format they already carry.
 *
 * Next: canvas and tenancy still carry their own copy of these statements.
 */

/** A row left processing this long is presumed crashed and booked again. */
export const STALE_CLAIM_MS = 15 * 60_000;

export interface ScheduledTask {
  readonly id: string;
  readonly task_type: string;
  readonly payload: Record<string, unknown>;
  /** A Date from the driver, or the text a caller wrote. */
  readonly scheduled_at: string | Date;
  readonly status: string;
  readonly claimed_at: string | null;
  readonly attempts: number | null;
}

export interface CancelOptions {
  /** Only rows whose payload has every key with this text value. */
  readonly match: Readonly<Record<string, string>>;
  /** Rows whose payload has this key set to one of these values are left booked. */
  readonly keep?: { readonly key: string; readonly values: readonly string[] };
}

const due = (t: ScheduledTask) => new Date(t.scheduled_at).getTime();

const row = (r: Record<string, unknown>): ScheduledTask =>
  ({ ...r, payload: (r.payload ?? {}) as Record<string, unknown> }) as ScheduledTask;

/** A connection or an open transaction: a booking can commit with what caused it. */
export type TaskSql = postgres.Sql | postgres.TransactionSql;

export function scheduledTasks(sql: TaskSql) {
  const json = (v: unknown) => sql`${JSON.stringify(v)}::text::json`;
  return {
    /** Books one task; returns its id. */
    async book(o: {
      taskType: string;
      payload: Record<string, unknown>;
      at: string;
      now: string;
      id?: string;
    }): Promise<string> {
      const id = o.id ?? Bun.randomUUIDv7();
      await sql`insert into scheduled_task
        (id, task_type, payload, scheduled_at, status, attempts, created_at, updated_at)
        values (${id}, ${o.taskType}, ${json(o.payload)}, ${o.at}, 'scheduled', 0, ${o.now}, ${o.now})`;
      return id;
    },

    /** Cancels still-booked tasks of a type; a task already claimed runs to its end. */
    async cancel(taskType: string, now: string, o: CancelOptions): Promise<number> {
      const matches = Object.entries(o.match).reduce(
        (acc, [k, v]) => sql`${acc} and payload->>${k} = ${v}`,
        sql``,
      );
      const kept = o.keep?.values.length
        ? sql`and coalesce(payload->>${o.keep.key}, '') not in ${sql([...o.keep.values])}`
        : sql``;
      const rows = await sql`update scheduled_task set status = 'cancelled', updated_at = ${now}
        where task_type = ${taskType} and status = 'scheduled' ${matches} ${kept}
        returning id`;
      return rows.length;
    },

    /** Booked and running tasks of a type, earliest first. */
    async pending(taskType: string): Promise<ScheduledTask[]> {
      const rows =
        await sql`select id, task_type, payload, scheduled_at, status, claimed_at, attempts
        from scheduled_task
        where task_type = ${taskType} and status in ('scheduled', 'processing')
        order by scheduled_at`;
      return rows.map(row);
    },

    async resetStaleClaims(
      taskTypes: readonly string[],
      now: string,
      staleBefore: string,
    ): Promise<number> {
      const rows = await sql`update scheduled_task
        set status = 'scheduled', claimed_at = null, updated_at = ${now}
        where status = 'processing' and claimed_at < ${staleBefore}
          and task_type in ${sql([...taskTypes])}
        returning id`;
      return rows.length;
    },

    /** Claims due tasks, oldest first. SKIP LOCKED: two runners never take the same row. */
    async claimDue(
      taskTypes: readonly string[],
      now: string,
      limit = 50,
    ): Promise<ScheduledTask[]> {
      const rows = await sql`update scheduled_task t
        set status = 'processing', claimed_at = ${now}, attempts = coalesce(t.attempts, 0) + 1,
            updated_at = ${now}
        where t.id in (
          select id from scheduled_task
          where status = 'scheduled' and scheduled_at <= ${now}
            and task_type in ${sql([...taskTypes])}
          order by scheduled_at limit ${limit} for update skip locked)
        returning t.id, t.task_type, t.payload, t.scheduled_at, t.status, t.claimed_at, t.attempts`;
      // RETURNING keeps no order; the runner works through them as they were due.
      return rows.map(row).sort((a, b) => due(a) - due(b));
    },

    /** Marks a claimed task completed, or failed with why. */
    async settle(id: string, now: string, error: string | null): Promise<void> {
      if (error === null)
        await sql`update scheduled_task set status = 'completed', error = null, updated_at = ${now}
          where id = ${id}`;
      else
        await sql`update scheduled_task set status = 'failed', error = ${error.slice(0, 5000)},
          updated_at = ${now} where id = ${id}`;
    },
  };
}

export type ScheduledTasks = ReturnType<typeof scheduledTasks>;

/**
 * One pass of a runner: books stale claims again, claims what is due and hands each task to
 * `run`. A task whose run throws is settled as failed with the message; the pass goes on.
 */
export async function runDueTasks(
  store: ScheduledTasks,
  o: {
    taskTypes: readonly string[];
    now: () => Date;
    iso: (d: Date) => string;
    limit?: number;
    staleMs?: number;
  },
  run: (task: ScheduledTask) => Promise<void>,
): Promise<{ ran: number; failed: number }> {
  const started = o.now();
  await store.resetStaleClaims(
    o.taskTypes,
    o.iso(started),
    o.iso(new Date(started.getTime() - (o.staleMs ?? STALE_CLAIM_MS))),
  );
  const due = await store.claimDue(o.taskTypes, o.iso(started), o.limit ?? 50);
  let failed = 0;
  for (const task of due) {
    let error: string | null = null;
    try {
      await run(task);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      failed += 1;
    }
    await store.settle(task.id, o.iso(o.now()), error);
  }
  return { ran: due.length, failed };
}
