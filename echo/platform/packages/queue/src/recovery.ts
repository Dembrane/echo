import { DBOS } from "@dbos-inc/dbos-sdk";
import { connect } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import type postgres from "postgres";

const BEAT_MS = 10_000;
/** An executor silent this long is presumed dead and its unfinished workflows are resumed elsewhere. */
const DEAD_AFTER_S = 60;
// Any fixed number; every worker must use the same one.
const SWEEP_LOCK = 72_1405_2027;

/**
 * Open-source DBOS resumes a workflow only in a process with the executor id that started
 * it. With many short-lived Cloud Run instances, each gets a unique id and writes a
 * heartbeat; one instance at a time (advisory lock) finds executors whose heartbeat
 * stopped and resumes their unfinished workflows on their queues, where any live worker
 * picks them up. Checkpointed steps are not re-run.
 */
export class ExecutorHeartbeat {
  private readonly sql: postgres.Sql;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    url: string,
    private readonly executorId: string,
    private readonly logger: Logger,
    private readonly timing: { readonly beatMs: number; readonly deadAfterS: number } = {
      beatMs: BEAT_MS,
      deadAfterS: DEAD_AFTER_S,
    },
  ) {
    // connect() reads the Cloud SQL socket form of the URL; bare postgres() would dial
    // localhost:5432 and crash the worker at its first heartbeat.
    this.sql = connect(url, { max: 2, onnotice: () => {} });
  }

  async start(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => {
      void this.beat()
        .then(() => this.sweep())
        .catch((err) => this.logger.warn({ err }, "executor heartbeat failed"));
    }, this.timing.beatMs);
  }

  private async beat() {
    await this.sql`
      insert into dbos_executor_heartbeat (executor_id, last_seen) values (${this.executorId}, now())
      on conflict (executor_id) do update set last_seen = now()`;
  }

  /** Resumes the unfinished workflows of dead executors. Returns how many were resumed. */
  async sweep(): Promise<number> {
    return this.sql.begin(async (tx) => {
      const [lock] = await tx`select pg_try_advisory_xact_lock(${SWEEP_LOCK}) as ok`;
      if (!lock?.ok) return 0;
      const dead = await tx<{ executor_id: string }[]>`
        select executor_id from dbos_executor_heartbeat
        where last_seen < now() - make_interval(secs => ${this.timing.deadAfterS})`;
      let resumed = 0;
      for (const { executor_id } of dead) {
        const pending = await DBOS.listWorkflows({ status: "PENDING", executorId: executor_id });
        for (const wf of pending) {
          await DBOS.resumeWorkflow(wf.workflowID, wf.queueName ? { queueName: wf.queueName } : {});
          resumed++;
        }
        await tx`delete from dbos_executor_heartbeat where executor_id = ${executor_id}`;
        if (pending.length)
          this.logger.warn(
            { deadExecutor: executor_id, resumed: pending.length },
            "resumed workflows of a dead worker",
          );
      }
      return resumed;
    });
  }

  async queueHealth(names: readonly string[]) {
    if (!names.length) return [];
    const rows = await this.sql<
      { queue_name: string; status: string; delayed: boolean; n: number }[]
    >`
      select queue_name, status, (status = 'DELAYED') as delayed, count(*)::int as n
      from dbos.workflow_status
      where queue_name = any(${names as string[]}) and status in ('ENQUEUED', 'DELAYED', 'PENDING', 'ERROR')
        and (status <> 'ERROR' or updated_at > (extract(epoch from now() - interval '1 day') * 1000))
      group by queue_name, status`;
    return names.map((name) => {
      const of = (s: string) =>
        rows.filter((r) => r.queue_name === name && r.status === s).reduce((a, r) => a + r.n, 0);
      return {
        name,
        ready: of("ENQUEUED"),
        active: of("PENDING"),
        failed: of("ERROR"),
        deferred: of("DELAYED"),
      };
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this
      .sql`delete from dbos_executor_heartbeat where executor_id = ${this.executorId}`.catch(
      () => {},
    );
    await this.sql.end();
  }
}

/**
 * An executor id that starts with the build it runs, so a deploy can find its own worker's
 * heartbeat. The release rides in the id, not in a column: a migration ordered after the
 * held contract migration would make drizzle skip that contract at cutover.
 */
export function executorIdFor(release: string | undefined, instance: string): string {
  return release ? `${release}/${instance}` : instance;
}

export interface WorkerFreshness {
  /** Seconds since the newest executor heartbeat (of the given release); null when there is none. */
  readonly ageS: number | null;
  /** Seconds since a job last finished, looking back 15 minutes; null when none did. */
  readonly jobAgeS: number | null;
}

/**
 * How recently a worker proved it is alive: its executor heartbeat, written every 10
 * seconds once the queue runs, and the last finished job (the scheduled heartbeat job
 * finishes every minute). With a release, only executors running that build count, so a
 * deploy can tell the new worker from one left over. The job lookup is bounded by
 * created_at, which DBOS indexes.
 */
export async function workerFreshness(
  sql: postgres.Sql,
  release?: string,
): Promise<WorkerFreshness> {
  const [beat] = await sql<{ age_s: number | null }[]>`
    select extract(epoch from now() - max(last_seen))::float8 as age_s
    from dbos_executor_heartbeat
    where ${release ?? null}::text is null or starts_with(executor_id, ${release ? `${release}/` : null})`;
  const [job] = await sql<{ age_s: number | null }[]>`
    select (extract(epoch from now()) - max(updated_at) / 1000.0)::float8 as age_s
    from dbos.workflow_status
    where status = 'SUCCESS'
      and created_at > (extract(epoch from now() - interval '15 minutes') * 1000)::bigint`;
  return { ageS: beat?.age_s ?? null, jobAgeS: job?.age_s ?? null };
}
