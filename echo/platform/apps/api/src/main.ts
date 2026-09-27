import { describe, loadConfig, publicValues } from "@echo/config";
import { createDb } from "@echo/db";
import { createLogger, initTracing } from "@echo/observability";
import { buildApp } from "./app";

const loaded = loadConfig();
const config = loaded.values;
const service = "echo-api";
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
const database = createDb({ url: config.database.url, poolMax: config.database.poolMax });

const app = buildApp({
  config,
  publicConfig: publicValues(loaded),
  logger,
  tracer: tracing.tracer,
  pingDb: database.ping,
});

const server = Bun.serve({ port: config.http.port, fetch: app.fetch, idleTimeout: 255 });
logger.info({ port: server.port, config: describe(loaded) }, "api started");

// Cloud Run sends SIGTERM and allows 10s: stop taking requests, finish in-flight ones, flush.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  await server.stop();
  await Promise.allSettled([database.close(), tracing.shutdown()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
