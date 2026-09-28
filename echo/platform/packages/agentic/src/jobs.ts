import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { Access, DrizzleAccessStore } from "@echo/access";
import { type Capture, posthogCapture } from "@echo/analytics";
import type { Config } from "@echo/config";
import type { Db } from "@echo/db";
import type { Signed } from "@echo/http";
import type { Models } from "@echo/llm";
import { Notifier } from "@echo/notifications";
import type { Logger } from "@echo/observability";
import {
  defineJob,
  type JobDefinition,
  type Queue,
  step,
  WORKFLOW_VERSION,
  workflow,
} from "@echo/queue";
import { z } from "zod";
import { createAgent } from "./agent";
import type { AgentData, TurnContext } from "./agent/data";
import type { Agent } from "./agent/types";
import { bindAgentData } from "./runs/binding";
import { publishEvent } from "./runs/live";
import { runsStorage } from "./runs/storage";
import { runTurn, TURN_WORKFLOW, type TurnArgs, type TurnDeps } from "./runs/turn";

/**
 * Starts one assistant turn. The API only has a queue client, so it enqueues this job;
 * the worker turns it into the durable turn workflow. At most one per run and turn is
 * queued or running (singleton key), and the workflow id repeats that key, so a second
 * Stream call never starts a second turn.
 */
export const startTurn = defineJob(
  "agentic.turn",
  z.object({
    runId: z.string(),
    turnSeq: z.number().int().positive(),
    projectId: z.string(),
    userMessage: z.string(),
    hostUserMessage: z.string().nullable(),
  }),
  { retryLimit: 3, retryDelaySeconds: 2, expireInSeconds: 60, policy: "singleton" },
);

export const turnWorkflowId = (runId: string, turnSeq: number) =>
  `agentic-turn:${runId}:${turnSeq}`;

export interface AgenticWorkerDeps {
  readonly db: Db;
  readonly logger: Logger;
  readonly models: Models;
  readonly config: Pick<Config, "agentic" | "canvas" | "http">;
  /** Where the turn workflow is enqueued; the worker's own database. */
  readonly databaseUrl?: string;
  readonly agent?: Agent;
  readonly bindData?: (who: Signed, ctx: TurnContext) => AgentData;
  readonly capture?: Capture;
  readonly now?: () => Date;
}

/** Jobs the API enqueues for this namespace. */
export const agenticApiJobs: readonly JobDefinition[] = [startTurn];

/**
 * The worker's registration. The turn workflow is registered before the queue launches;
 * the job handler enqueues it by name on the job's own queue through a DBOS client,
 * because DBOS does not let a step start a workflow. Workflow id plus the executor
 * heartbeat is the turn lease: one executor holds a turn, and a silent one's turns are
 * resumed elsewhere at their first unfinished step.
 */
export function agenticWorker(deps: AgenticWorkerDeps): {
  jobs: readonly JobDefinition[];
  register(queue: Queue): Promise<void>;
} {
  const access = new Access(new DrizzleAccessStore(deps.db));
  const notifier = new Notifier(deps.db, deps.logger);
  const turnDeps: TurnDeps = {
    store: runsStorage(deps.db),
    logger: deps.logger,
    models: deps.models,
    config: deps.config,
    agent: deps.agent ?? createAgent({ logger: deps.logger }),
    bindData:
      deps.bindData ??
      ((who, ctx) =>
        bindAgentData({ db: deps.db, access, enableCanvas: deps.config.canvas.enabled }, who, ctx)),
    capture: deps.capture ?? posthogCapture(deps.config.http.dashboardUrl, deps.logger),
    notify: (e) => notifier.emit(e),
    now: deps.now ?? (() => new Date()),
  };
  let client: Promise<DBOSClient> | null = null;
  const dbos = () => {
    if (!deps.databaseUrl) throw new Error("agentic worker needs databaseUrl to enqueue turns");
    client ??= DBOSClient.create({
      systemDatabaseUrl: deps.databaseUrl,
      systemDatabaseSchemaName: "dbos",
      systemDatabasePoolSize: 2,
      applicationName: "echo",
    });
    return client;
  };
  return {
    jobs: agenticApiJobs,
    async register(queue) {
      workflow(TURN_WORKFLOW, async (args: TurnArgs) => {
        try {
          await runTurn(turnDeps, args, (name, fn) =>
            step(name, fn, { retriesAllowed: true, maxAttempts: 3, intervalSeconds: 2 }),
          );
        } catch (err) {
          deps.logger.error({ err, runId: args.runId }, "turn workflow failed");
          await step("abandon", () => abandonTurn(turnDeps, args));
        }
      });
      await queue.work(
        startTurn,
        { concurrency: deps.config.agentic.turnConcurrency },
        async (p) => {
          const c = await dbos();
          await c.enqueue(
            {
              queueName: startTurn.name,
              workflowName: TURN_WORKFLOW,
              workflowID: turnWorkflowId(p.runId, p.turnSeq),
              appVersion: WORKFLOW_VERSION,
            },
            p,
          );
        },
      );
    },
  };
}

/** A turn whose workflow failed outright ends visibly instead of showing "working" forever. */
async function abandonTurn(d: TurnDeps, a: TurnArgs) {
  const run = await d.store.get(a.runId);
  if (run?.status !== "running") return;
  const ev = await d.store.appendEvent(
    a.runId,
    "run.failed",
    { error_code: "AGENT_UNEXPECTED_ERROR" },
    d.now(),
  );
  await publishEvent(d.store.sql, a.runId, ev, d.logger);
  await d.store.setStatus(a.runId, "failed", d.now(), {
    latestError: "Turn workflow failed",
    latestErrorCode: "AGENT_UNEXPECTED_ERROR",
    ifStatus: ["running"],
  });
}
