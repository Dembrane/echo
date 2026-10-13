import { DBOS } from "@dbos-inc/dbos-sdk";
import { connect } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import type postgres from "postgres";
import { DEFAULT_LOST_WORKER_LIMIT } from "./define";

const BEAT_MS = 10_000;
/** An executor silent this long is presumed dead and its unfinished workflows are resumed elsewhere. */
const DEAD_AFTER_S = 60;
// Any fixed number; every worker must use the same one.
const SWEEP_LOCK = 72_1405_2027;

/** What recovery reads of a workflow it found running on a dead executor. */
export interface LostWorkflow {
  readonly workflowID: string;
  readonly workflowName: string;
  readonly queueName?: string;
}

/**
 * Open-source DBOS resumes a workflow only in a process with the executor id that started
 * it. With many short-lived Cloud Run instances, each gets a unique id and writes a
 * heartbeat; one instance at a time (advisory lock) finds executors whose heartbeat
 * stopped and resumes their unfinished workflows on their queues, where any live worker
 * picks them up. Checkpointed steps are not re-run.
 *
 * A workflow found on a dead executor has lost a worker, and that is counted per workflow.
 * Past its job's limit it is set aside instead of resumed: cancelled, which ends recovery
 * and leaves it for a person to resume, so a run that cannot finish stops taking workers
 * from the other jobs. Everything a worker was running loses that worker with it, so one
 * sweep sets aside only the workflows that lost a worker most often among those past their
 * limit. A run that merely shared the worker finishes or waits in its queue between two
 * losses, and its count stays behind.
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
    /** The job's lostWorkerLimit; the queue resolves it from its job definitions. */
    private readonly limitOf: (wf: LostWorkflow) => number = () => DEFAULT_LOST_WORKER_LIMIT,
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

  /**
   * Resumes the unfinished workflows of dead executors, except those it sets aside for
   * losing their worker too often. Returns how many were resumed.
   */
  async sweep(): Promise<number> {
    return this.sql.begin(async (tx) => {
      const [lock] = await tx`select pg_try_advisory_xact_lock(${SWEEP_LOCK}) as ok`;
      if (!lock?.ok) return 0;
      await this.forgetSettled(tx);
      const dead = await tx<{ executor_id: string }[]>`
        select executor_id from dbos_executor_heartbeat
        where last_seen < now() - make_interval(secs => ${this.timing.deadAfterS})`;
      let resumed = 0;
      for (const { executor_id } of dead) {
        const pending = await DBOS.listWorkflows({ status: "PENDING", executorId: executor_id });
        const lost = await this.countLosses(tx, pending);
        const aside = this.pastLimit(pending, lost);
        let resumedHere = 0;
        for (const wf of pending) {
          if (aside.has(wf.workflowID)) {
            await this.setAside(tx, wf, lost.get(wf.workflowID) ?? 0);
            continue;
          }
          await DBOS.resumeWorkflow(wf.workflowID, wf.queueName ? { queueName: wf.queueName } : {});
          resumedHere++;
        }
        await tx`delete from dbos_executor_heartbeat where executor_id = ${executor_id}`;
        if (resumedHere)
          this.logger.warn(
            { deadExecutor: executor_id, resumed: resumedHere },
            "resumed workflows of a dead worker",
          );
        resumed += resumedHere;
      }
      return resumed;
    });
  }

  /**
   * Drops the counts nothing reads any more: of a workflow that finished, and of a set-aside
   * one a person resumed or deleted. Runs before counting, so a run a person resumed starts
   * from zero if it loses a worker again.
   */
  private async forgetSettled(tx: postgres.TransactionSql) {
    await tx`
      delete from dbos_workflow_lost_worker c
      where not exists (
        select 1 from dbos.workflow_status w
        where w.workflow_uuid = c.workflow_id
          and w.status = any(case when c.set_aside_at is null
            then array['PENDING', 'ENQUEUED', 'DELAYED'] else array['CANCELLED'] end))`;
  }

  /** Adds one lost worker to each workflow and returns the new counts by workflow id. */
  private async countLosses(
    tx: postgres.TransactionSql,
    pending: readonly LostWorkflow[],
  ): Promise<Map<string, number>> {
    if (!pending.length) return new Map();
    const rows = pending.map((wf) => ({
      workflow_id: wf.workflowID,
      queue_name: wf.queueName ?? null,
      lost: 1,
    }));
    const counted = await tx<{ workflow_id: string; lost: number }[]>`
      insert into dbos_workflow_lost_worker ${tx(rows)}
      on conflict (workflow_id) do update
        set lost = dbos_workflow_lost_worker.lost + 1, queue_name = excluded.queue_name
      returning workflow_id, lost`;
    return new Map(counted.map((r) => [r.workflow_id, r.lost]));
  }

  /**
   * The workflows to set aside: of those past their own limit, the ones that lost a worker
   * most often. Others past their limit are resumed and judged again at their next loss.
   */
  private pastLimit(
    pending: readonly LostWorkflow[],
    lost: ReadonlyMap<string, number>,
  ): Set<string> {
    const count = (wf: LostWorkflow) => lost.get(wf.workflowID) ?? 0;
    const over = pending.filter((wf) => count(wf) > this.limitOf(wf));
    const most = Math.max(0, ...over.map(count));
    return new Set(over.filter((wf) => count(wf) === most).map((wf) => wf.workflowID));
  }

  /**
   * Cancels the workflow, which ends automatic recovery and keeps its checkpoints: a person
   * resumes it with DBOS.resumeWorkflow on the queue kept in its count row.
   */
  private async setAside(tx: postgres.TransactionSql, wf: LostWorkflow, lost: number) {
    await DBOS.cancelWorkflow(wf.workflowID);
    await tx`
      update dbos_workflow_lost_worker set set_aside_at = now() where workflow_id = ${wf.workflowID}`;
    this.logger.error(
      {
        signal: "queue.job_set_aside",
        job: wf.workflowName,
        queue: wf.queueName ?? null,
        job_id: wf.workflowID,
        lost,
        limit: this.limitOf(wf),
      },
      "job set aside after losing its worker repeatedly",
    );
  }

  async queueHealth(names: readonly string[]) {
    if (!names.length) return [];
    const rows = await this.sql<
      { queue_name: string; status: string; delayed: boolean; n: number; oldest_s: number | null }[]
    >`
      select queue_name, status, (status = 'DELAYED') as delayed, count(*)::int as n,
        (extract(epoch from now()) - min(created_at) / 1000.0)::float8 as oldest_s
      from dbos.workflow_status
      where queue_name = any(${names as string[]}) and status in ('ENQUEUED', 'DELAYED', 'PENDING', 'ERROR')
        and (status <> 'ERROR' or updated_at > (extract(epoch from now() - interval '1 day') * 1000))
      group by queue_name, status`;
    const aside = await this.sql<{ queue_name: string; n: number }[]>`
      select queue_name, count(*)::int as n from dbos_workflow_lost_worker
      where queue_name = any(${names as string[]}) and set_aside_at > now() - interval '1 day'
      group by queue_name`;
    return names.map((name) => {
      const of = (s: string) =>
        rows.filter((r) => r.queue_name === name && r.status === s).reduce((a, r) => a + r.n, 0);
      const oldest = (q: string) => {
        const r = rows.find((r) => r.queue_name === q && r.status === "ENQUEUED");
        return r?.oldest_s == null ? null : Math.round(r.oldest_s);
      };
      return {
        name,
        ready: of("ENQUEUED"),
        active: of("PENDING"),
        failed: of("ERROR"),
        deferred: of("DELAYED"),
        setAside: aside.find((r) => r.queue_name === name)?.n ?? 0,
        oldestReadyS: oldest(name),
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
