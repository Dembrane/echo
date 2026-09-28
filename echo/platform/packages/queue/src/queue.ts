import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  context,
  correlation,
  inSpan,
  type Logger,
  propagation,
  type Tracer,
  withCorrelation,
} from "@dembrane/observability";
import type postgres from "postgres";
import type { JobDefinition, Parsed, Payload } from "./define";
import { ExecutorHeartbeat } from "./recovery";

/**
 * Bumped by hand when a workflow's sequence of steps changes. DBOS resumes a crashed
 * workflow only under the version that started it; keeping this stable across ordinary
 * deploys lets new code finish old work, and bumping it after a step change stops new
 * code from replaying old checkpoints against a different step order.
 */
export const WORKFLOW_VERSION = "1";
const SCHEMA = "dbos";

interface Envelope {
  readonly payload: unknown;
  readonly meta: { readonly causedByRequestId?: string; readonly carrier: Record<string, string> };
}

export interface EnqueueOptions {
  /** Enqueue inside the caller's transaction: the job exists only if the transaction commits. */
  readonly tx?: postgres.TransactionSql | postgres.Sql;
  /** At most one queued or running job per key. */
  readonly singletonKey?: string;
  readonly startAfter?: Date | number;
  readonly priority?: number;
  /**
   * The run's id. A second enqueue with the same id returns the first run instead of
   * starting another, for as long as DBOS keeps the run; durable workflows use it so a
   * repeated trigger (a retried request, a second finish) is a no-op.
   */
  readonly workflowId?: string;
}

export interface WorkOptions {
  /** Jobs one worker instance runs at once for this queue. */
  readonly concurrency: number;
}

export interface QueueHealth {
  readonly name: string;
  readonly ready: number;
  readonly active: number;
  readonly failed: number;
  readonly deferred: number;
}

type Handler = (
  payload: unknown,
  job: { id: string; attempt: number; signal: AbortSignal },
) => Promise<void>;

/**
 * Jobs and schedules on DBOS: durable, stored in our Postgres, claimed across any number
 * of workers. The API process only enqueues (a client, no executor); the worker registers
 * handlers and then calls run(). Handlers are idempotent on a key the producer sets.
 */
export class Queue {
  private readonly defs = new Map<string, JobDefinition>();
  private readonly concurrency = new Map<string, number>();
  private readonly schedules: { def: JobDefinition; cron: string; payload: unknown; tz: string }[] =
    [];
  private client: DBOSClient | null = null;
  private heartbeat: ExecutorHeartbeat | null = null;
  private running = false;

  constructor(
    private readonly connectionString: string,
    private readonly logger: Logger,
    private readonly tracer: Tracer,
    private readonly opts: {
      readonly maxConnections?: number;
      readonly executorId?: string;
      /** Tests shorten these; production uses the defaults in recovery.ts. */
      readonly recovery?: { readonly beatMs: number; readonly deadAfterS: number };
      /** How often an idle worker checks each queue; lower in tests, DBOS's default in production. */
      readonly pollingIntervalMs?: number;
    } = {},
  ) {}

  /** Declares the jobs this process knows. Enqueue-only processes stop here. */
  async start(defs: readonly JobDefinition[]): Promise<void> {
    for (const d of defs) this.defs.set(d.name, d);
    this.client = await DBOSClient.create({
      systemDatabaseUrl: this.connectionString,
      systemDatabaseSchemaName: SCHEMA,
      systemDatabasePoolSize: this.opts.maxConnections ?? 4,
      applicationName: "echo",
    });
  }

