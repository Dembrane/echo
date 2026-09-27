import { describe, loadSections } from "@echo/config";
import { createLogger, initTracing } from "@echo/observability";
import { Queue } from "@echo/queue";
import { registrations } from "./jobs";

// Only what the worker reads: it never serves sign-in, so it is not given the auth secret.
const loaded = loadSections(["app", "database", "observability", "llm"]);
const config = loaded.values;
const service = "echo-worker";
const logger = createLogger({
  service,
  release: config.app.release,
  env: config.app.env,
  level: config.observability.logLevel,
  ...(config.observability.gcpProject && { gcpProject: config.observability.gcpProject }),
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
const regs = registrations(logger);
await queue.start(regs.flatMap((r) => r.jobs));
for (const r of regs) await r.register(queue);
await queue.run();
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
  await tracing.shutdown();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
