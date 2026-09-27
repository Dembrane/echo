import { z } from "zod";
import { defineSchema, key } from "./define";

const bool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");
const int = z.coerce.number().int();

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
    traceSampleRatio: key("TRACE_SAMPLE_RATIO", z.coerce.number().min(0).max(1).default(0.1), {
      description: "Share of requests traced end to end.",
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
        "SendGrid key for transactional email. Unset logs sends instead of delivering them.",
      secret: true,
    }),
    sendgridRegion: key("SENDGRID_REGION", z.enum(["eu", "global"]).default("eu"), {
      description: "SendGrid data residency. eu keeps recipient data in EU data centres.",
    }),
    fromEmail: key("EMAIL_FROM", z.string().default("do-not-reply@dembrane.com"), {
      description: "Sender address of transactional email.",
    }),
    fromName: key("EMAIL_FROM_NAME", z.string().default("dembrane"), {
      description: "Sender name of transactional email.",
    }),
  },
  billing: {
    mollieApiKey: key("MOLLIE_API_KEY", z.string().optional(), {
      description: "Mollie key. test_ keys use Mollie test mode; unset turns paid checkout off.",
      secret: true,
    }),
    mollieWebhookUrl: key("MOLLIE_WEBHOOK_URL", z.url().optional(), {
      description:
        "Public URL Mollie posts payment updates to. Unset relies on the return sync and the reconcile schedule.",
    }),
    forceReconcileFailure: key("MOLLIE_FORCE_RECONCILE_FAILURE", bool.default(false), {
      description:
        "Test mode only: makes every seat reconcile fail so the fix-your-payment path can be exercised.",
    }),
    customerJobs: key("BILLING_CUSTOMER_JOBS", z.enum(["on", "off"]).default("off"), {
      description:
        "Whether scheduled billing jobs may email customers or change their tier. Off outside prod, so a copy of prod data never mails real customers.",
    }),
  },
});

export type Schema = typeof schema;
