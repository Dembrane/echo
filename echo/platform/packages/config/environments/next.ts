import type { Environment } from "../src";

export default {
  http: {
    publicUrl: "https://api.echo-next.dembrane.com",
    dashboardUrl: "https://dashboard.echo-next.dembrane.com",
    portalUrl: "https://portal.echo-next.dembrane.com",
  },
  database: { poolMax: 5 },
  observability: { gcpProject: "dembrane-echo", traceSampleRatio: 1 },
  auth: { cookieDomain: "echo-next.dembrane.com" },
} satisfies Environment;
