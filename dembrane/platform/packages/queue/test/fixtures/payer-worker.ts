// A worker process for the payer recovery test: logs the payer each step runs under, and
// hangs in step two while HANG is set, so a second process resumes the runs.
import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createLogger, initTracing, payer, payerKey } from "@dembrane/observability";
import { Queue, step, workflow } from "../../src";
import { paidWorkflow } from "./payer-jobs";

const url = process.env.QUEUE_URL as string;
const log = (s: string) =>
  appendFileSync(process.env.TRACE_FILE as string, `${process.env.EXECUTOR} ${s}\n`);
const seen = () => {
  const p = payer();
  return p ? payerKey(p) : "none";
};
const logger = createLogger(
  { service: "fixture", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const { tracer } = initTracing({ service: "fixture", release: "r", env: "test", sampleRatio: 0 });

const twoSteps = async (id: string) => {
  await step("first", async () => log(`first ${id} ${seen()}`));
  await step("second", async () => {
    log(`second start ${id} ${seen()}`);
    if (process.env.HANG === "1") await Bun.sleep(600_000);
  });
  log(`finished ${id} ${seen()}`);
};

const standalone = workflow("test.payer-standalone", (id: string) => twoSteps(id), {
  payer: (id) => ({ ref: "agent_run", id }),
});

const queue = new Queue(url, logger, tracer, {
  executorId: process.env.EXECUTOR as string,
  recovery: { beatMs: 200, deadAfterS: 1 },
  pollingIntervalMs: 50,
});
await queue.start([paidWorkflow]);
await queue.workflow(paidWorkflow, { concurrency: 2 }, (p) => twoSteps(p.projectId));
await queue.run();
if (process.env.START === "1") {
  const { DBOS } = await import("@dbos-inc/dbos-sdk");
  await DBOS.startWorkflow(standalone, { workflowID: "run-1", queueName: paidWorkflow.name })(
    "run-1",
  );
}
log("ready");
