import { DrizzleAccessStore } from "@dembrane/access";
import { accountRoutes } from "@dembrane/account";
import { accountsRoutes, demoProspectHook, httpFetchText, queueJobs } from "@dembrane/accounts";
import { agentAccessRoutes } from "@dembrane/agent-access";
import { agenticRoutes } from "@dembrane/agentic";
import { analysisRoutes, analysisRuntime, clientOf } from "@dembrane/analysis";
import { posthogCapture } from "@dembrane/analytics";
import { billingRoutes, mollieWebhookRoutes } from "@dembrane/billing";
import { canvasRoutes } from "@dembrane/canvas";
import { chatRoutes } from "@dembrane/chats";
import {
  AudioUrls,
  type ConversationsDeps,
  conversationRoutes,
  PARTICIPANT_TOKEN_HEADER,
  ParticipantTokens,
} from "@dembrane/conversations";
import { reportRoutes as feedbackReportRoutes, responseRoutes } from "@dembrane/feedback";
import { vertexCompleter, vertexEmbedder } from "@dembrane/llm";
import { MapStore, mapRoutes } from "@dembrane/map";
import { notificationRoutes } from "@dembrane/notifications";
import {
  analysisDeck,
  popcornDemoRoutes,
  popcornDeps,
  popcornFlags,
  popcornRoutes,
  publicRoutes,
  queueDispatch,
} from "@dembrane/popcorn";
import { analysisMapStore, presentRoutes, publicAudienceMap } from "@dembrane/present";
import { pricingRoutes } from "@dembrane/pricing";
import { projectRoutes } from "@dembrane/projects";
import { sharedHub } from "@dembrane/realtime";
import { reportRoutes } from "@dembrane/reports";
import { staffRoutes } from "@dembrane/staff";
import { statsRoutes } from "@dembrane/stats";
import { FilesystemStorage, localStorageHandler } from "@dembrane/storage";
import { queueSink, tenancyRoutes } from "@dembrane/tenancy";
import { trainingRoutes } from "@dembrane/training";
import { verifyRoutes } from "@dembrane/verify";
import { webhookRoutes } from "@dembrane/webhooks";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Deps, Env } from "./deps";
import { correlation } from "./middleware/correlation";
import { notFound, onError } from "./middleware/errors";
import { session } from "./middleware/session";
import { systemRoutes } from "./routes/system";

