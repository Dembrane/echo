import { DrizzleAccessStore } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import type { Completer } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import { defineJob, type JobDefinition, type Queue, step } from "@dembrane/queue";
import { PostgresRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { z } from "zod";
import { publishGenerationNudge } from "./events";
import { dict, orStr, utcNowIso } from "./py";
import { canvasStore, client } from "./storage";
import {
  createRun,
  derivedId,
  enqueueNextIfDue,
  extractTick,
  failTick,
  gatherTick,
  nothingNew,
  prepareTick,
  reconcileMissingTicks,
  storeTick,
  type TickDeps,
} from "./ticks";

/**
 * One canvas tick as a durable workflow. The Dramatiq actor had a 60-minute time limit;
 * each step now carries that limit, and a worker that dies mid-tick is resumed at the
 * step it was in: the model calls are not paid for twice and committed rows are not
 * written twice (every row the tick writes has an id derived from the workflow id).
 */
export const canvasTick = defineJob(
  "canvas.tick",
  z.object({ loopId: z.string(), tickKind: z.string() }),
  { retryLimit: 0, expireInSeconds: 4 * 60 * 60 },
);

/** Every minute: turn due canvas_tick rows of scheduled_task into tick workflows. */
export const canvasScheduledTicks = defineJob("canvas.scheduled-ticks", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

/** Every five minutes: give every active loop that lost its next tick a new one. */
export const canvasReconcileTicks = defineJob("canvas.reconcile-ticks", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});

/** Jobs the API enqueues (the manual refresh). */
export const canvasApiJobs: readonly JobDefinition[] = [canvasTick];

const STEP = { timeoutMS: 60 * 60 * 1000 };
const STALE_CLAIM_MS = 15 * 60_000;
const WINDOW_LIMIT = "canvas_tick_window";

export interface CanvasWorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly completer: Completer;
  readonly canvasEnabled: boolean;
  readonly now?: () => Date;
}

/** Tick dependencies for one workflow run; ids derive from its workflow id. */
export function tickDeps(deps: CanvasWorkerDeps, runId: string): TickDeps {
  const sql = client(deps.db);
  const limiter = new RateLimiter(new PostgresRateCounter(deps.db));
  return {
    store: canvasStore(sql),
    accessStore: new DrizzleAccessStore(deps.db),
    completer: deps.completer,
    canvasEnabled: deps.canvasEnabled,
    now: deps.now ?? (() => new Date()),
    nudge: (reportId) => publishGenerationNudge(sql, reportId, deps.logger),
    claimWindow: (loopId, window, ttl) =>
      limiter.allow({ name: WINDOW_LIMIT, capacity: 1, windowSeconds: ttl }, `${loopId}:${window}`),
    idFor: (label) => derivedId(`${runId}:${label}`),
  };
}

/** The workflow body: the tick's phases as checkpointed steps. */
export async function tickWorkflow(d: TickDeps, loopId: string, tickKind: string): Promise<string> {
  const prepared = await step("prepare", () => prepareTick(d, loopId, tickKind), STEP);
  if (prepared.outcome !== "continue") return prepared.outcome;
  const plan = prepared.plan;
  const next = () =>
    step("schedule-next", () => enqueueNextIfDue(d, loopId, null, d.idFor("next")), STEP);
  let configId: string | null = null;
  try {
    const g = await step("gather", () => gatherTick(d, plan), STEP);
    configId = g.config.id ? String(g.config.id) : null;
    if (nothingNew(plan, g)) {
      await step(
        "no-new-content",
        () =>
          createRun(d, {
            label: "gather",
            loopId,
            status: "no_op",
            startedAt: plan.startedAt,
            detail: "No new gathered content since latest generation",
          }),
        STEP,
      );
      await next();
      return "no_op";
    }
    const extracted = await step("extract", () => extractTick(d, plan, g), STEP);
    if ("failed" in extracted) {
      await step(
        "extract-failed",
        () =>
          createRun(d, {
            label: "extract",
            loopId,
            status: "no_op",
            startedAt: plan.startedAt,
            detail: extracted.failed,
          }),
        STEP,
      );
      await next();
      return "no_op";
    }
    const outcome = await step("store", () => storeTick(d, plan, g, extracted), STEP);
    await next();
    return outcome;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await step("fail", () => failTick(d, plan, configId, detail), STEP);
    await next();
    return "error";
  }
}

/** Claims due canvas_tick rows and starts one workflow per row. */
export async function dispatchDueTicks(
  deps: CanvasWorkerDeps,
  start: (loopId: string, tickKind: string, taskId: string) => Promise<void>,
): Promise<number> {
  const store = canvasStore(client(deps.db));
  const now = (deps.now ?? (() => new Date()))();
  await store.resetStaleClaims(utcNowIso(now), utcNowIso(new Date(now.getTime() - STALE_CLAIM_MS)));
  const due = await store.claimDueTicks(utcNowIso(now), 50);
  for (const row of due) {
    const payload = dict(row.payload);
    const loopId = orStr(payload.loop_id);
    let error: string | null = null;
    try {
      if (!loopId) throw new Error("canvas_tick payload missing loop_id");
      await start(loopId, orStr(payload.tick_kind, "scheduled"), String(row.id));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await store.settleTask(String(row.id), utcNowIso(new Date()), error);
  }
  return due.length;
}

export function canvasWorker(deps: CanvasWorkerDeps) {
  return {
    jobs: [canvasTick, canvasScheduledTicks, canvasReconcileTicks] as JobDefinition[],
    async register(queue: Queue) {
      await queue.workflow(canvasTick, { concurrency: 4 }, async (p, job) => {
        const outcome = await tickWorkflow(tickDeps(deps, job.id), p.loopId, p.tickKind);
        deps.logger.info({ loop_id: p.loopId, outcome }, "canvas tick finished");
      });
      await queue.work(canvasScheduledTicks, { concurrency: 1 }, async () => {
        const n = await dispatchDueTicks(deps, async (loopId, tickKind, taskId) => {
          // One workflow per scheduled row, even if the row is claimed twice after a crash.
          await queue.enqueue(canvasTick, { loopId, tickKind }, { singletonKey: taskId });
        });
        if (n) deps.logger.info({ ticks: n }, "canvas ticks dispatched");
      });
      await queue.work(canvasReconcileTicks, { concurrency: 1 }, async () => {
        const n = await reconcileMissingTicks(tickDeps(deps, "reconcile"));
        if (n) deps.logger.info({ loops: n }, "backfilled canvas tick rows");
      });
      await queue.schedule(canvasScheduledTicks, "* * * * *", {});
      await queue.schedule(canvasReconcileTicks, "*/5 * * * *", {});
    },
  };
}
