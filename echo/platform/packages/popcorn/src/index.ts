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
export { type Capture, noCapture, posthogCapture } from "./capture";
export { type DeckAnalysis, DeckUnavailable, sqlDeckAnalysis } from "./deck";
export { demoIdentity, PRODUCTION_HOSTS, seedDemo } from "./demo";
export { type DemoRoutesDeps, popcornDemoRoutes } from "./demo-routes";
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
export { missingTexts, popcornTexts, translatableTexts } from "./translate";
export { renderPopcornPage } from "./view";
export { type PopcornWorkerDeps, popcornWorker } from "./worker";
