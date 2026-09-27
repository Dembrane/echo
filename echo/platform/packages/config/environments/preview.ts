import type { Environment } from "../src";

// The branch deployment on Cloud Run URLs. Hosts move to echo-next's domains at cutover.
export default {
  http: {
    publicUrl: "https://echo-preview-api-86405194907.europe-west4.run.app",
    dashboardUrl: "https://echo-preview-dashboard-86405194907.europe-west4.run.app",
    portalUrl: "https://echo-preview-portal-86405194907.europe-west4.run.app",
  },
  database: { poolMax: 5 },
  observability: { gcpProject: "dembrane-echo", traceSampleRatio: 1 },
  web: { apiOrigin: "https://echo-preview-api-86405194907.europe-west4.run.app" },
} satisfies Environment;
