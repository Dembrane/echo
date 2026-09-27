// A worker process for the report crash test: runs the generation workflow with a fake
// model, and with HANG=1 stops inside the generate step so the test can kill it there.
import { appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createDb } from "@echo/db";
import { FakeCompleter } from "@echo/llm";
import { createLogger, initTracing } from "@echo/observability";
import { generateReport } from "@echo/projects";
import { Queue } from "@echo/queue";
import { generateReportWorkflow } from "../../src/jobs";
import { reportsStorage } from "../../src/storage";
import { summarizeConversation } from "../../src/summarize";

const url = process.env.QUEUE_URL as string;
const who = process.env.EXECUTOR as string;
const log = (s: string) => appendFileSync(process.env.TRACE_FILE as string, `${who} ${s}\n`);
const logger = createLogger(
  { service: "fixture", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);
const { tracer } = initTracing({ service: "fixture", release: "r", env: "test", sampleRatio: 0 });
const database = createDb({ url, poolMax: 4 });
const completer = new FakeCompleter()
  .on("<transcripts>", () => {
    log("model report");
    return "Here it is.\n<article>\n# Crash-safe report\n\nResidents want buses.\n</article>";
  })
  .on(
    () => true,
    () => {
      log("model summary");
      return "Residents want later buses.";
    },
  );

const queue = new Queue(url, logger, tracer, {
  executorId: who,
  recovery: { beatMs: 500, deadAfterS: 2 },
});
await queue.start([generateReport]);
await queue.workflow(
  generateReport,
  { concurrency: 1 },
  generateReportWorkflow({
    store: reportsStorage(database.db),
    completer,
    summarizer: summarizeConversation({
      sql: (database.db as unknown as { $client: import("postgres").Sql }).$client,
      completer,
      logger,
      now: () => new Date(),
    }),
    logger,
    now: () => new Date(),
    maxContextTokens: 100_000,
    notifier: { emit: async (e) => log(`notify ${e.eventCode}`) },
    reportGenerated: async () => log("webhook"),
    pause: async (name) => {
      log(`step ${name}`);
      if (name === "generate" && process.env.HANG === "1") await Bun.sleep(600_000);
    },
  }),
);
await queue.run();
if (process.env.START === "1") {
  await queue.enqueue(generateReport, {
    projectId: process.env.PROJECT_ID as string,
    reportId: Number(process.env.REPORT_ID),
    language: "en",
    userInstructions: "",
  });
}
log("ready");
