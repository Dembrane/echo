import type { Environment } from "../src";

export default {
  http: {
    // The staging load balancer's address (dembrane/infra/staging, output lb_ip).
    trustedProxies: ["136.81.232.104"],
    publicUrl: "https://api.staging.dembrane.com",
    dashboardUrl: "https://dashboard.staging.dembrane.com",
    portalUrl: "https://portal.staging.dembrane.com",
  },
  database: { poolMax: 5, queuePoolMax: 3 },
  observability: { gcpProject: "dembrane-web-staging", traceSampleRatio: 0 },
  llm: { vertexProject: "dembrane-web-staging" },
  auth: { cookieDomain: "staging.dembrane.com" },
  // The dashboard and portal forward /api here, server to server, so the browser stays on
  // one origin and the deploy's check works before the certificate is active.
  web: { apiOrigin: "https://echo-staging-api-1089877593337.europe-west4.run.app" },
  // echo-next serves the popcorn flow page today (the Python stack gates it on
  // SERVE_API_DOCS=1 there, 0 on prod); keeping it on keeps that page for the team.
  popcorn: { showFlow: true },
} satisfies Environment;
