// What @echo/present reads and writes through, on the same rows and under the same lock.
export {
  type AccessDeps,
  allows,
  popcornProject,
  popcornReport,
  projectWith,
  reachProject,
  requirePolicy,
  requirePresentEnabled,
} from "./access";
export { buildBundle } from "./bundle";
export { analysisDeck, type DeckAnalysis } from "./deck";
export {
  type DemoInput,
  type DemoResult,
  demoIdentity,
  PRODUCTION_HOSTS,
  refuseProduction,
  seedDemo,
} from "./demo";
export { demoFromFixture, type FixtureInputs } from "./demo-fixture";
export { type DemoRoutesDeps, type ProspectHook, popcornDemoRoutes } from "./demo-routes";
export { publishNudge, updateStream } from "./events";
export { popcornApiJobs, popcornTick, queueDispatch } from "./jobs";
export {
  type AudienceMap,
  deckEmbed,
  mapNotReady,
  type PublicRoutesDeps,
  publicRoutes,
} from "./public";
export { dict, directusTime, isRecord, type Json, list, orStr, pyIso, pyStr, truthy } from "./py";
export {
  binary,
  html,
  illustrationBytes,
  logoBytes,
  type PopcornRoutesDeps,
  popcornRoutes,
  webpName,
} from "./routes";
export {
  bundleForReport,
  createLock,
  createPopcorn,
  dispatchNow,
  ensurePublicToken,
  listVersions,
  loadSettingsFor,
  type PopcornDeps,
  type PopcornFlags,
  popcornDeps,
  popcornFlags,
  popcornPayload,
  projectJson,
  publishedBundle,
  rateLimit,
  readiness,
  requireUnlockedFrame,
  retargetTranslation,
  rotatePublicToken,
  settingsLock,
  updateSettingsUnlocked,
  writeSettings,
} from "./service";
export {
  audienceManifest,
  defaultSettings,
  expandSettingsPatch,
  mergeSettings,
  normalizePresentation,
  normalizeSettings,
  requireBrandingTier,
  resolvePresentationSettings,
  resolveProjectLanguage,
  TOGGLEABLE_TABS,
  translationTargets,
} from "./settings";
export { excludeNone, settingsBody } from "./shapes";
export { freshState, normalizeState } from "./state";
export {
  client as sqlClient,
  type PopcornStore,
  popcornStore,
  type Row,
  type Sql,
} from "./storage";
export { POPCORN_TICK_ASSETS } from "./tick/model";
export { runPopcornTick } from "./tick/run";
export { missingTexts, popcornTexts, translatableTexts } from "./translate";
export { continueSnippet, POPCORN_PAGE_ASSETS, renderPopcornPage } from "./view";
export {
  type Adoption,
  type PopcornWorkerDeps,
  popcornDeckHook,
  popcornWorker,
  runtimeAnalysis,
  type TickAnalysis,
  tickDeps,
} from "./worker";
