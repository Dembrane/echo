import type { Environment } from "../src";

// The branch deployment on Cloud Run URLs. Hosts move to echo-next's domains at cutover.
export default {
  http: {
    publicUrl: "https://echo-preview-api-86405194907.europe-west4.run.app",
    dashboardUrl: "http://localhost:5173",
    portalUrl: "http://localhost:5174",
  },
  database: { poolMax: 5 },
  observability: { gcpProject: "dembrane-echo", traceSampleRatio: 1 },
} satisfies Environment;
