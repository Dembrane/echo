import { loadSections } from "@dembrane/config";
import { createLogger } from "@dembrane/observability";
import { securityHeaders } from "./headers";
import { createHandler, previewRuntime } from "./server";

const { values: config } = loadSections(["app", "http", "web", "observability"]);
const logger = createLogger({
  service: `echo-${config.web.role}`,
  release: config.app.release,
  env: config.app.env,
  level: config.observability.logLevel,
  ...(config.observability.gcpProject && { gcpProject: config.observability.gcpProject }),
});

// The frontend names environments production/staging/testing/local; preview reads as
// testing so it never reports into another environment's analytics.
const FRONTEND_ENV = {
  prod: "production",
  staging: "staging",
  preview: "testing",
  test: "testing",
  local: "local",
} as const;

const handle = createHandler({
  distDir: config.web.distDir,
  release: config.app.release,
  apiOrigin: config.web.apiOrigin,
  trustedProxies: config.http.trustedProxies,
  proxySecret: config.http.proxySecret,
  runtime: {
    env: FRONTEND_ENV[config.app.env],
    role: config.web.role,
    // Same origin: the web server forwards /api, so the browser needs no API host.
    apiBase: config.web.apiOrigin ? "/api" : `${config.http.publicUrl}/api`,
    dashboardUrl: config.http.dashboardUrl,
    portalUrl: config.http.portalUrl,
    release: config.app.release,
    ...previewRuntime(config.app.env, config.web),
  },
  headers: securityHeaders({
    own: [
      config.http.dashboardUrl,
      config.http.portalUrl,
      config.http.publicUrl,
      "https://*.dembrane.com",
    ],
    storage: ["https://storage.googleapis.com", "https://ams3.digitaloceanspaces.com"],
  }),
});

const server = Bun.serve({
  port: config.http.port,
  fetch: (req, srv) => handle(req, srv.requestIP(req)?.address),
  idleTimeout: 255,
});
logger.info({ port: server.port, role: config.web.role }, "web started");
process.on("SIGTERM", async () => {
  await server.stop();
  process.exit(0);
});
