import { LocalMedia } from "@dembrane/audio";
import { describe, loadSections } from "@dembrane/config";
import { createLogger, initTracing } from "@dembrane/observability";
import { mediaApp } from "./app";

// The media service reads only what it serves with: no database, no bucket, no secrets.
const loaded = loadSections(["app", "observability", "http"]);
const config = loaded.values;
const service = "echo-media";
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

const app = mediaApp(new LocalMedia(), logger);
// Media jobs run for minutes; Cloud Run's request timeout (60 minutes) is the real bound.
const server = Bun.serve({ port: config.http.port, fetch: app.fetch, idleTimeout: 0 });
logger.info({ port: server.port, config: describe(loaded) }, "media started");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "media stopping");
  await server.stop();
  await tracing.shutdown();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
