import { describe, loadConfig } from "@echo/config";
import { createDb } from "@echo/db";
import { createLogger, initTracing } from "@echo/observability";
import { Queue } from "@echo/queue";
import { registrations } from "./jobs";

const loaded = loadConfig();
const config = loaded.values;
const service = "echo-worker";
const logger = createLogger({
  service,
  release: config.app.release,
  env: config.app.env,
  level: config.observability.logLevel,
});
const tracing = initTracing({
  service,
  release: config.app.release,
  env: config.app.env,
  otlpEndpoint: config.observability.otlpEndpoint,
  sampleRatio: config.observability.traceSampleRatio,
});

const queue = new Queue(config.database.url, logger, tracing.tracer, {
  maxConnections: config.database.poolMax,
});
const database = createDb({ url: config.database.url, poolMax: config.database.poolMax });
const regs = registrations({ logger, db: database.db, config });
await queue.start(regs.flatMap((r) => r.jobs));
for (const r of regs) await r.register(queue);
logger.info(
  { jobs: regs.flatMap((r) => r.jobs.map((j) => j.name)), config: describe(loaded) },
  "worker started",
);

// Queue depth is a health signal: logged each minute so a log-based metric can alert on it.
const signals = setInterval(async () => {
  try {
    for (const q of await queue.health())
      logger.info({ signal: "queue.depth", ...q }, "queue health");
  } catch (err) {
    logger.warn({ err }, "queue health unavailable");
  }
}, 60_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "worker stopping");
  clearInterval(signals);
  await queue.stop();
  await database.close();
  await tracing.shutdown();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
