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
  // echo-next serves the popcorn flow page today (the Python stack gates it on
  // SERVE_API_DOCS=1 there, 0 on prod); keeping it on keeps that page for the team.
  popcorn: { showFlow: true },
} satisfies Environment;
