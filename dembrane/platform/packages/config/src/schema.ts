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
    env: key("APP_ENV", z.enum(["local", "test", "preview", "staging", "prod"]), {
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
        "Where a compiled binary finds the files packages read at run time (<package>/...). Run from source, each package reads its own folder and this is ignored.",
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
    docsUrl: key("DOCS_URL", z.url().optional(), {
      description:
        "The published documentation site that describes this environment. Agents read its pages and the assistant links its citations there. Unset: the repository's docs/ when run from source.",
      public: true,
    }),
    trustedProxies: key("HTTP_TRUSTED_PROXIES", list.default([]), {
      description:
        "Addresses or CIDR ranges of our own proxies that append to X-Forwarded-For (the load balancer). Skipped when reading the caller's address.",
    }),
    proxySecret: key("HTTP_PROXY_SECRET", z.string().min(32).optional(), {
      description:
        "Shared by the web servers and the API: the API takes the caller's address from a web server that sends it. Unset: the API reads X-Forwarded-For only.",
      secret: true,
    }),
  },
  database: {
    url: key("DATABASE_URL", z.url(), {
      description: "Runtime Postgres login. Least privilege: no DDL.",
      secret: true,
    }),
    name: key(
      "DATABASE_NAME",
      z
        .string()
        .regex(/^[a-z_][a-z0-9_]*$/)
        .optional(),
      {
        description:
          "Replaces the database in DATABASE_URL. PR previews share one instance and login, each on its own database.",
      },
    ),
    poolMax: key("DATABASE_POOL_MAX", int.min(1).default(10), {
      description:
        "Application pool per API or worker instance. The budget in capacity.ts must fit max_connections.",
    }),
    queuePoolMax: key("DATABASE_QUEUE_POOL_MAX", int.min(2).default(4), {
      description:
        "DBOS executor pool per worker: half polls the queues, half checkpoints workflow steps.",
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
      description:
        "OTLP collector for traces. Unset disables export. Deployed environments leave it unset: spans would leave the EU.",
    }),
    gcpProject: key("GCP_PROJECT", z.string().optional(), {
      description:
        "Project whose Cloud Logging groups each request's log lines by trace id; set in GCP.",
    }),
    traceSampleRatio: key("TRACE_SAMPLE_RATIO", z.coerce.number().min(0).max(1).default(0.1), {
      description: "Share of requests recorded as spans. Only matters with an OTLP collector.",
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
    analytics: key("WEB_ANALYTICS", bool.optional(), {
      description:
        "Set to false to switch off PostHog (events, session replay) and the Tally script in the browser, and drop their hosts from the content security policy. Unset keeps today's behaviour, which follows the environment.",
    }),
    region: key("WEB_REGION", z.enum(["eu"]).optional(), {
      description:
        "Set to eu on the EU deployment: the logo shows EU and the sign-in footer says the app is proudly hosted in the EU.",
    }),
    storageOrigins: key(
      "WEB_STORAGE_ORIGINS",
      list.default(["https://storage.googleapis.com", "https://ams3.digitaloceanspaces.com"]),
      {
        description:
          "Origins of the storage buckets the browser loads audio and images from or uploads to, allowed by the content security policy. Wildcards such as https://*.s3.fr-par.scw.cloud work.",
      },
    ),
    previewPr: key("WEB_PREVIEW_PR", int.min(1).optional(), {
      description:
        "Pull request a PR preview was built from. The frontend shows it under the logo and on the sign-in page; unset elsewhere.",
      public: true,
    }),
    previewRepo: key(
      "WEB_PREVIEW_REPO",
      z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/)
        .default("Dembrane/echo"),
      {
        description: "GitHub repository (owner/name) the preview's pull request belongs to.",
        public: true,
      },
    ),
  },
  llm: {
    provider: key("LLM_PROVIDER", z.enum(["vertex", "openai-compatible"]).default("vertex"), {
      description:
        "Where model calls go. vertex is Google Vertex AI. openai-compatible is any OpenAI-style API (for example Scaleway), with audio turned to text by its speech-to-text endpoint first.",
    }),
    baseUrl: key("LLM_BASE_URL", z.url().optional(), {
      description:
        "Base URL of the OpenAI-compatible API, such as https://api.scaleway.ai/v1. Used when LLM_PROVIDER is openai-compatible.",
    }),
    apiKey: key("LLM_API_KEY", z.string().optional(), {
      description: "API key of the OpenAI-compatible API.",
      secret: true,
    }),
    compatTextFast: key("LLM_COMPAT_TEXT_FAST", list.default(["glm-5.3"]), {
      description: "text_fast group on the OpenAI-compatible provider, in fallback order.",
    }),
    compatMultiModalFast: key("LLM_COMPAT_MULTI_MODAL_FAST", list.default(["glm-5.3"]), {
      description: "multi_modal_fast group on the OpenAI-compatible provider, in fallback order.",
    }),
    compatMultiModalPro: key("LLM_COMPAT_MULTI_MODAL_PRO", list.default(["glm-5.3"]), {
      description: "multi_modal_pro group on the OpenAI-compatible provider, in fallback order.",
    }),
    compatEmbeddingModel: key(
      "LLM_COMPAT_EMBEDDING_MODEL",
      z.string().default("qwen3-embedding-8b"),
      {
        description:
          "Embedding model on the OpenAI-compatible provider. Vectors are cut to EMBEDDING_DIMENSIONS values (the model keeps its best information first).",
      },
    ),
    transcriptionModel: key("LLM_TRANSCRIPTION_MODEL", z.string().default("whisper-large-v3"), {
      description:
        "Speech-to-text model on the OpenAI-compatible provider. It turns audio into text before a text model reads it.",
    }),
    transcriptionLanguage: key(
      "LLM_TRANSCRIPTION_LANGUAGE",
      z.enum(["auto", "project"]).default("project"),
      {
        description:
          "Language sent to the speech-to-text model. project forces the project's language on every piece: a piece in another language is then translated or dropped. auto lets the model hear each piece, which keeps recordings that switch language (measured: a Dutch piece came back as 2 words under project and in full under auto).",
      },
    ),
    transcriptionKeyTerms: key("LLM_WHISPER_KEY_TERMS", bool.default(false), {
      description:
        "Send the project's key terms as the speech-to-text model's prompt. Off by default: on Scaleway's whisper-large-v3 the prompt made it return a third fewer words on a whole recording and nothing at all for some pieces.",
    }),
    whisperRetry: key("LLM_WHISPER_RETRY", bool.default(false), {
      description:
        "Read Whisper's own confidence on every segment (mean log probability under -1, compression ratio over 2.4) and transcribe a doubtful stretch again alone, with a higher temperature and then the language Whisper heard there; the better reading by the same signals is kept. Live pieces and the final pass. Every retry and its outcome is counted per conversation.",
    }),
    finalTextPass: key("LLM_FINAL_TEXT_PASS", z.enum(["off", "glm"]).default("off"), {
      description:
        "A text model reads the Whisper final transcript once and edits inside its sentences only: key terms spelled as the project writes them, obvious mishearings, casing. Sentence ids and timings never change. off keeps Whisper's words. glm uses the text_fast group of the provider.",
    }),
    reasoningEffort: key(
      "LLM_REASONING_EFFORT",
      z.enum(["none", "low", "medium", "high", "max"]).optional(),
      {
        description:
          "Reasoning effort sent to the OpenAI-compatible provider when a call does not ask for its own. Unset leaves the model default. Calls that turn thinking off always send none.",
      },
    ),
    maxOutputTokens: key("LLM_MAX_OUTPUT_TOKENS", int.min(1).optional(), {
      description:
        "Most answer tokens the OpenAI-compatible provider accepts per call (16384 for glm-5.3 on Scaleway). A call that asks for more is sent with this limit instead of being refused. Unset sends what the call asks for.",
    }),
    finalTranscript: key(
      "LLM_FINAL_TRANSCRIPT",
      z
        .union([
          z.array(z.string()),
          z.string().transform((v) =>
            v
              .split(/[,+\s]+/)
              .map((x) => x.trim().toLowerCase())
              .filter((x) => x && x !== "off"),
          ),
        ])
        .pipe(z.array(z.enum(["gemini", "whisper"])).max(2))
        .default([]),
      {
        description:
          "Who transcribes a whole recording again when its conversation is finished: gemini, whisper, or both separated by a comma or a plus (the first is the transcript people read, the second is kept beside it). Empty or off keeps the live 30 second text. whisper needs LLM_BASE_URL and LLM_API_KEY, whatever LLM_PROVIDER is.",
      },
    ),
    searchGrounding: key("LLM_SEARCH_GROUNDING", bool.default(true), {
      description:
        "Lets the map fact-check ground claims with Google Search. Always off when LLM_PROVIDER is not vertex; with it off, fact-check requests are refused.",
    }),
    vertexProject: key("LLM_VERTEX_PROJECT", z.string().default("dembrane-web-previews"), {
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
        description:
          "multi_modal_pro group, in fallback order. A transcription the model refuses moves down this list; gemini-3.5-flash is the one that answered refused chunks in the ECHO-980 replay, so keep it last.",
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
    cookiePrefix: key(
      "AUTH_COOKIE_PREFIX",
      z
        .string()
        .regex(/^[a-z][a-z0-9-]*$/)
        .optional(),
      {
        description:
          "First part of the sign-in cookies' names. Environments under one parent domain each take their own, so a browser keeps one session for each. Changing it signs everyone out.",
      },
    ),
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
    provider: key("MAIL_PROVIDER", z.enum(["sendgrid", "scaleway"]).default("sendgrid"), {
      description: "Which service sends transactional email.",
    }),
    scalewaySecretKey: key("SCALEWAY_MAIL_SECRET_KEY", z.string().optional(), {
      description:
        "Scaleway API secret key for Transactional Email. Unset logs each email instead of sending it.",
      secret: true,
    }),
    scalewayProjectId: key("SCALEWAY_MAIL_PROJECT_ID", z.string().optional(), {
      description: "Scaleway project that owns the verified sending domain.",
    }),
    scalewayRegion: key("SCALEWAY_MAIL_REGION", z.string().default("fr-par"), {
      description: "Scaleway region of Transactional Email.",
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
    s3Prefix: key(
      "FILES_S3_PREFIX",
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]*\/?$/)
        .optional(),
      {
        description:
          "Prepended to every key in that bucket, so deployments sharing it (PR previews, pr-<n>/) can each be deleted by prefix. Unset writes at the bucket root.",
      },
    ),
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
    s3Prefix: key(
      "STORAGE_S3_PREFIX",
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]*\/?$/)
        .optional(),
      {
        description:
          "Prepended to every key in the audio bucket, so deployments sharing it (PR previews, pr-<n>/) can each be deleted by prefix. Unset writes at the bucket root.",
      },
    ),
    localRoot: key("AUDIO_LOCAL_ROOT", z.string().default(".data/audio"), {
      description: "Where audio lands when no bucket is configured (local, test).",
    }),
  },
  media: {
    url: key("MEDIA_URL", z.url().optional(), {
      description:
        "URL of the media service that runs ffmpeg. Unset runs ffmpeg in-process (local development).",
    }),
    auth: key("MEDIA_AUTH", z.enum(["google_id_token", "none"]).default("google_id_token"), {
      description:
        "How the API and worker authenticate to MEDIA_URL. google_id_token: an identity token from the Cloud Run metadata server. none: no Authorization header, only for a media service reachable solely inside its cluster (Kubernetes). Local and test never send one.",
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
    forwardContent: key("SUPPORT_FORWARD_CONTENT", z.enum(["full", "pointer"]).default("full"), {
      description:
        "What sam is told about a support request. full sends the message and page context. pointer sends only the id, environment, source, time and a link where the request is read, never the message or page context, so customer text stays in this deployment.",
    }),
    readUrl: key(
      "SUPPORT_READ_URL",
      z
        .url()
        .refine((u) => u.includes("{id}"), "a URL containing {id}")
        .optional(),
      {
        description:
          "Where a support request is read, with {id} standing for the request id, e.g. https://grafana.eu.dembrane.com/d/eu-support/support?var-id={id}. Required when SUPPORT_FORWARD_CONTENT is pointer; unused otherwise.",
      },
    ),
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
  samples: {
    enabled: key("ENABLE_SAMPLES", bool.default(false), {
      description:
        "Gives every workspace its copy of the best-practices sample project and keeps the copies up to date. Off, the seed and the backfill write nothing: no workspace gets a copy, and copies that exist stay as they are. On everywhere but prod, which turns it on when the sample is released there.",
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
        "Days an open customer task may wait before the account's owner at dembrane is asked to check in, and between later asks; a task can set its own interval. The customer gets no email.",
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
    demoFeedbackUrl: key(
      "ACCOUNTS_DEMO_FEEDBACK_URL",
      z
        .url()
        .default("https://portal.dembrane.com/en-US/a2b7fbeb-af8d-41c8-b70b-9ff1f3c6d51a/start"),
      {
        description:
          "Where the QR on a demo made in echo leads: the participant portal of dembrane's own Product Feedback project on production, so feedback on a demo reaches dembrane and never another prospect's organisation.",
      },
    ),
    offerMessages: key("ACCOUNTS_OFFER_MESSAGES", bool.default(false), {
      description:
        "sam's inbox takes the messages of the offer flow: echo_account_document_sent_v1, echo_account_document_voided_v1, echo_account_invoice_requested_v1 and echo_account_task_waiting_v1. Turn on once the sam that handles them runs for this environment; before that sam refuses the codes and each message stays in the queue as failed. While it is off nobody is told that a customer task waits.",
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
  samInbox: {
    url: key("SAM_INBOX_URL", z.url().optional(), {
      description:
        "sam's inbox: where support requests and account events are posted, signed, instead of SUPPORT_WEBHOOK_URL and ACCOUNTS_EVENTS_URL. Set with SAM_INBOX_SECRET and SAM_INBOX_FROM or not at all; unset keeps the old routes.",
    }),
    secret: key("SAM_INBOX_SECRET", z.string().min(32).optional(), {
      description:
        "Shared with sam for this sender only; signs every inbox message (X-Webhook-Signature, HMAC-SHA256).",
      secret: true,
    }),
    from: key(
      "SAM_INBOX_FROM",
      z
        .string()
        .regex(/^[a-z0-9.-]+$/, "a lowercase host name")
        .optional(),
      {
        description:
          "Who this deployment is to sam (X-Webhook-From), e.g. api.staging.dembrane.com; sam picks the secret and the allowed codes by it.",
      },
    ),
  },
});

/** Keys that mean nothing alone: a partial set fails at boot instead of sending unsigned. */
export const together: readonly (readonly string[])[] = [
  ["samInbox.url", "samInbox.secret", "samInbox.from"],
];

export type Schema = typeof schema;
