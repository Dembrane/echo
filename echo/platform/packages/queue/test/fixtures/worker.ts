// A worker process for the dead-worker test: registers a two-step workflow and either
// starts one run (and hangs in step two) or just serves the queue.
import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createLogger, initTracing } from "@dembrane/observability";
import { z } from "zod";
import { defineJob, Queue, step, workflow } from "../../src";

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
  recovery: { beatMs: 200, deadAfterS: 1 },
  pollingIntervalMs: 50,
});
await queue.start([defineJob("test.pipeline", z.any())]);
await queue.work(defineJob("test.noop", z.object({})), { concurrency: 1 }, async () => {});
await queue.run();
const { DBOS } = await import("@dbos-inc/dbos-sdk");
await DBOS.registerQueue("pipelines", { workerConcurrency: 2 });
if (process.env.START === "1") {
  await DBOS.startWorkflow(pipeline, { workflowID: "pipe-1", queueName: "pipelines" })("pipe-1");
}
log("ready");
