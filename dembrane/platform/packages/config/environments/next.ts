import type { Environment } from "../src";

export default {
  http: {
    publicUrl: "https://api.staging.dembrane.com",
    dashboardUrl: "https://dashboard.staging.dembrane.com",
    portalUrl: "https://portal.staging.dembrane.com",
  },
  database: { poolMax: 5, queuePoolMax: 3 },
  observability: { gcpProject: "dembrane-web-next", traceSampleRatio: 0 },
  llm: { vertexProject: "dembrane-web-next" },
  auth: { cookieDomain: "staging.dembrane.com" },
  // echo-next serves the popcorn flow page today (the Python stack gates it on
  // SERVE_API_DOCS=1 there, 0 on prod); keeping it on keeps that page for the team.
  popcorn: { showFlow: true },
} satisfies Environment;
