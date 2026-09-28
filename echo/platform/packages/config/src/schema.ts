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
  assets: {
    root: key("ASSETS_ROOT", z.string().min(1).default("/app/assets"), {
      description:
        "Where a compiled binary finds the files packages read at run time (<package>/... and docs/). Run from source, each package reads its own folder and this is ignored.",
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
    // On by default because prod and echo-next deliver webhooks today (the Python stack
    // reads FEATURE_FLAGS__ENABLE_WEBHOOKS=1, a name this stack does not read). Off by
    // default would silently stop every customer's webhooks at cutover.
    enabled: key("ENABLE_WEBHOOKS", bool.default(true), {
      description:
        "Global switch for outbound project webhooks. Off means conversation and report events enqueue nothing.",
    }),
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
      description: "SendGrid key. Unset logs each email instead of sending it (local, test).",
      secret: true,
    }),
    sendgridRegion: key("SENDGRID_REGION", z.enum(["global", "eu"]).default("eu"), {
      description: "SendGrid data residency. eu keeps recipient data in the EU; needs an EU key.",
    }),
    fromEmail: key("EMAIL_FROM", z.email().default("do-not-reply@dembrane.com"), {
      description: "Sender address of every transactional email.",
    }),
    fromName: key("EMAIL_FROM_NAME", z.string().default("dembrane"), {
      description: "Sender name of every transactional email.",
    }),
  },
  files: {
    directusLocation: key("FILES_DIRECTUS_LOCATION", z.string().default("s3"), {
      description:
        "Directus storage location name written on uploaded avatars and logos, so Directus keeps serving them until cutover.",
    }),
    localRoot: key("FILES_LOCAL_ROOT", z.string().default(".data/files"), {
      description: "Where uploads land when no bucket is configured (local, test).",
    }),
    s3Endpoint: key("FILES_S3_ENDPOINT", z.url().optional(), {
      description: "S3 endpoint of the bucket Directus stores files in. Unset uses localRoot.",
    }),
    s3Bucket: key("FILES_S3_BUCKET", z.string().optional(), {
      description: "Bucket Directus stores files in (its storage root).",
    }),
    s3Region: key("FILES_S3_REGION", z.string().default("auto"), {
      description: "Region of that bucket.",
    }),
    s3AccessKeyId: key("FILES_S3_ACCESS_KEY_ID", z.string().optional(), {
      description: "Access key for that bucket.",
      secret: true,
    }),
    s3SecretAccessKey: key("FILES_S3_SECRET_ACCESS_KEY", z.string().optional(), {
      description: "Secret key for that bucket.",
      secret: true,
    }),
  },
  audio: {
    s3Endpoint: key("STORAGE_S3_ENDPOINT", z.url().optional(), {
      description:
        "S3 endpoint of the audio bucket. Stored chunk paths are <endpoint>/<bucket>/<key>, as the Python API wrote them. Unset stores audio on the local disk.",
    }),
    s3Bucket: key("STORAGE_S3_BUCKET", z.string().optional(), {
      description: "Bucket that holds participant audio, merged audio and split chunks.",
    }),
    s3Region: key("STORAGE_S3_REGION", z.string().default("auto"), {
      description: "Region of the audio bucket, used in request signatures.",
    }),
    s3AccessKeyId: key("STORAGE_S3_KEY", z.string().optional(), {
      description: "Access key for the audio bucket (a GCS HMAC key in Cloud Run).",
      secret: true,
    }),
    s3SecretAccessKey: key("STORAGE_S3_SECRET", z.string().optional(), {
      description: "Secret for the audio bucket key.",
      secret: true,
    }),
    localRoot: key("AUDIO_LOCAL_ROOT", z.string().default(".data/audio"), {
      description: "Where audio lands when no bucket is configured (local, test).",
    }),
  },
  media: {
    url: key("MEDIA_URL", z.url().optional(), {
      description:
        "URL of the media service that runs ffmpeg; callers present a Google ID token for it. Unset runs ffmpeg in-process (local development).",
    }),
    timeoutSeconds: key("MEDIA_TIMEOUT_SECONDS", int.min(10).default(3600), {
      description: "How long one media request may take before the step fails and is retried.",
    }),
  },
  conversations: {
    participantTokenRequired: key("PARTICIPANT_TOKEN_REQUIRED", bool.default(false), {
      description:
        "Portal calls must carry the participant token issued at initiate. Off keeps the conversation id working as the capability while the portal and iOS app move over.",
    }),
    monitorEnabled: key("ENABLE_MONITOR", bool.default(true), {
      description: "Live participant monitor: pings are stored and host streams are fed.",
    }),
  },
  analysis: {
    enablePresent: key("ENABLE_PRESENT", bool.default(true), {
      description:
        "Present rollout switch. Off hides host edits of analysis results (reword, roll back, withdraw) with a 404.",
    }),
    nodeLimitCeiling: key("ANALYSIS_NODE_LIMIT_CEILING", int.min(1).optional(), {
      description:
        "Most nodes a map view may draw. A host budget above it is refused, never clamped. Unset: no ceiling.",
    }),
    edgeLimitCeiling: key("ANALYSIS_EDGE_LIMIT_CEILING", int.min(1).optional(), {
      description:
        "Most edges a map view may draw. A host budget above it is refused, never clamped. Unset: no ceiling.",
    }),
  },
  canvas: {
    enabled: key("ENABLE_CANVAS", bool.default(true), {
      description:
        "Global canvas switch. Even on, a project opts in with its experimental toggle; off answers every canvas route with 404.",
    }),
  },
  reports: {
    maxContextTokens: key("REPORT_MAX_CONTEXT_TOKENS", int.min(1000).default(102_400), {
      description:
        "Token budget of a report prompt: 80% of the smallest multi_modal_pro context, as the Python router computed it when the model was unknown to it.",
    }),
  },
  agentic: {
    modelGroup: key(
      "AGENTIC_MODEL_GROUP",
      z.enum(["text_fast", "multi_modal_fast", "multi_modal_pro"]).default("multi_modal_pro"),
      { description: "Model group the chat assistant and chat replies run on." },
    ),
    runTimeoutSeconds: key("AGENTIC_RUN_TIMEOUT_SECONDS", int.min(30).default(600), {
      description: "Longest one assistant turn may run before it ends as timed out.",
    }),
    sseHeartbeatSeconds: key("AGENTIC_SSE_HEARTBEAT_SECONDS", int.min(1).default(10), {
      description: "Heartbeat interval of run event streams, so proxies keep them open.",
    }),
    turnConcurrency: key("AGENTIC_TURN_CONCURRENCY", int.min(1).default(8), {
      description: "Assistant turns one worker instance runs at once.",
    }),
  },
  account: {
    inviteHashSecret: key("INVITE_HASH_SECRET", z.string().min(16), {
      description:
        "Signs invite links. Must equal Directus's SECRET until cutover, or every link already sent stops working.",
      secret: true,
    }),
    onboardingFollowupInbox: key(
      "ONBOARDING_FOLLOWUP_INBOX",
      z.email().default("training@dembrane.com"),
      {
        description:
          "Who hears about onboarding answers that need a partner or training follow-up.",
      },
    ),
  },
  agentAccess: {
    clientSecretKey: key("AGENT_CLIENT_SECRET_KEY", z.string().min(16).optional(), {
      description:
        "Key the stored secrets of registered MCP clients are encrypted under. Must equal Directus's SECRET until every client registered before cutover has re-registered; unset uses INVITE_HASH_SECRET, which holds the same value.",
      secret: true,
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
  support: {
    forwardWebhookUrl: key("SUPPORT_WEBHOOK_URL", z.url().optional(), {
      description:
        "Where support requests and pricing bookings are forwarded to reach the team. Unset turns forwarding off.",
    }),
    forwardWebhookToken: key("ECHO_SUPPORT_WEBHOOK_TOKEN", z.string().optional(), {
      description: "Shared token sent as X-Echo-Support-Token with every forward.",
      secret: true,
    }),
  },
  site: {
    apiToken: key("SITE_API_TOKEN", z.string().optional(), {
      description:
        "Token the public website sends as X-Site-Token to write pricing configurations. Falls back to ECHO_SUPPORT_WEBHOOK_TOKEN; unset closes the route (503).",
      secret: true,
    }),
  },
  popcorn: {
    showFlow: key("POPCORN_SHOW_FLOW", bool.default(false), {
      description:
        "Serves the page that shows what a popcorn read does to a session's words, and links the host deck to it. On in local and echo-next, off on prod.",
    }),
  },
  accounts: {
    bankIban: key("ACCOUNTS_BANK_IBAN", z.string().default("NL49 RABO 0318910535"), {
      description:
        "dembrane's IBAN: on the offer letterhead and with every invoice, for bank transfer.",
    }),
    bankBic: key("ACCOUNTS_BANK_BIC", z.string().default("RABONL2U"), {
      description: "BIC of that account, shown beside the IBAN.",
    }),
    bankAccountName: key("ACCOUNTS_BANK_ACCOUNT_NAME", z.string().default("Dembrane B.V."), {
      description: "Name the bank account is held in, shown beside the IBAN.",
    }),
    companyAddress: key(
      "ACCOUNTS_COMPANY_ADDRESS",
      z.string().default("Sint Janssingel 88, \u2018s-Hertogenbosch, NL"),
      { description: "dembrane's address on the offer letterhead." },
    ),
    companyVat: key("ACCOUNTS_COMPANY_VAT", z.string().default("NL864967433B01"), {
      description: "dembrane's VAT number on the offer letterhead.",
    }),
    companyKvk: key("ACCOUNTS_COMPANY_KVK", z.string().default("89391438"), {
      description: "dembrane's KvK (Chamber of Commerce) number on the offer letterhead.",
    }),
    reminderIntervalDays: key("ACCOUNTS_REMINDER_INTERVAL_DAYS", int.min(1).max(365).default(7), {
      description:
        "Days between reminder emails for an open customer task; a task can set its own interval.",
    }),
    slackWebhookUrl: key("ACCOUNTS_SLACK_WEBHOOK_URL", z.url().optional(), {
      description:
        "Slack incoming webhook that hears about signatures, submitted billing details and new questions. Unset is off.",
      secret: true,
    }),
    demoWorkspaceId: key("ACCOUNTS_DEMO_WORKSPACE_ID", z.uuid().optional(), {
      description:
        "Staff's workspace for demos made in echo, so staff can review them in the dashboard. Unset puts each demo in a workspace of the prospect's organisation.",
    }),
    eventsUrl: key("ACCOUNTS_EVENTS_URL", z.url().optional(), {
      description:
        "Where account events (document signed, billing details updated, ...) are posted for sam. Unset keeps them on the timeline only.",
    }),
    eventsSecret: key("ACCOUNTS_EVENTS_SECRET", z.string().optional(), {
      description: "Signs every account event (X-Webhook-Signature, HMAC-SHA256).",
      secret: true,
    }),
  },
});

export type Schema = typeof schema;