  async enqueue<J extends JobDefinition>(
    def: J,
    payload: Payload<J>,
    opts: EnqueueOptions = {},
  ): Promise<string | null> {
    if (!this.client) throw new Error("queue not started");
    const parsed = def.schema.parse(payload);
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    const c = correlation();
    const envelope: Envelope = {
      payload: parsed,
      meta: { ...(c?.requestId && { causedByRequestId: c.requestId }), carrier },
    };
    const delay =
      opts.startAfter === undefined
        ? undefined
        : Math.max(
            0,
            Math.round(
              ((opts.startAfter instanceof Date ? opts.startAfter.getTime() : opts.startAfter) -
                Date.now()) /
                1000,
            ),
          );
    const options = {
      queueName: def.name,
      workflowName: def.name,
      appVersion: WORKFLOW_VERSION,
      workflowTimeoutMS: def.expireInSeconds * 1000 * (def.retryLimit + 1),
      ...(opts.singletonKey && {
        deduplicationID: `${def.name}:${opts.singletonKey}`,
        duplicationPolicy: "return-existing" as const,
      }),
      ...(opts.priority !== undefined && { priority: opts.priority }),
      ...(delay && { delaySeconds: delay }),
      ...(opts.workflowId && { workflowID: opts.workflowId }),
    };
    const handle = opts.tx
      ? await this.client.enqueueInTransaction(adaptTx(opts.tx) as never, options, envelope)
      : await this.client.enqueue(options, envelope);
    return handle.workflowID;
  }

  /** Registers a handler; must be called before run(). */
  async work<J extends JobDefinition>(
    def: J,
    opts: WorkOptions,
    handler: (
      payload: Parsed<J>,
      job: { id: string; attempt: number; signal: AbortSignal },
    ) => Promise<void>,
  ): Promise<void> {
    if (this.running) throw new Error(`register ${def.name} before run()`);
    this.defs.set(def.name, def);
    this.concurrency.set(def.name, opts.concurrency);
    const run = this.wrap(def, handler as Handler);
    DBOS.registerWorkflow(
      async (envelope: Envelope) => {
        let attempt = 0;
        await DBOS.runStep(() => run(envelope, attempt++), {
          name: def.name,
          retriesAllowed: def.retryLimit > 0,
          maxAttempts: def.retryLimit + 1,
          intervalSeconds: def.retryDelaySeconds,
          backoffRate: def.retryBackoff ? 2 : 1,
        });
      },
      { name: def.name },
    );
  }

  /**
   * Registers a durable workflow on the job's queue. Unlike work(), the handler is not one
   * step: it calls step() for each side effect, DBOS checkpoints each result, and a crash
   * resumes at the first unfinished step. Retries belong to the steps; the def's
   * expireInSeconds bounds the whole run.
   */
  async workflow<J extends JobDefinition>(
    def: J,
    opts: WorkOptions,
    handler: (
      payload: Parsed<J>,
      job: { id: string; attempt: number; signal: AbortSignal },
    ) => Promise<void>,
  ): Promise<void> {
    if (this.running) throw new Error(`register ${def.name} before run()`);
    this.defs.set(def.name, def);
    this.concurrency.set(def.name, opts.concurrency);
    const run = this.wrap(def, handler as Handler);
    DBOS.registerWorkflow(async (envelope: Envelope) => run(envelope, 0), { name: def.name });
  }

  /** A cron schedule in a named timezone; each tick runs once across all instances. */
  async schedule<J extends JobDefinition>(
    def: J,
    cron: string,
    payload: Payload<J>,
    tz = "Europe/Amsterdam",
  ): Promise<void> {
    if (this.running) throw new Error(`schedule ${def.name} before run()`);
    this.schedules.push({ def, cron, payload: def.schema.parse(payload), tz });
  }

