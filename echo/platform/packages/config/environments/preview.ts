import type { Environment } from "../src";

// The branch deployment on Cloud Run URLs. Hosts move to echo-next's domains at cutover.
export default {
  http: {
    publicUrl: "https://echo-preview-api-218237812097.europe-west4.run.app",
    dashboardUrl: "https://echo-preview-dashboard-218237812097.europe-west4.run.app",
    portalUrl: "https://echo-preview-portal-218237812097.europe-west4.run.app",
  },
  database: { poolMax: 3, queuePoolMax: 2 },
  observability: { gcpProject: "dembrane-web-previews", traceSampleRatio: 0 },
  llm: { vertexProject: "dembrane-web-previews" },
  web: { apiOrigin: "https://echo-preview-api-218237812097.europe-west4.run.app" },
  // Preview has never delivered project webhooks. The default turned on to match prod;
  // turning preview on too is a separate decision about whose endpoints it may reach.
  webhooks: { enabled: false },
} satisfies Environment;
