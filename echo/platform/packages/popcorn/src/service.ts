import { createHash, randomBytes } from "node:crypto";
import { LockUnavailableError, NotFoundError, newId, RateLimitedError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import { buildBundle, DEFAULT_LEGAL_BASIS } from "./bundle";
import {
  applyPublishedObjects,
  applyResultBindings,
  curatePresentation,
  type DeckAnalysis,
  withoutObjects,
} from "./deck";
import { publishNudge } from "./events";
import {
  asId,
  dict,
  directusTime,
  isRecord,
  type Json,
  orStr,
  pyEqual,
  pyIso,
  strip,
  truthy,
} from "./py";
import {
  DEFAULT_CADENCE_MINUTES,
  defaultSettings,
  FRAME_BLOCKS,
  LIVE_HOURS,
  LOOP_KIND,
  mergeSettings,
  normalizeSettings,
  REPORT_KIND,
  resolvePresentationSettings,
  syntheticFrameLocked,
  translationTargets,
} from "./settings";
import { freshState, isSyntheticSession, normalizeState, stateCounts } from "./state";
import { client, type PopcornStore, popcornStore, type Row, type Sql } from "./storage";
import { pySplit } from "./text";
import { translatedBundle } from "./translate";

/**
 * Popcorn sessions: one live deck per project, on the canvas loop machinery. A session is
 * a project_report row of kind popcorn with one canvas_config_revision (settings) and one
 * agent_loop (mode, expiry, extraction state). The loop's status carries the mode:
 * `paused` is manual (a refresh runs one tick), `active` is live (the two-minute chain
 * until `expires_at`, then back to manual).
 */

export interface PopcornFlags {
  readonly present: boolean;
  readonly canvas: boolean;
}

/** What a tick dispatch asks the queue for; the worker turns it into the tick workflow. */
export interface TickRequest {
  readonly loopId: string;
  readonly tickKind: string;
  readonly requestId: string;
}

export interface PopcornDeps {
  readonly db: Db;
  readonly store: PopcornStore;
  readonly deck: DeckAnalysis;
  readonly flags: PopcornFlags;
  readonly participantBaseUrl: string;
  readonly adminBaseUrl: string;
  /** Local development: the host deck links to the flow page, which is served. */
  readonly showFlow: boolean;
  /** Hands a tick to the worker now, inside the transaction that booked its backup row. */
  readonly dispatchTick: (tx: Sql, request: TickRequest) => Promise<void>;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly now: () => Date;
}

export function popcornDeps(
  base: Omit<PopcornDeps, "store" | "now"> & { now?: () => Date },
): PopcornDeps {
  return { ...base, store: popcornStore(client(base.db)), now: base.now ?? (() => new Date()) };
}

const SETTINGS_LOCK_WAIT_MS = 5_000;
const CREATE_LOCK_WAIT_MS = 5_000;
const REFRESH_TTL_SECONDS = 20;

/** uuid5(NAMESPACE_URL, name), the deterministic ids the Python service minted. */
export function uuid5Url(name: string): string {
  const ns = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = ((b[6] as number) & 0x0f) | 0x50;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** secrets.token_urlsafe(24) */
export function tokenUrlsafe(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** A Directus timestamp field as the dashboard read it. */
const iso = (v: unknown): string | null => directusTime(v);

// ── locks ─────────────────────────────────────────────────────────────

/**
 * One transaction holding an advisory lock on `key`, retried until the deadline. Busy or
 * unreachable answers 503 with the text the dashboard retries on; nothing is written.
 */
async function locked<T>(
  d: PopcornDeps,
  key: string,
  waitMs: number,
  busy: string,
  fn: (store: PopcornStore, tx: Sql) => Promise<T>,
): Promise<T> {
  const sql = client(d.db);
  return (await sql.begin(async (tx) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const [r] = await tx`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as ok`;
      if (r?.ok) break;
      if (Date.now() >= deadline) throw new LockUnavailableError(busy);
      await Bun.sleep(50);
    }
    return fn(popcornStore(tx), tx);
  })) as T;
}

export function settingsLock<T>(
  d: PopcornDeps,
  reportId: string,
  fn: (store: PopcornStore, tx: Sql) => Promise<T>,
): Promise<T> {
  return locked(
    d,
    `popcorn:settings-write:${reportId}`,
    SETTINGS_LOCK_WAIT_MS,
    "Settings are busy; try again",
    fn,
  );
}

export function createLock<T>(
  d: PopcornDeps,
  projectId: string,
  fn: (store: PopcornStore, tx: Sql) => Promise<T>,
): Promise<T> {
  return locked(
    d,
    `popcorn:presentation-create:${projectId}`,
    CREATE_LOCK_WAIT_MS,
    "Presentation creation is busy; try again",
    fn,
  );
}

/** One press per twenty seconds per action; a second press lands on the tick already queued. */
export async function rateLimit(d: PopcornDeps, popcornId: string, action = "refresh") {
  const ok = await d.limiter.allow(
    { name: `popcorn:${action}`, capacity: 1, windowSeconds: REFRESH_TTL_SECONDS },
    popcornId,
  );
  if (!ok) throw new RateLimitedError("Just read");
}

// ── reads ─────────────────────────────────────────────────────────────

export function loopMode(loop: Row | null): string {
  return loop?.status === "active" ? "live" : "manual";
}

export function isPopcornLoop(loop: Row | null): boolean {
  const caps = loop?.caps;
  return isRecord(caps) && caps.kind === LOOP_KIND;
}

export async function loadSettingsFor(store: PopcornStore, report: Row): Promise<Json> {
  const config = await store.latestConfig(String(report.id));
  return normalizeSettings(config?.popcorn_settings, orStr(report.user_instructions, "Popcorn"));
}

function loopPayload(loop: Row | null, run: Row | null, nextAt: string | null): Json | null {
  if (!loop) return null;
  return {
    id: String(loop.id),
    status: loop.status ?? null,
    mode: loopMode(loop),
    expires_at: iso(loop.expires_at),
    cadence_minutes: loop.cadence_minutes ?? null,
    next_read_at: nextAt,
    last_run_started_at: iso(run?.started_at),
    last_run_status: run?.status ?? null,
    last_run_detail: run?.detail ?? null,
  };
}

export interface Captured {
  loop: Row | null;
  run: Row | null;
  config: Row | null;
  state: Json;
}

/** The session as the dashboard reads it; `capture` hands back the rows this read fetched. */
export async function popcornPayload(
  store: PopcornStore,
  report: Row,
  capture?: Partial<Captured>,
): Promise<Json> {
  const reportId = String(report.id);
  const loop = await store.loopForReport(reportId);
  const run = loop ? await store.latestRun(String(loop.id)) : null;
  const config = await store.latestConfig(reportId);
  const settings = normalizeSettings(
    config?.popcorn_settings,
    orStr(report.user_instructions, "Popcorn"),
  );
  const state = normalizeState(loop?.popcorn_state);
  if (capture) Object.assign(capture, { loop, run, config, state });
  const nextAt = loop ? ((await store.pendingTickTimes(String(loop.id)))[0] ?? null) : null;
  return {
    id: reportId,
    kind: REPORT_KIND,
    project_id: asId(report.project_id),
    name: settings.title,
    created_at: iso(report.date_created),
    updated_at: iso(loop?.updated_at),
    settings,
    // A synthetic demo's disclosure and notice are the demo's; the dashboard leaves them out.
    synthetic: isSyntheticSession(state),
    public_token: report.public_token ?? null,
    loop: loopPayload(loop, run, nextAt),
    counts: stateCounts(state),
  };
}

/** What a first read would find: conversations with a transcript, and their words. */
export async function gatherTranscripts(store: PopcornStore, projectId: string): Promise<Json[]> {
  const { conversations, chunks } = await store.transcripts(projectId);
  const byConversation = new Map<string, string[]>();
  for (const chunk of chunks) {
    const cid = asId(chunk.conversation_id);
    const text = strip(orStr(chunk.transcript));
    if (cid && text) byConversation.set(cid, [...(byConversation.get(cid) ?? []), text]);
  }
  const out: Json[] = [];
  conversations.forEach((conv, i) => {
    const cid = asId(conv.id);
    if (!cid) return;
    const text = strip((byConversation.get(cid) ?? []).join("\n"));
    if (!text) return;
    const name = strip(orStr(conv.participant_name));
    const full = name || `Conversation ${i + 1}`;
    const short = [...full].length <= 24 ? full : `${[...full].slice(0, 23).join("")}…`;
    out.push({
      id: cid,
      label: full,
      short,
      created_at: iso(conv.created_at),
      duration: conv.duration ?? null,
      text,
    });
  });
  return out;
}

export async function readiness(store: PopcornStore, projectId: string) {
  const transcripts = await gatherTranscripts(store, projectId);
  return {
    conversations: transcripts.length,
    words: transcripts.reduce((n, t) => n + pySplit(orStr(t.text)).length, 0),
  };
}

export async function listVersions(store: PopcornStore, reportId: string, limit = 30) {
  return (await store.versions(reportId, limit)).map((row) => ({
    id: String(row.id),
    created_at: iso(row.created_at),
    tick_kind: row.tick_kind ?? null,
    detail: row.detail ?? null,
  }));
}

export async function versionFiles(
  store: PopcornStore,
  reportId: string,
  versionId: string,
): Promise<Json | null> {
  const row = await store.version(versionId);
  if (!row || asId(row.report_id) !== reportId) return null;
  try {
    const parsed = JSON.parse(orStr(row.content_html));
    const files = isRecord(parsed) ? parsed.files : null;
    return isRecord(files) ? files : null;
  } catch {
    return null;
  }
}

// ── writes ────────────────────────────────────────────────────────────

/**
 * Books the backup row and hands the tick to the worker now, with one identity for both
 * deliveries: under the run lock, a completed run with this id makes the later one a no-op.
 */
export async function dispatchTick(
  d: PopcornDeps,
  tx: Sql,
  loopId: string,
  tickKind = "manual",
): Promise<void> {
  const requestId = newId();
  const now = d.now();
  await popcornStore(tx).scheduleTick({
    id: newId(),
    payload: { loop_id: loopId, tick_kind: tickKind, request_id: requestId },
    scheduledAt: pyIso(now),
    now: pyIso(now),
  });
  await d.dispatchTick(tx, { loopId, tickKind, requestId });
}

export interface CreateArgs {
  readonly projectId: string;
  readonly title: string;
  readonly client: string | null;
  readonly actor: string;
  readonly startProcessing?: boolean;
  readonly initialSettings?: Json | null;
  readonly report?: Row | null;
}

/**
 * The report row, its settings revision and its loop in manual mode, and optionally one
 * read. Config and loop ids derive from the report id, so a repair converges.
 */
export async function createPopcorn(
  d: PopcornDeps,
  tx: Sql,
  a: CreateArgs,
): Promise<{ report: Row; config: Row; loop: Row }> {
  const store = popcornStore(tx);
  const repairing = a.report !== undefined && a.report !== null;
  const nowIso = pyIso(d.now());
  const report =
    a.report ??
    (await store.insertReport({
      projectId: a.projectId,
      title: a.title,
      token: tokenUrlsafe(),
      userCreated: a.actor,
      now: nowIso,
    }));
  const reportId = String(report.id);
  let config = repairing ? await store.latestConfig(reportId) : null;
  config ??= await store.insertConfigOnce({
    id: uuid5Url(`popcorn:report:${reportId}:config`),
    reportId,
    brief: "",
    settings: a.initialSettings ?? defaultSettings(a.title, a.client),
    cadence: DEFAULT_CADENCE_MINUTES,
    createdBy: a.actor,
    note: "initial",
    now: nowIso,
  });
  let loop = repairing ? await store.loopForReport(reportId) : null;
  loop ??= await store.insertLoopOnce({
    id: uuid5Url(`popcorn:report:${reportId}:loop`),
    projectId: a.projectId,
    reportId,
    name: a.title,
    expiresAt: pyIso(d.now()),
    cadence: DEFAULT_CADENCE_MINUTES,
    actingUser: a.actor,
    state: freshState(),
    now: nowIso,
  });
  if (a.startProcessing ?? true) await dispatchTick(d, tx, String(loop.id), "manual");
  return { report, config, loop };
}

export async function ensurePublicToken(d: PopcornDeps, report: Row): Promise<string> {
  const token = orStr(report.public_token);
  if (token) return token;
  const fresh = tokenUrlsafe();
  await d.store.updateReport(String(report.id), { public_token: fresh }, pyIso(d.now()));
  report.public_token = fresh;
  return fresh;
}

/** A fresh link for a deck going public again (hole L-8): the old link stays dead. */
export async function rotatePublicToken(d: PopcornDeps, report: Row): Promise<string> {
  const fresh = tokenUrlsafe();
  await d.store.updateReport(String(report.id), { public_token: fresh }, pyIso(d.now()));
  report.public_token = fresh;
  return fresh;
}

/**
 * Store the settings and let a changed title reach the report and the loop. With `nudge`
 * the room is told to reload once the write commits.
 */
export async function writeSettings(
  d: PopcornDeps,
  store: PopcornStore,
  tx: Sql,
  report: Row,
  config: Row,
  settings: Json,
  fallbackTitle: string,
  nudge: boolean,
): Promise<void> {
  const reportId = String(report.id);
  await store.writeSettings(String(config.id), settings);
  if (settings.title !== fallbackTitle) {
    const now = pyIso(d.now());
    await store.updateReport(reportId, { user_instructions: settings.title }, now);
    const loop = await store.loopForReport(reportId);
    if (loop) await store.updateLoop(String(loop.id), { name: settings.title }, now);
  }
  if (nudge) {
    forgetBundle(reportId);
    await publishNudge(tx, reportId, d.logger);
  }
}

/** Settings updated in place; they are toggles, not analysis config, so no new revision. */
export async function updateSettingsUnlocked(
  d: PopcornDeps,
  store: PopcornStore,
  tx: Sql,
  report: Row,
  patch: Json,
): Promise<Json> {
  const config = await store.latestConfig(String(report.id));
  if (!config) throw new Error("Popcorn settings revision not found");
  const fallbackTitle = orStr(report.user_instructions, "Popcorn");
  const raw = dict(config.popcorn_settings);
  const current = normalizeSettings(raw, fallbackTitle);
  const settings = mergeSettings(current, patch, fallbackTitle);
  // Present keeps its unpublished editor state beside the published settings.
  if (isRecord(raw._present_draft)) settings._present_draft = raw._present_draft;
  await writeSettings(d, store, tx, report, config, settings, fallbackTitle, true);
  return normalizeSettings(settings, fallbackTitle);
}

export function updateSettings(d: PopcornDeps, report: Row, patch: Json): Promise<Json> {
  return settingsLock(d, String(report.id), (store, tx) =>
    updateSettingsUnlocked(d, store, tx, report, patch),
  );
}

/**
 * Translate into a newly chosen language now, not at the next scheduled read. Returns
 * whether the languages changed.
 */
export async function retargetTranslation(
  d: PopcornDeps,
  report: Row,
  args: {
    before: Json;
    after: Json;
    project: Json;
    projectAfter?: Json;
    nudge?: boolean;
    requireLoop?: boolean;
  },
): Promise<boolean> {
  const targets = translationTargets(args.after, args.projectAfter ?? args.project);
  const before = new Set(translationTargets(args.before, args.project));
  const after = new Set(targets);
  if (!targets.length || (after.size === before.size && [...after].every((t) => before.has(t))))
    return false;
  const reportId = String(report.id);
  const sql = client(d.db);
  if (args.nudge) {
    forgetBundle(reportId);
    await publishNudge(sql, reportId, d.logger);
  }
  const loop = await d.store.loopForReport(reportId);
  if (!loop) {
    if (args.requireLoop ?? true) throw new NotFoundError("Popcorn loop not found");
    return true;
  }
  await sql.begin((tx) => dispatchTick(d, tx, String(loop.id), "translation"));
  return true;
}

/** Live for so many hours: the two-minute chain until the expiry, reading straight away. */
export async function goLive(d: PopcornDeps, loop: Row, hours: number): Promise<void> {
  if (!(LIVE_HOURS as readonly number[]).includes(hours))
    throw new InvalidHours(`hours must be one of (${LIVE_HOURS.join(", ")})`);
  const now = d.now();
  const expires = new Date(now.getTime() + hours * 3_600_000);
  await client(d.db).begin(async (tx) => {
    await popcornStore(tx).updateLoop(
      String(loop.id),
      { status: "active", expires_at: pyIso(expires), failure_count: 0 },
      pyIso(now),
    );
    await dispatchTick(d, tx, String(loop.id), "manual");
  });
}

export class InvalidHours extends Error {}

/** Back to manual: nothing scheduled, the deck stays, refresh still works. */
export async function stopLive(d: PopcornDeps, loop: Row): Promise<void> {
  const now = pyIso(d.now());
  await client(d.db).begin(async (tx) => {
    const store = popcornStore(tx);
    await store.cancelPendingTicks(String(loop.id), now);
    await store.updateLoop(String(loop.id), { status: "paused", expires_at: now }, now);
  });
}

/** Wipe phrases, quotes and analysis and read everything again, inside the tick, under its lock. */
export async function requestRerun(d: PopcornDeps, loop: Row): Promise<void> {
  await client(d.db).begin((tx) => dispatchTick(d, tx, String(loop.id), "rerun"));
}

export async function dispatchNow(d: PopcornDeps, loopId: string, tickKind: string): Promise<void> {
  await client(d.db).begin((tx) => dispatchTick(d, tx, loopId, tickKind));
}

/**
 * A synthetic demo's disclosure and notice belong to the demo. With `proposed` settings the
 * published wording is compared, so a write that leaves the frame as it is passes.
 */
export async function requireUnlockedFrame(
  store: PopcornStore,
  report: Row,
  loop: Row | null,
  proposed?: Json,
): Promise<void> {
  if (!isSyntheticSession(normalizeState(loop?.popcorn_state))) return;
  if (proposed !== undefined) {
    const published = await loadSettingsFor(store, report);
    if (FRAME_BLOCKS.every((name) => pyEqual(proposed[name], published[name]))) return;
  }
  throw syntheticFrameLocked();
}

// ── the bundle the pages read ─────────────────────────────────────────

const BUNDLE_CACHE_MS = 500;
const cache = new Map<string, { at: number; bundle: Json }>();

/** Writers drop the process's memo before they nudge, so a reread sees their write. */
export function forgetBundle(reportId: string): void {
  cache.delete(`${reportId}:host`);
  cache.delete(`${reportId}:public`);
}

/** The project as the data screen describes it: its legal basis through workspace and owner. */
async function withEffectiveLegalBasis(store: PopcornStore, project: Row, settings: Json) {
  if (!truthy(dict(settings.data).enabled) || !truthy(project.id)) return project;
  const rows = await store.legalCascade(project);
  const levels = [project, rows.workspace, rows.owner];
  const level = levels.find((l) => l && truthy(l.legal_basis));
  return {
    ...project,
    legal_basis: level ? level.legal_basis : DEFAULT_LEGAL_BASIS,
    privacy_policy_url: level ? (level.privacy_policy_url ?? null) : null,
  };
}

/** `bundle` with the published objects applied; a store that cannot answer leaves it standing. */
export async function publishedBundle(
  d: PopcornDeps,
  bundle: Json,
  args: { projectId: string | null; settings: Json; project: Json; host: boolean },
): Promise<Json> {
  if (!args.projectId) return bundle;
  try {
    const objects = await d.deck.deckObjects(args.projectId);
    return applyPublishedObjects(bundle, objects, {
      settings: args.settings,
      project: args.project,
      host: args.host,
      adminBaseUrl: d.adminBaseUrl,
    });
  } catch (err) {
    // The deck is polled several times a second: say it plainly and once per read.
    d.logger.warn({ reason: (err as Error).name }, "popcorn deck: published objects unavailable");
    return bundle;
  }
}

export async function bundleForReport(
  d: PopcornDeps,
  report: Row,
  projectIn: Row | null,
  opts: { host?: boolean; settingsOverride?: Json } = {},
): Promise<Json> {
  const host = opts.host ?? false;
  const reportId = String(report.id);
  const key = `${reportId}:${host ? "host" : "public"}`;
  const at = performance.now();
  const hit = opts.settingsOverride === undefined ? cache.get(key) : undefined;
  if (hit && at - hit.at < BUNDLE_CACHE_MS) return hit.bundle;

  const store = d.store;
  const loop = await store.loopForReport(reportId);
  let settings = opts.settingsOverride ?? (await loadSettingsFor(store, report));
  let project: Row = projectIn ?? {};
  if (projectIn === null) {
    const pid = asId(report.project_id);
    project = (pid ? await store.project(pid) : null) ?? {};
  }
  settings = resolvePresentationSettings(settings, project);
  project = await withEffectiveLegalBasis(store, project, settings);
  const state = normalizeState(loop?.popcorn_state);
  let bundle = buildBundle({
    state,
    settings,
    report,
    project: projectJson(project),
    participantBaseUrl: d.participantBaseUrl,
    adminBaseUrl: d.adminBaseUrl,
    host,
    dev: d.showFlow,
    now: d.now(),
  });
  const projectId = asId(project.id) ?? asId(report.project_id);
  bundle = await publishedBundle(d, bundle, {
    projectId,
    settings,
    project: projectJson(project),
    host,
  });
  bundle = await applyResultBindings(bundle, {
    settings,
    projectId,
    deck: d.deck,
    versionFiles: (v) => versionFiles(store, reportId, v),
  });
  bundle = translatedBundle(bundle, state, settings);
  if (projectId) bundle = withoutObjects(bundle, await d.deck.excludedObjectIds(projectId));
  bundle = curatePresentation(bundle, settings);
  if (opts.settingsOverride === undefined) cache.set(key, { at, bundle });
  if (cache.size > 512) {
    const oldest = [...cache.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, cache.size - 256);
    for (const [k] of oldest) cache.delete(k);
  }
  return bundle;
}

/** A project row as the Python dicts held it: ids as strings, timestamps as Directus text. */
export function projectJson(project: Row): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(project)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

/** ENABLE_PRESENT (analysis section) and ENABLE_CANVAS (canvas section), as the config declares them. */
export function popcornFlags(config: {
  readonly analysis: { readonly enablePresent: boolean };
  readonly canvas: { readonly enabled: boolean };
}): PopcornFlags {
  return { present: config.analysis.enablePresent, canvas: config.canvas.enabled };
}
