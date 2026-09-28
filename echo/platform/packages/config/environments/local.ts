import type { Environment } from "../src";

// Matches compose.yml. Secrets come from .env.local, never from here.
export default {
  http: {
    publicUrl: "http://localhost:8080",
    dashboardUrl: "http://localhost:5173",
    portalUrl: "http://localhost:5174",
  },
  observability: { logLevel: "debug", traceSampleRatio: 1 },
  web: { apiOrigin: "http://localhost:8080", distDir: "../frontend/dist" },
  webhooks: { allowPrivateTargets: true },
  popcorn: { showFlow: true },
} satisfies Environment;
