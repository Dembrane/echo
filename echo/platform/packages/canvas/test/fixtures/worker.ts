// A worker process for the crash-resume test: runs the canvas tick workflow with a fake
// model and records which phases it entered, then either starts one tick (and hangs in the
// model call) or only serves the queue.
import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createDb } from "@echo/db";
import { FakeCompleter } from "@echo/llm";
import { createLogger, initTracing } from "@echo/observability";
import { Queue } from "@echo/queue";
import { canvasTick, tickDeps, tickWorkflow } from "../../src/jobs";
import { EXTRACTION, GUIDE, ids } from "./seed";

const url = process.env.QUEUE_URL as string;
const log = (s: string) =>
  appendFileSync(process.env.TRACE_FILE as string, `${process.env.EXECUTOR} ${s}\n`);
const logger = createLogger(
  { service: "fixture", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const { tracer } = initTracing({ service: "fixture", release: "r", env: "test", sampleRatio: 0 });
const database = createDb({ url, poolMax: 4 });

const completer = new FakeCompleter()
  .on("You update a dembrane tabbed living canvas", async () => {
    log("extract-start");
    if (process.env.HANG === "1") await Bun.sleep(600_000);
    log("extract-done");
    return EXTRACTION;
  })
  .on("Open questions tab", async () => {
    log("host-guide");
    return GUIDE;
  });

const deps = { db: database.db, logger, completer, canvasEnabled: true };
const queue = new Queue(url, logger, tracer, {
  executorId: process.env.EXECUTOR as string,
  recovery: { beatMs: 500, deadAfterS: 2 },
});
await queue.start([canvasTick]);
await queue.workflow(canvasTick, { concurrency: 2 }, async (p, job) => {
  const base = tickDeps(deps, job.id);
  const outcome = await tickWorkflow(
    {
      ...base,
      // The window claim happens only in the prepare phase, the access read first in gather.
      claimWindow: async (...a) => {
        log("prepare");
        return base.claimWindow(...a);
      },
      accessStore: {
        ...base.accessStore,
        project: async (id: string) => {
          log("gather");
          return base.accessStore.project(id);
        },
        workspace: (id: string) => base.accessStore.workspace(id),
        workspaceMembership: (w: string, a: string, n: Date) =>
          base.accessStore.workspaceMembership(w, a, n),
        orgRole: (o: string, a: string) => base.accessStore.orgRole(o, a),
        hasProjectShare: (p2: string, a: string) => base.accessStore.hasProjectShare(p2, a),
      },
    },
    p.loopId,
    p.tickKind,
  );
  log(`finished ${outcome}`);
});
await queue.run();
if (process.env.START === "1")
  await queue.enqueue(canvasTick, { loopId: ids.loop, tickKind: "scheduled" });
log("ready");