/** Pure composition: no I/O at build time, so tests call app.request() with fake deps. */
export function buildApp(deps: Deps) {
  const app = new Hono<Env>();
  app.use(correlation(deps));
  app.use(secureHeaders());
  app.use(
    "/api/*",
    cors({
      origin: [deps.config.http.dashboardUrl, deps.config.http.portalUrl],
      credentials: true,
      // The portal reads its participant token from initiate's response.
      exposeHeaders: ["x-request-id", PARTICIPANT_TOKEN_HEADER],
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw));
  app.use("/api/*", session(deps));
  app.route("/", systemRoutes(deps));
  app.route("/", accountRoutes(deps));
  app.route("/", projectRoutes(deps));
  app.route(
    "/",
    webhookRoutes({
      ...deps,
      deliver: deps.deliverWebhook,
      allowPrivateTargets: deps.config.webhooks.allowPrivateTargets,
      dashboardUrl: deps.config.http.dashboardUrl,
    }),
  );
  app.route("/", notificationRoutes(deps));
  app.route("/", reportRoutes(deps));
  // One set of model calls for the analysis, map, canvas and popcorn routes.
  const completer = vertexCompleter(deps.models, {
    groups: {
      text_fast: deps.config.llm.textFast,
      multi_modal_fast: deps.config.llm.multiModalFast,
      multi_modal_pro: deps.config.llm.multiModalPro,
    },
  });
  const embedder = vertexEmbedder(deps.models, {
    project: deps.config.llm.vertexProject,
    location: deps.config.llm.embeddingLocation,
    model: deps.config.llm.embeddingModel,
  });
  app.route(
    "/",
    analysisRoutes({
      ...deps,
      jobs: deps.queue,
      completer,
      embedder,
      enablePresent: deps.config.analysis.enablePresent,
      embeddingModel: deps.config.llm.embeddingModel,
      embeddingLocation: deps.config.llm.embeddingLocation,
    }),
  );
  app.route(
    "/",
    mapRoutes({
      ...deps,
      jobs: deps.queue,
      completer,
      embedder,
      embeddingModel: deps.config.llm.embeddingModel,
      embeddingLocation: deps.config.llm.embeddingLocation,
      nodeLimitCeiling: deps.config.analysis.nodeLimitCeiling ?? null,
      edgeLimitCeiling: deps.config.analysis.edgeLimitCeiling ?? null,
    }),
  );
  app.route(
    "/",
    canvasRoutes({
      ...deps,
      completer,
      canvasEnabled: deps.config.canvas.enabled,
    }),
  );
  app.route(
    "/",
    tenancyRoutes({
      db: deps.db,
      accessStore: new DrizzleAccessStore(deps.db),
      jobs: queueSink(deps.queue),
      dashboardUrl: deps.config.http.dashboardUrl,
      inviteSecret: deps.config.account.inviteHashSecret,
    }),
  );
  app.route("/", billingRoutes(deps));
  app.route("/", mollieWebhookRoutes(deps));
  app.route("/", staffRoutes(deps));
  app.route("/", trainingRoutes(deps));
  app.route(
    "/",
    feedbackReportRoutes({ ...deps, storage: deps.files, apiBaseUrl: deps.config.http.publicUrl }),
  );
  app.route("/", responseRoutes(deps));
  app.route("/", pricingRoutes({ ...deps, storage: deps.files }));
  app.route("/", statsRoutes(deps));
  const conversations: ConversationsDeps = {
    db: deps.db,
    access: deps.access,
    audio: deps.audio,
    audioUrls: new AudioUrls(
      deps.config.audio.s3Endpoint ?? `${deps.config.http.publicUrl}/_local-audio`,
      deps.config.audio.s3Bucket ?? "local",
    ),
    jobs: deps.queue,
    models: deps.models,
    media: deps.media,
    transcriber: deps.transcriber,
    hub: deps.hub,
    limiter: deps.limiter,
    logger: deps.logger,
    tokens: new ParticipantTokens(
      deps.config.auth.secret,
      deps.config.conversations.participantTokenRequired,
    ),
    settings: {
      participantTokenRequired: deps.config.conversations.participantTokenRequired,
      monitorEnabled: deps.config.conversations.monitorEnabled,
      webhooksEnabled: deps.config.webhooks.enabled,
      dashboardUrl: deps.config.http.dashboardUrl,
    },
    now: () => new Date(),
  };
  app.route("/", conversationRoutes(conversations));
  app.route("/", verifyRoutes(conversations));
  // Local and test only: the stand-in for the buckets' presigned URLs.
  const local = deps.config.app.env === "local" || deps.config.app.env === "test";
  for (const store of [deps.files, deps.audio])
    if (local && store instanceof FilesystemStorage) {
      const handle = localStorageHandler(store, store.routePath);
      app.all(store.routePath, (c) => handle(c.req.raw));
      app.all(`${store.routePath}/*`, (c) => handle(c.req.raw));
    }
  const capture = posthogCapture(deps.config.http.dashboardUrl, deps.logger);
  app.route("/", chatRoutes({ ...deps, capture }));
  app.route("/", agenticRoutes({ ...deps, capture }));
  const sql = clientOf(deps.db);
  // Popcorn and Present read the deck and the map from the analysis store, and a deck
  // snapshot they assemble is dispatched through the analysis outbox like any other.
  const analysis = analysisRuntime({
    db: deps.db,
    logger: deps.logger,
    completer,
    embedder,
    jobs: deps.queue,
    config: {
      embeddingModel: deps.config.llm.embeddingModel,
      embeddingLocation: deps.config.llm.embeddingLocation,
    },
  });
  const popcorn = popcornDeps({
    db: deps.db,
    deck: analysisDeck(analysis.store),
    flags: popcornFlags(deps.config),
    participantBaseUrl: deps.config.http.portalUrl,
    adminBaseUrl: deps.config.http.dashboardUrl,
    showFlow: deps.config.popcorn.showFlow,
    dispatchTick: queueDispatch(deps.queue),
    limiter: deps.limiter,
    logger: deps.logger,
  });
  const hub = () => sharedHub(sql, deps.logger);
  app.route("/", popcornRoutes({ ...popcorn, access: deps.access, hub, capture }));
  const map = analysisMapStore(analysis, new MapStore(sql), {
    nodeLimit: deps.config.analysis.nodeLimitCeiling ?? null,
    edgeLimit: deps.config.analysis.edgeLimitCeiling ?? null,
  });
  const presentDeps = { ...popcorn, access: deps.access, hub, map };
  app.route("/", presentRoutes(presentDeps));
  app.route("/", publicRoutes({ ...popcorn, hub, audienceMap: publicAudienceMap(presentDeps) }));
  const accounts = {
    db: deps.db,
    access: deps.access,
    staffAudit: deps.staffAudit,
    jobs: queueJobs(deps.queue),
    files: deps.files,
    logger: deps.logger,
    now: () => new Date(),
    fetchText: deps.fetchText ?? httpFetchText,
    settings: {
      dashboardUrl: deps.config.http.dashboardUrl,
      company: {
        name: "dembrane B.V.",
        address: deps.config.accounts.companyAddress,
        vat: deps.config.accounts.companyVat,
        kvk: deps.config.accounts.companyKvk,
        iban: deps.config.accounts.bankIban,
        bic: deps.config.accounts.bankBic,
        accountName: deps.config.accounts.bankAccountName,
      },
      eventsEnabled: Boolean(deps.config.accounts.eventsUrl),
      slackEnabled: Boolean(deps.config.accounts.slackWebhookUrl),
      reminderIntervalDays: deps.config.accounts.reminderIntervalDays,
      inviteSecret: deps.config.account.inviteHashSecret,
      demo: {
        portalUrl: deps.config.http.portalUrl,
        apiUrl: deps.config.http.publicUrl,
        ownUrls: [
          deps.config.http.publicUrl,
          deps.config.http.dashboardUrl,
          deps.config.http.portalUrl,
        ],
        workspaceId: deps.config.accounts.demoWorkspaceId ?? null,
      },
    },
  };
  app.route("/", accountsRoutes(accounts));
  app.route(
    "/",
    popcornDemoRoutes({
      db: deps.db,
      staffAudit: deps.staffAudit,
      prospect: demoProspectHook(accounts),
      ownUrls: [
        deps.config.http.publicUrl,
        deps.config.http.dashboardUrl,
        deps.config.http.portalUrl,
      ],
    }),
  );
  app.route(
    "/",
    agentAccessRoutes({
      ...deps,
      accessStore: new DrizzleAccessStore(deps.db),
      capture,
      publicUrl: deps.config.http.publicUrl,
      dashboardUrl: deps.config.http.dashboardUrl,
      buildVersion: deps.config.app.release,
      clientSecretKey:
        deps.config.agentAccess.clientSecretKey ?? deps.config.account.inviteHashSecret,
    }),
  );
  app.onError(onError);
  app.notFound(notFound);
  return app;
}
