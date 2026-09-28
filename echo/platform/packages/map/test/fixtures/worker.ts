// A worker for the fact-check crash test: registers the fact-check workflow with a fake
// model that traces its calls and can hang in the search-grounded investigation.
import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { analysisRuntime, clientOf } from "@echo/analysis";
import { createDb } from "@echo/db";
import { FakeCompleter, FakeEmbedder } from "@echo/llm";
import { createLogger, initTracing } from "@echo/observability";
import { Queue } from "@echo/queue";
import { factCheckWorkflow, mapFactCheck } from "../../src/factcheck";
import { MapStore } from "../../src/store";

const url = process.env.QUEUE_URL as string;
const who = process.env.EXECUTOR as string;
const trace = (s: string) => appendFileSync(process.env.TRACE_FILE as string, `${who} ${s}\n`);
const logger = createLogger(
  { service: "fixture", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const { tracer } = initTracing({ service: "fixture", release: "r", env: "test", sampleRatio: 0 });

const completer = new FakeCompleter((g) => `vertex_ai/fake-${g}`).on("CLAIM START", async (r) => {
  trace(r.googleSearch ? "investigate" : "classify");
  if (r.googleSearch && process.env.HANG === "1") await Bun.sleep(600_000);
  return r.googleSearch
    ? { text: "Weeks, not months.", sources: [{ url: "https://example.org/a", title: "A" }] }
    : JSON.stringify({ verdict: "false", justification: "Weeks." });
});

class TracingStore extends MapStore {
  override async getFactCheck(id: string) {
    trace("load");
    return super.getFactCheck(id);
  }
}

const database = createDb({ url, poolMax: 4 });
const queue = new Queue(url, logger, tracer, {
  executorId: who,
  recovery: { beatMs: 500, deadAfterS: 2 },
});
await queue.start([mapFactCheck]);
const rt = analysisRuntime({
  db: database.db,
  logger,
  completer,
  embedder: new FakeEmbedder(8),
  jobs: queue,
  config: { embeddingModel: "text-embedding-004", embeddingLocation: "europe-west4" },
});
const store = new TracingStore(clientOf(database.db));
await queue.workflow(mapFactCheck, { concurrency: 2 }, async (job) => {
  trace(`finished ${await factCheckWorkflow({ store, rt, completer }, job)}`);
});
await queue.run();
trace("ready");
