// A worker process for the durability test: the real turn workflow and job on DBOS with
// the scripted agent. With HANG=1 it stalls inside the lookup of step 2 until killed.
import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createDb } from "@dembrane/db";
import { fakeModels } from "@dembrane/llm";
import { createLogger, initTracing, payer, payerKey } from "@dembrane/observability";
import { Queue } from "@dembrane/queue";
import { agenticWorker } from "../../src/jobs";
import { fakeAgent } from "./fake-agent";

const url = process.env.QUEUE_URL as string;
const me = process.env.EXECUTOR as string;
const log = (s: string) => appendFileSync(process.env.TRACE_FILE as string, `${me} ${s}\n`);
const logger = createLogger(
  { service: "fixture", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const { tracer } = initTracing({ service: "fixture", release: "r", env: "test", sampleRatio: 0 });
const database = createDb({ url, poolMax: 4 });

const reg = agenticWorker({
  db: database.db,
  logger,
  models: fakeModels(),
  config: {
    canvas: { enabled: false },
    agentic: {
      modelGroup: "multi_modal_pro",
      runTimeoutSeconds: 600,
      sseHeartbeatSeconds: 10,
      turnConcurrency: 2,
    },
    http: {
      port: 8080,
      publicUrl: "http://localhost:8080",
      dashboardUrl: "http://localhost:5173",
      portalUrl: "http://localhost:5174",
      docsUrl: undefined,
      trustedProxies: [],
      proxySecret: undefined,
    },
  },
  databaseUrl: url,
  agent: fakeAgent({
    inLookup: async () => {
      const p = payer();
      log(`lookup ${p ? payerKey(p) : "none"}`);
      if (process.env.HANG === "1") await Bun.sleep(600_000);
    },
  }),
  capture: async (_id, event) => log(`capture ${event}`),
});

const queue = new Queue(url, logger, tracer, {
  executorId: me,
  recovery: { beatMs: 500, deadAfterS: 2 },
});
await queue.start(reg.jobs);
await reg.register(queue);
await queue.run();
log("ready");
