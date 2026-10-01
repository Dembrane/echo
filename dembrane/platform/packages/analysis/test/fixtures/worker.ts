// A worker process for the crash-resume test: registers the analysis workflows with a
// fake model that traces each call, and can hang inside one conversation's extraction.
import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createDb } from "@dembrane/db";
import { FakeCompleter, FakeEmbedder } from "@dembrane/llm";
import { createLogger, initTracing } from "@dembrane/observability";
import { Queue } from "@dembrane/queue";
import { analysisWorker } from "../../src/jobs";
import { P1_ANSWERS } from "../harness";

const url = process.env.QUEUE_URL as string;
const who = process.env.EXECUTOR as string;
const trace = (s: string) => appendFileSync(process.env.TRACE_FILE as string, `${who} ${s}\n`);
const logger = createLogger(
  { service: "fixture", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const { tracer } = initTracing({ service: "fixture", release: "r", env: "test", sampleRatio: 0 });

const completer = new FakeCompleter((g) => `vertex_ai/fake-${g}`);
for (const [needle, answer] of Object.entries(P1_ANSWERS))
  completer.on(needle, async () => {
    trace(`model ${needle}`);
    if (process.env.HANG === needle) await Bun.sleep(600_000);
    return JSON.stringify(answer);
  });

const database = createDb({ url, poolMax: 4 });
const queue = new Queue(url, logger, tracer, {
  executorId: who,
  recovery: { beatMs: 500, deadAfterS: 2 },
});
const worker = analysisWorker({
  db: database.db,
  logger,
  completer,
  embedder: new FakeEmbedder(8),
  config: { embeddingModel: "text-embedding-004", embeddingLocation: "europe-west4" },
});
await queue.start(worker.jobs);
await worker.register(queue);
await queue.run();
trace("ready");
