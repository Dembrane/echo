import { createHash } from "node:crypto";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { DrizzleAccessStore } from "@dembrane/access";
import {
  type AnalysisRuntime,
  analysisRuntime,
  type ExecutorDeps,
  type JobSink,
  type RuntimeDeps,
  type SnapshotHook,
} from "@dembrane/analysis";
import type { Db } from "@dembrane/db";
import type { Completer } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import {
  defineJob,
  type JobDefinition,
  type Queue,
  step,
  WORKFLOW_VERSION,
  workflow,
} from "@dembrane/queue";
import { z } from "zod";
import { analysisDeck, type DeckAnalysis, deckViewHook } from "./deck";
import { publishNudge } from "./events";
import { popcornTick } from "./jobs";
import { dict, orStr, pyIso } from "./py";
import type { PopcornFlags } from "./service";
import { client, popcornStore, type Row } from "./storage";
import { PopcornModel } from "./tick/model";
import { reconcileMissingTicks, runPopcornTick, type TickDeps } from "./tick/run";
import { tickStore } from "./tick/storage";

/**
 * The popcorn tick in the worker. An API dispatch enqueues `popcorn.tick`; its handler
 * starts the tick workflow by name with an id derived from the request id, and the
 * backup scheduled_task row carries the same request id, so whichever delivery comes
 * second joins the first run instead of reading twice. The live chain's rows (no request
 * id) are claimed once a minute and each starts its own workflow; a reconciler gives an
 * active loop that lost its next row a new one, once a minute as the Python scheduler did.
 */

export const TICK_WORKFLOW = "popcorn.tick.run";

