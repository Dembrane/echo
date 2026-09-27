import type { Environment } from "../src";

export default {
  http: {
    publicUrl: "https://api.dembrane.com",
    dashboardUrl: "https://dashboard.dembrane.com",
    portalUrl: "https://portal.dembrane.com",
  },
  database: { poolMax: 10 },
  observability: { traceSampleRatio: 0.1 },
  auth: { cookieDomain: "dembrane.com" },
  billing: { customerJobs: "on" },
} satisfies Environment;