  /** Starts executing: launches DBOS, registers queues and schedules, and starts dead-worker recovery. */
  async run(): Promise<void> {
    const executorId =
      this.opts.executorId ??
      `${process.env.HOSTNAME ?? "worker"}-${crypto.randomUUID().slice(0, 8)}`;
    const scheduled = this.schedules.map((s) => {
      const fn = DBOS.registerWorkflow(
        async (_at: Date, _ctx: unknown) => {
          const run = this.wrap(s.def, this.handlerFor(s.def));
          await DBOS.runStep(() => run({ payload: s.payload, meta: { carrier: {} } }, 0), {
            name: s.def.name,
          });
        },
        { name: `${s.def.name}.scheduled` },
      );
      return { s, fn };
    });
    DBOS.setConfig({
      name: "echo",
      systemDatabaseUrl: this.connectionString,
      systemDatabaseSchemaName: SCHEMA,
      systemDatabasePoolSize: this.opts.maxConnections ?? 4,
      applicationVersion: WORKFLOW_VERSION,
      executorID: executorId,
      runAdminServer: false,
      logLevel: "warn",
    });
    await DBOS.launch();
    this.running = true;
    for (const [name, workerConcurrency] of this.concurrency) {
      await DBOS.registerQueue(name, {
        workerConcurrency,
        ...(this.opts.pollingIntervalMs !== undefined && {
          minPollingIntervalMs: this.opts.pollingIntervalMs,
        }),
      });
    }
    await DBOS.applySchedules(
      scheduled.map(({ s, fn }) => ({
        scheduleName: s.def.name,
        workflowFn: fn,
        schedule: s.cron,
        cronTimezone: s.tz,
        automaticBackfill: false,
      })),
    );
    this.heartbeat = new ExecutorHeartbeat(
      this.connectionString,
      executorId,
      this.logger,
      this.opts.recovery,
    );
    await this.heartbeat.start();
    this.logger.info(
      { executorId, jobs: [...this.concurrency.keys()], schedules: this.schedules.length },
      "queue running",
    );
  }

  async health(): Promise<QueueHealth[]> {
    if (!this.heartbeat) return [];
    return this.heartbeat.queueHealth([...this.defs.keys()]);
  }

  async stop(): Promise<void> {
    await this.heartbeat?.stop();
    if (this.running) await DBOS.shutdown();
    await this.client?.destroy();
  }

  private readonly handlers = new Map<string, Handler>();
  private handlerFor(def: JobDefinition): Handler {
    const h = this.handlers.get(def.name);
    if (!h) throw new Error(`no handler registered for scheduled job ${def.name}`);
    return h;
  }

  /** Correlation, span, payload check and logging, done once for every job. */
  private wrap(def: JobDefinition, handler: Handler) {
    this.handlers.set(def.name, handler);
    return async (envelope: Envelope, attempt: number) => {
      const jobId = DBOS.workflowID ?? "unknown";
      const parent = propagation.extract(context.active(), envelope.meta?.carrier ?? {});
      await context.with(parent, () =>
        inSpan(
          this.tracer,
          `job ${def.name}`,
          { "job.id": jobId, "job.attempt": attempt },
          async (span) => {
            const sc = span.spanContext();
            await withCorrelation(
              {
                requestId: jobId,
                traceId: sc.traceId,
                spanId: sc.spanId,
                ...(envelope.meta?.causedByRequestId && {
                  causedByRequestId: envelope.meta.causedByRequestId,
                }),
              },
              async () => {
                const started = performance.now();
                try {
                  await handler(def.schema.parse(envelope.payload), {
                    id: jobId,
                    attempt,
                    signal: new AbortController().signal,
                  });
                  this.logger.info(
                    { job: def.name, attempt, ms: Math.round(performance.now() - started) },
                    "job done",
                  );
                } catch (err) {
                  this.logger.warn({ err, job: def.name, attempt }, "job failed");
                  throw err;
                }
              },
            );
          },
        ),
      );
    };
  }
}

/** A node-postgres-shaped client over a postgres.js connection or transaction, for enqueueInTransaction. */
function adaptTx(sql: postgres.TransactionSql | postgres.Sql) {
  return {
    query: async (text: string, values: unknown[] = []) => {
      const rows = await sql.unsafe(text, values as postgres.ParameterOrJSON<never>[]);
      return { rows: rows as unknown as unknown[], rowCount: rows.count };
    },
  };
}

/**
 * Creates or upgrades the DBOS system schema. Run by the migration job with the owner
 * login: only a launch runs DBOS's migrations, so it launches with no workflows under
 * its own executor id and shuts down again.
 */
export async function installQueueSchema(connectionString: string): Promise<void> {
  DBOS.setConfig({
    name: "echo",
    systemDatabaseUrl: connectionString,
    systemDatabaseSchemaName: SCHEMA,
    applicationVersion: WORKFLOW_VERSION,
    executorID: "migrate",
    runAdminServer: false,
    logLevel: "warn",
  });
  await DBOS.launch();
  await DBOS.shutdown();
}
