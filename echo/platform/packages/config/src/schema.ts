import { z } from "zod";
import { defineSchema, key } from "./define";

const int = z.coerce.number().int();
const bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");
/** A list from an environment file, or comma-separated from an environment variable. */
const list = z.union([
  z.array(z.string()).min(1),
  z.string().transform((v) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  ),
]);

/**
 * Every setting echo reads, declared once. A namespace adds its section here when it
 * moves over; code reads `config.<section>.<key>`, so an undeclared key is a type error.
 */
export const schema = defineSchema({
  app: {
    env: key("APP_ENV", z.enum(["local", "test", "preview", "next", "prod"]), {
      description: "Which environment file applies. Set by the deployment, never by hand in code.",
      public: true,
    }),
    release: key("APP_RELEASE", z.string().default("dev"), {
      description: "Git sha of the running build, stamped into logs, traces and errors.",
      public: true,
    }),
  },
  http: {
    port: key("PORT", int.min(1).max(65535).default(8080), {
      description: "Port the API listens on. Cloud Run sets it.",
    }),
    publicUrl: key("API_PUBLIC_URL", z.url(), {
      description: "Base URL browsers and the iOS app use to reach the API.",
      public: true,
    }),
    dashboardUrl: key("DASHBOARD_URL", z.url(), { description: "Dashboard origin.", public: true }),
    portalUrl: key("PORTAL_URL", z.url(), {
      description: "Participant portal origin.",
      public: true,
    }),
  },
  database: {
    url: key("DATABASE_URL", z.url(), {
      description: "Runtime Postgres login. Least privilege: no DDL.",
      secret: true,
    }),
    poolMax: key("DATABASE_POOL_MAX", int.min(1).default(10), {
      description:
        "Connections per instance. Times max instances must stay under the server limit.",
    }),
  },
  observability: {
    logLevel: key(
      "LOG_LEVEL",
      z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
      {
        description: "Minimum level written to stdout as JSON.",
      },
    ),
    otlpEndpoint: key("OTEL_EXPORTER_OTLP_ENDPOINT", z.url().optional(), {
      description: "Where traces and metrics go. Unset disables export; logs still go to stdout.",
    }),
    gcpProject: key("GCP_PROJECT", z.string().optional(), {
      description:
        "Project that owns traces; set in GCP so each log line links to its trace in Cloud Trace.",
    }),
    traceSampleRatio: key("TRACE_SAMPLE_RATIO", z.coerce.number().min(0).max(1).default(0.1), {
      description: "Share of requests traced end to end.",
    }),
  },
  web: {
    role: key("WEB_ROLE", z.enum(["dashboard", "portal"]).default("dashboard"), {
      description:
        "Which app a web server instance serves: the dashboard for hosts, or the portal for participants.",
      public: true,
    }),
    apiOrigin: key("WEB_API_ORIGIN", z.url().optional(), {
      description:
        "Where the web server forwards /api. Same-origin keeps sign-in cookies first-party on any host.",
    }),
    distDir: key("WEB_DIST_DIR", z.string().default("/app/dist"), {
      description: "The built frontend the web server serves.",
    }),
  },
  llm: {
    vertexProject: key("LLM_VERTEX_PROJECT", z.string().default("dembrane-echo"), {
      description: "GCP project billed for language model calls.",
    }),
    vertexLocation: key("LLM_VERTEX_LOCATION", z.string().default("eu"), {
      description: "Vertex location. eu uses the EU data residency endpoint.",
    }),
    textFast: key(
      "LLM_TEXT_FAST",
      list.default(["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash"]),
      {
        description:
          "text_fast group, in fallback order. Falls back to multi_modal_pro after these.",
      },
    ),
    multiModalFast: key(
      "LLM_MULTI_MODAL_FAST",
      list.default(["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash"]),
      {
        description: "multi_modal_fast group (audio and images), in fallback order.",
      },
    ),
    multiModalPro: key(
      "LLM_MULTI_MODAL_PRO",
      list.default(["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash"]),
      {
        description: "multi_modal_pro group, in fallback order.",
      },
    ),
    embeddingModel: key("EMBEDDING_MODEL", z.string().default("text-embedding-004"), {
      description: "Vertex embedding model.",
    }),
    embeddingLocation: key("EMBEDDING_LOCATION", z.string().default("europe-west4"), {
      description: "Embeddings are regional on Vertex; the eu multi-region does not serve them.",
    }),
    embeddingDimensions: key("EMBEDDING_DIMENSIONS", int.min(1).default(768), {
      description: "Vector size the embedding model returns and map_embedding.dims records.",
    }),
  },
  webhooks: {
    allowPrivateTargets: key("WEBHOOKS_ALLOW_PRIVATE_TARGETS", bool.default(false), {
      description:
        "Lets webhook URLs resolve to loopback and private addresses. Local development only.",
    }),
  },
  auth: {
    secret: key("AUTH_SECRET", z.string().min(32), {
      description: "Signs sessions and tokens. Rotating it signs everyone out.",
      secret: true,
    }),
    cookieDomain: key("AUTH_COOKIE_DOMAIN", z.string().optional(), {
      description:
        "Parent domain shared by dashboard, portal and API, so one sign-in covers all three.",
    }),
    googleClientId: key("AUTH_GOOGLE_CLIENT_ID", z.string().optional(), {
      description: "Google sign-in. Unset hides the option.",
    }),
    googleClientSecret: key("AUTH_GOOGLE_CLIENT_SECRET", z.string().optional(), {
      description: "Google sign-in secret.",
      secret: true,
    }),
  },
  mail: {
    sendgridApiKey: key("SENDGRID_API_KEY", z.string().optional(), {
      description:
        "SendGrid key for transactional email. Unset records mail in the log instead of sending it.",
      secret: true,
    }),
    sendgridRegion: key("SENDGRID_REGION", z.enum(["eu", "global"]).default("eu"), {
      description:
        "eu keeps recipient data in EU data centres; the key must belong to that region.",
    }),
    fromEmail: key("EMAIL_FROM", z.string().default("do-not-reply@dembrane.com"), {
      description: "Sender address of every transactional email.",
    }),
    fromName: key("EMAIL_FROM_NAME", z.string().default("dembrane"), {
      description: "Sender name of every transactional email.",
    }),
  },
  tenancy: {
    inviteLinkSecret: key("INVITE_LINK_SECRET", z.string().min(16), {
      description:
        "Signs the hash in invite links. Must equal the old API's DIRECTUS_SECRET until links sent before cutover expire.",
      secret: true,
    }),
  },
});

export type Schema = typeof schema;
