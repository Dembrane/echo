import type { Environment } from "../src";

// PR previews. Each deploy sets its own hosts (.github/scripts/deploy-env.sh); these are the defaults
// a process without them falls back to.
export default {
  http: {
    // The preview load balancer's address (dembrane/infra/preview/lb.tf).
    trustedProxies: ["136.82.82.95"],
    publicUrl: "https://echo-preview-api-218237812097.europe-west4.run.app",
    dashboardUrl: "https://echo-preview-dashboard-218237812097.europe-west4.run.app",
    portalUrl: "https://echo-preview-portal-218237812097.europe-west4.run.app",
  },
  database: { poolMax: 3, queuePoolMax: 2 },
  observability: { gcpProject: "dembrane-web-previews", traceSampleRatio: 0 },
  llm: { vertexProject: "dembrane-web-previews" },
  auth: { cookiePrefix: "dembrane-preview" },
  web: { apiOrigin: "https://echo-preview-api-218237812097.europe-west4.run.app" },
  // Preview has never delivered project webhooks. The default turned on to match prod;
  // turning preview on too is a separate decision about whose endpoints it may reach.
  webhooks: { enabled: false },
  // A preview has no sam inbox, so nothing is sent; on, the timeline records the invoice
  // request and the offer flow can be walked end to end.
  accounts: { offerMessages: true },
  // A preview seeds the sample project, so a pull request that touches it can be walked.
  samples: { enabled: true },
} satisfies Environment;
