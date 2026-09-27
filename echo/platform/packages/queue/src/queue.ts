import {
  context,
  correlation,
  inSpan,
  type Logger,
  propagation,
  type Tracer,
  withCorrelation,
} from "@echo/observability";
import { PgBoss } from "pg-boss";
import type postgres from "postgres";
import type { JobDefinition, Parsed, Payload } from "./define";

/** What travels with every job besides its payload, so the job's logs and spans join the request that caused it. */
interface Envelope {
  readonly payload: unknown;
  readonly meta: { readonly causedByRequestId?: string; readonly carrier: Record<string, string> };
}

export interface EnqueueOptions {
  /** Enqueue inside the caller's transaction: the job exists only if the transaction commits. */
  readonly tx?: postgres.TransactionSql | postgres.Sql;
  readonly singletonKey?: string;
  readonly startAfter?: Date | number;
  readonly priority?: number;
}

export interface WorkOptions {
  /** Jobs this instance runs at once for this queue. */
  readonly concurrency: number;
}

export interface QueueHealth {
  readonly name: string;
  readonly ready: number;
  readonly active: number;
  readonly failed: number;
  readonly deferred: number;
}

/** Creates or upgrades pg-boss's schema. Run by the migration job with the owner login. */
export async function installQueueSchema(
  connectionString: string,
  schema = "pgboss",
): Promise<void> {
  const boss = new PgBoss({
    connectionString,
    schema,
    max: 1,
    supervise: false,
    schedule: false,
    migrate: true,
    createSchema: true,
  });
  await boss.start();
  await boss.stop({ graceful: false });
}

export class Queue {
  private readonly boss: PgBoss;
  private readonly defs = new Map<string, JobDefinition>();

  constructor(
    connectionString: string,
    private readonly logger: Logger,
    private readonly tracer: Tracer,
    opts: {
      readonly schema?: string;
      readonly maxConnections?: number;
      /** Local and tests only. In deployed environments the migration job owns the schema and the app login has no DDL rights. */
      readonly manageSchema?: boolean;
    } = {},
  ) {
    const manage = opts.manageSchema ?? false;
    this.boss = new PgBoss({
      connectionString,
      schema: opts.schema ?? "pgboss",
      max: opts.maxConnections ?? 4,
      application_name: "echo-queue",
      migrate: manage,
      createSchema: manage,
    });
    this.boss.on("error", (err) => this.logger.error({ err }, "queue error"));
  }

  async start(defs: readonly JobDefinition[]): Promise<void> {
    await this.boss.start();
    for (const def of defs) {
      this.defs.set(def.name, def);
      const deadLetter = `${def.name}.dead`;
      await this.boss.createQueue(deadLetter, { policy: "standard", retentionSeconds: 14 * 86400 });
      await this.boss.createQueue(def.name, {
        policy: def.policy,
        retryLimit: def.retryLimit,
        retryDelay: def.retryDelaySeconds,
        retryBackoff: def.retryBackoff,
        expireInSeconds: def.expireInSeconds,
        deadLetter,
      });
    }
  }

  async enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts: EnqueueOptions = {},
  ): Promise<string | null> {
    const parsed = def.schema.parse(payload);
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    const c = correlation();
    const envelope: Envelope = {
      payload: parsed,
      meta: { ...(c?.requestId && { causedByRequestId: c.requestId }), carrier },
    };
    return this.boss.send(def.name, envelope, {
      ...(opts.singletonKey && { singletonKey: opts.singletonKey }),
      ...(opts.startAfter !== undefined && {
        startAfter: opts.startAfter instanceof Date ? opts.startAfter : opts.startAfter,
      }),
      ...(opts.priority !== undefined && { priority: opts.priority }),
      ...(opts.tx && { db: adapt(opts.tx) }),
    });
  }

  /** Runs handler for each job of def. Correlation, span, logging and payload checks are done here, once. */
  async work<J extends JobDefinition>(
    def: J,
    opts: WorkOptions,
    handler: (
      payload: Parsed<J>,
      job: { id: string; attempt: number; signal: AbortSignal },
    ) => Promise<void>,
  ): Promise<void> {
    await this.boss.work<Envelope>(
      def.name,
      { localConcurrency: opts.concurrency, batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) {
          const { payload, meta } = job.data;
          const parent = propagation.extract(context.active(), meta?.carrier ?? {});
          await context.with(parent, () =>
            inSpan(
              this.tracer,
              `job ${def.name}`,
              { "job.id": job.id, "job.attempt": job.retryCount },
              async (span) => {
                const sc = span.spanContext();
                await withCorrelation(
                  {
                    requestId: job.id,
                    traceId: sc.traceId,
                    spanId: sc.spanId,
                    ...(meta?.causedByRequestId && { causedByRequestId: meta.causedByRequestId }),
                  },
                  async () => {
                    const started = performance.now();
                    try {
                      const data = def.schema.parse(payload) as Parsed<J>;
                      await handler(data, {
                        id: job.id,
                        attempt: job.retryCount,
                        signal: job.signal,
                      });
                      this.logger.info(
                        {
                          job: def.name,
                          attempt: job.retryCount,
                          ms: Math.round(performance.now() - started),
                        },
                        "job done",
                      );
                    } catch (err) {
                      this.logger.warn(
                        { err, job: def.name, attempt: job.retryCount },
                        "job failed",
                      );
                      throw err;
                    }
                  },
                );
              },
            ),
          );
        }
      },
    );
  }

  /** Cron schedule in a named timezone. pg-boss runs each tick once across all instances. */
  async schedule<J extends JobDefinition>(
    def: J,
    cron: string,
    payload: Payload<J>,
    tz = "Europe/Amsterdam",
  ): Promise<void> {
    await this.boss.schedule(
      def.name,
      cron,
      { payload: def.schema.parse(payload), meta: { carrier: {} } },
      { tz },
    );
  }

  async health(): Promise<QueueHealth[]> {
    const queues = await this.boss.getQueues([...this.defs.keys()]);
    return queues.map((q) => ({
      name: q.name,
      ready: q.readyCount,
      active: q.activeCount,
      failed: q.failedCount,
      deferred: q.deferredCount,
    }));
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 8000 });
  }
}

/** pg-boss's database interface over a postgres.js connection or transaction. */
function adapt(sql: postgres.TransactionSql | postgres.Sql) {
  return {
    executeSql: async (text: string, values: unknown[] = []) => ({
      rows: (await sql.unsafe(
        text,
        values as postgres.ParameterOrJSON<never>[],
      )) as unknown as unknown[],
    }),
  };
}
