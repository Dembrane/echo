// A worker process for the dead-worker tests: registers a two-step workflow and either
// starts one run (and hangs in step two) or just serves the queue. It also works the jobs
// in jobs.ts as the same two steps, hanging in step two for the run ids in HANG_JOBS.
import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createLogger, initTracing } from "@dembrane/observability";
import { z } from "zod";
import { defineJob, Queue, step, workflow } from "../../src";
import { impatient, ordinary } from "./jobs";

const url = process.env.QUEUE_URL as string;
const log = (s: string) =>
  appendFileSync(process.env.TRACE_FILE as string, `${process.env.EXECUTOR} ${s}\n`);
const logger = createLogger(
  { service: "fixture", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const { tracer } = initTracing({ service: "fixture", release: "r", env: "test", sampleRatio: 0 });

const pipeline = workflow("test.pipeline", async (id: string) => {
  await step("first", async () => log(`first ${id}`));
  await step("second", async () => {
    log(`second start ${id}`);
    if (process.env.HANG === "1") await Bun.sleep(600_000);
    log(`second done ${id}`);
  });
  log(`finished ${id}`);
});

const queue = new Queue(url, logger, tracer, {
  executorId: process.env.EXECUTOR as string,
  recovery: { beatMs: 200, deadAfterS: Number(process.env.DEAD_AFTER_S ?? 1) },
  pollingIntervalMs: 50,
});
await queue.start([defineJob("test.pipeline", z.any())]);
await queue.work(defineJob("test.noop", z.object({})), { concurrency: 1 }, async () => {});
const hanging = (process.env.HANG_JOBS ?? "").split(",");
for (const def of [impatient, ordinary]) {
  await queue.workflow(def, { concurrency: 2 }, async ({ id }) => {
    await step("first", async () => log(`first ${id}`));
    await step("second", async () => {
      log(`second start ${id}`);
      if (hanging.includes(id)) await Bun.sleep(600_000);
      log(`second done ${id}`);
    });
    log(`finished ${id}`);
  });
}
await queue.run();
const { DBOS } = await import("@dbos-inc/dbos-sdk");
await DBOS.registerQueue("pipelines", { workerConcurrency: 2 });
if (process.env.START === "1") {
  await DBOS.startWorkflow(pipeline, { workflowID: "pipe-1", queueName: "pipelines" })("pipe-1");
}
// Stops the way the worker app does when a rollout ends it.
process.on("SIGTERM", async () => {
  await queue.stop();
  process.exit(0);
});
log("ready");
