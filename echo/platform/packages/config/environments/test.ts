import type { Environment } from "../src";

export default {
  http: {
    publicUrl: "http://api.test",
    dashboardUrl: "http://dashboard.test",
    portalUrl: "http://portal.test",
  },
  observability: { logLevel: "warn", traceSampleRatio: 0 },
} satisfies Environment;