/** Every minute: turn due popcorn_tick rows of scheduled_task into tick workflows. */
export const popcornScheduledTicks = defineJob("popcorn.scheduled-ticks", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

/** Every minute: an active loop without a pending row gets one. */
export const popcornReconcileTicks = defineJob("popcorn.reconcile-ticks", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

const STALE_CLAIM_MS = 15 * 60_000;

export interface PopcornWorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly completer: Completer;
  readonly flags: PopcornFlags;
  readonly participantBaseUrl: string;
  readonly adminBaseUrl: string;
  /** Where tick workflows are enqueued: the worker's own database. */
  readonly databaseUrl: string;
  /** The analysis store the tick reads the deck from and publishes through, on the worker's queue. */
  readonly analysis: (jobs: JobSink) => TickAnalysis;
  /** The inbox message to the project's people when the read of a booked start is in. */
  readonly notifyReady?: (o: { projectId: string; reportId: string }) => Promise<void>;
  readonly now?: () => Date;
}

/** What Present does around a read: bind its results to the presentation, and ask for a map. */
export interface Adoption {
  /** adopt_results: the first results a read produced, or the newest of every outcome. */
  adopt(report: Row, projectId: string, newest: boolean): Promise<void>;
  requestMap(projectId: string, actorId: string | null): Promise<void>;
}

export interface TickAnalysis {
  readonly deck: DeckAnalysis;
  /** Null runs the tick on the session's state alone, publishing nothing. */
  readonly executor: ExecutorDeps | null;
  /** Present's adoption, composed where Present is (it reads the map as well as the deck). */
  readonly adopt?: Adoption | null;
}

/** The tick's analysis on the analysis runtime: the executor every recipe runs on. */
export function runtimeAnalysis(
  d: Omit<RuntimeDeps, "jobs">,
  adoption?: (rt: AnalysisRuntime, deck: DeckAnalysis, jobs: JobSink) => Adoption,
): (jobs: JobSink) => TickAnalysis {
  return (jobs) => {
    const rt = analysisRuntime({ ...d, jobs });
    const deck = analysisDeck(rt.store);
    return { deck, executor: rt.executor, adopt: adoption?.(rt, deck, jobs) ?? null };
  };
}

/**
 * Wakes the screens following the project's popcorn session, for a change outside the deck
 * (a map group made, titled or failed): the room, the public page and the Present preview
 * reread what they show. Best effort: a failed lookup is logged, and the screens' safety
 * reread catches up.
 */
export function popcornProjectNudge(db: Db, logger: Logger): (projectId: string) => Promise<void> {
  const sql = client(db);
  const store = popcornStore(sql);
  return async (projectId) => {
    try {
      const report = await store.popcornReport(projectId);
      if (report) await publishNudge(sql, String(report.id), logger);
    } catch (err) {
      logger.warn({ err, project_id: projectId }, "popcorn nudge failed");
    }
  };
}

/**
 * The deck view follows its producers (bundle.py deck_view_hook): the analysis outbox runs
 * this after each publication, and the screens of the project's popcorn session reread.
 */
export function popcornDeckHook(db: Db, logger: Logger): SnapshotHook {
  const sql = client(db);
  const store = popcornStore(sql);
  return deckViewHook(async (projectId) => {
    const report = await store.popcornReport(projectId);
    if (report) await publishNudge(sql, String(report.id), logger);
  });
}

export interface TickArgs {
  readonly workflowId: string;
  readonly loopId: string;
  readonly tickKind: string;
  readonly requestId: string | null;
}

/** One id per request, so both deliveries of an on-request tick are one run. */
export function tickWorkflowId(requestId: string | null, taskId?: string): string {
  return requestId ? `popcorn-tick:${requestId}` : `popcorn-tick-task:${taskId ?? "none"}`;
}

/** The lease token of a workflow: stable across its executions, distinct between workflows. */
export function leaseToken(workflowId: string): number {
  return createHash("sha1").update(workflowId).digest().readInt32BE(0) & 0x7fffffff;
}

export function tickDeps(
  deps: PopcornWorkerDeps,
  workflowId: string,
  analysis: TickAnalysis,
): TickDeps {
  const sql = client(deps.db);
  return {
    sql,
    store: popcornStore(sql),
    ticks: tickStore(sql),
    access: new DrizzleAccessStore(deps.db),
    model: new PopcornModel(deps.completer),
    deck: analysis.deck,
    analysis: analysis.executor,
    adoptResults: analysis.adopt
      ? (r, p, newest) => analysis.adopt?.adopt(r, p, newest) ?? Promise.resolve()
      : null,
    requestMap: analysis.adopt
      ? (p, a) => analysis.adopt?.requestMap(p, a) ?? Promise.resolve()
      : null,
    notifyReady: deps.notifyReady ?? null,
    flags: deps.flags,
    participantBaseUrl: deps.participantBaseUrl,
    adminBaseUrl: deps.adminBaseUrl,
    logger: deps.logger,
    now: deps.now ?? (() => new Date()),
    token: leaseToken(workflowId),
  };
}

/**
 * Claims due popcorn_tick rows and starts one tick each; a row settles once its tick is
 * handed over, as the Python runner settled it once the actor was sent.
 */
export async function dispatchDueTicks(
  deps: PopcornWorkerDeps,
  start: (args: TickArgs) => Promise<void>,
): Promise<number> {
  const ticks = tickStore(client(deps.db));
  const now = (deps.now ?? (() => new Date()))();
  await ticks.resetStaleClaims(pyIso(now), pyIso(new Date(now.getTime() - STALE_CLAIM_MS)));
  const due = await ticks.claimDue(pyIso(now), 50);
  for (const row of due) {
    const payload = dict(row.payload);
    const loopId = orStr(payload.loop_id);
    let error: string | null = null;
    try {
      if (!loopId) throw new Error("popcorn_tick payload missing loop_id");
      const requestId = orStr(payload.request_id) || null;
      await start({
        workflowId: tickWorkflowId(requestId, String(row.id)),
        loopId,
        tickKind: orStr(payload.tick_kind, "scheduled"),
        requestId,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await ticks.settleTask(String(row.id), pyIso(new Date()), error);
  }
  return due.length;
}

export function popcornWorker(deps: PopcornWorkerDeps): {
  jobs: readonly JobDefinition[];
  register(queue: Queue): Promise<void>;
} {
  let dbos: Promise<DBOSClient> | null = null;
  const startTick = async (args: TickArgs) => {
    dbos ??= DBOSClient.create({
      systemDatabaseUrl: deps.databaseUrl,
      systemDatabaseSchemaName: "dbos",
      systemDatabasePoolSize: 2,
      applicationName: "echo",
    });
    await (await dbos).enqueue(
      {
        queueName: popcornTick.name,
        workflowName: TICK_WORKFLOW,
        workflowID: args.workflowId,
        appVersion: WORKFLOW_VERSION,
      },
      args,
    );
  };
  return {
    jobs: [popcornTick, popcornScheduledTicks, popcornReconcileTicks],
    async register(queue) {
      const analysis = deps.analysis(queue);
      // A resumed workflow reruns its one step: the tick is written to be re-read from the
      // state it left, and the lease token it holds is its own.
      workflow(TICK_WORKFLOW, async (args: TickArgs) => {
        const outcome = await step("tick", async () => {
          const result = await runPopcornTick(
            tickDeps(deps, args.workflowId, analysis),
            args.loopId,
            args.tickKind,
            args.requestId,
          );
          return result.status;
        });
        deps.logger.info({ loop_id: args.loopId, outcome }, "popcorn tick finished");
      });
      await queue.work(popcornTick, { concurrency: 8 }, async (p, job) => {
        await startTick({
          workflowId: tickWorkflowId(p.requestId, job.id),
          loopId: p.loopId,
          tickKind: p.tickKind,
          requestId: p.requestId,
        });
      });
      await queue.work(popcornScheduledTicks, { concurrency: 1 }, async () => {
        const n = await dispatchDueTicks(deps, startTick);
        if (n) deps.logger.info({ ticks: n }, "popcorn ticks dispatched");
      });
      await queue.work(popcornReconcileTicks, { concurrency: 1 }, async () => {
        const n = await reconcileMissingTicks(tickDeps(deps, "popcorn-reconcile", analysis));
        if (n) deps.logger.info({ loops: n }, "backfilled popcorn tick rows");
      });
      await queue.schedule(popcornScheduledTicks, "* * * * *", {});
      await queue.schedule(popcornReconcileTicks, "* * * * *", {});
    },
  };
}
