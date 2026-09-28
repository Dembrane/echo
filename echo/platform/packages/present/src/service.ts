import { AnalysisStoreError } from "@echo/analysis";
import { ConflictError } from "@echo/core";
import {
  buildBundle,
  createLock,
  createPopcorn,
  defaultSettings,
  dict,
  freshState,
  isRecord,
  type Json,
  listVersions,
  loadSettingsFor,
  mergeSettings,
  missingTexts,
  normalizePresentation,
  normalizeSettings,
  normalizeState,
  orStr,
  type PopcornDeps,
  type PopcornStore,
  popcornPayload,
  popcornTexts,
  projectJson,
  publishedBundle,
  pyIso,
  pyStr,
  type Row,
  resolvePresentationSettings,
  resolveProjectLanguage,
  type Sql,
  settingsLock,
  TOGGLEABLE_TABS,
  translatableTexts,
  translationTargets,
  truthy,
  updateSettingsUnlocked,
  writeSettings,
} from "@echo/popcorn";
import type { MapStore } from "./map";

/**
 * A presentation is the project's popcorn report and its settings row: no storage of its
 * own. The host edits a draft kept beside the published settings (`_present_draft`), and
 * publishes it, or puts a few opening words live straight from the slide.
 */

export const DRAFT_CONFLICT_DETAIL = "The presentation draft changed elsewhere.";
/** How a translation tick writes a failure into its run detail. */
const TRANSLATION_FAILURE_PREFIX = "translation failed: ";

const TRANSLATION_OFF: Json = {
  target: null,
  targets: [],
  total: 0,
  translated: 0,
  pending: 0,
  state: "off",
  detail: null,
};

const FALLBACK_TITLES: Record<string, string> = {
  en: "Presentation",
  nl: "Presentatie",
  de: "Präsentation",
  fr: "Présentation",
  es: "Presentación",
  it: "Presentazione",
  uk: "Презентація",
  cs: "Prezentace",
};

export const draftConflict = () => new ConflictError(DRAFT_CONFLICT_DETAIL);

/** datetime.now(timezone.utc).isoformat(): the Python clock carries microseconds. */
function savedAt(now: Date): string {
  return pyIso(now, 1);
}

/** The project's presentation, created (or repaired) with Present's defaults. */
export async function ensureDefault(d: PopcornDeps, project: Row, actorId: string): Promise<Row> {
  const projectId = String(project.id);
  const [code] = resolveProjectLanguage(project.language);
  const title =
    [...orStr(project.name).trim()].slice(0, 160).join("") || (FALLBACK_TITLES[code] as string);
  const settings = defaultSettings(title);
  settings.tabs = Object.fromEntries(TOGGLEABLE_TABS.map((k) => [k, false]));
  settings.presentation = normalizePresentation({ language_policy: "project" });
  // A useful opening before any analysis exists; the host adds supporting copy later.
  settings.intro = { enabled: true, title, subtitle: "" };
  settings.data = { enabled: true };
  settings.recipe_settings = { voice: settings.voice };
  const created = await createLock(d, projectId, async (store, tx) => {
    const existing = await store.popcornReport(projectId);
    const made = await createPopcorn(d, tx, {
      projectId,
      title: orStr(existing?.user_instructions) || title,
      client: null,
      actor: actorId,
      report: existing,
      initialSettings: settings,
      startProcessing: false,
    });
    if (existing) {
      // Legacy choices and identity stay; a partial creation got its config and loop above.
      const stored = normalizeSettings(
        made.config.popcorn_settings,
        orStr(made.report.user_instructions, "Popcorn"),
      );
      if (!truthy(stored.presentation)) {
        const tabs = dict(stored.tabs);
        const blocks = ["popcorn", ...TOGGLEABLE_TABS.filter((k) => truthy(tabs[k]))];
        await updateSettingsUnlocked(d, store, tx, made.report, {
          presentation: { blocks, opening: "popcorn", language_policy: "explicit" },
        });
      }
    }
    return made.report;
  });
  return created;
}

function translationFailure(run: Row | null): string | null {
  if (run?.status !== "error") return null;
  const detail = orStr(run.detail);
  if (!detail.startsWith(TRANSLATION_FAILURE_PREFIX)) return null;
  return detail.slice(TRANSLATION_FAILURE_PREFIX.length) || null;
}

/** How far the chosen translation has got. A pure read; a deck that cannot be read shows off. */
export async function translationStatus(
  d: PopcornDeps,
  report: Row,
  project: Row,
  settings: Json,
  state: Json,
  run: Row | null,
): Promise<Json> {
  try {
    const targets = translationTargets(settings, projectJson(project));
    if (!targets.length) return { ...TRANSLATION_OFF };
    const target = targets[0] as string;
    const resolved = resolvePresentationSettings(settings, projectJson(project));
    const projectId =
      project.id != null
        ? pyStr(project.id)
        : report.project_id != null
          ? pyStr(report.project_id)
          : null;
    const bundle = buildBundle({
      state,
      settings: resolved,
      report,
      project: projectJson(project),
      participantBaseUrl: d.participantBaseUrl,
      now: d.now(),
    });
    const files = dict(
      (
        await publishedBundle(d, bundle, {
          projectId,
          settings: resolved,
          project: projectJson(project),
          host: false,
        })
      ).files,
    );
    const tables = dict(state.translations);
    const phrases = popcornTexts(files);
    const rows = targets.map((code, index) => {
      const texts = index === 0 ? translatableTexts(files) : phrases;
      const owed = missingTexts(files, dict(tables[code]), code, texts).length;
      return { target: code, total: texts.length, translated: texts.length - owed, pending: owed };
    });
    const total = rows.reduce((n, r) => n + r.total, 0);
    const pending = rows.reduce((n, r) => n + r.pending, 0);
    const failure = translationFailure(run);
    const [source] = resolveProjectLanguage(project.language);
    let named: string;
    if (target === source && !total) named = "off";
    else if (!pending) named = "done";
    else named = failure ? "incomplete" : "translating";
    return {
      target,
      targets: rows,
      total,
      translated: total - pending,
      pending,
      state: named,
      detail: named === "incomplete" ? failure : null,
    };
  } catch (err) {
    d.logger.warn({ err, report: report.id }, "present: translation status unavailable");
    return { ...TRANSLATION_OFF };
  }
}

export async function payload(d: PopcornDeps, report: Row, project: Row): Promise<Json> {
  const capture: { state?: Json; run?: Row | null } = {};
  const detail = await popcornPayload(d.store, report, capture);
  const resolved = resolvePresentationSettings(dict(detail.settings), projectJson(project));
  const [language, fallback] = resolveProjectLanguage(project.language);
  detail.effective_language = resolved.language;
  detail.project_language = { code: language, fallback };
  detail.translation_status = await translationStatus(
    d,
    report,
    project,
    dict(detail.settings),
    capture.state ?? freshState(),
    capture.run ?? null,
  );
  return detail;
}

export async function draftPayload(
  d: PopcornDeps,
  report: Row,
  project: Row,
  settings: Json,
): Promise<Json> {
  const capture: { state?: Json; run?: Row | null } = {};
  const detail = await popcornPayload(d.store, report, capture);
  detail.settings = settings;
  detail.name = settings.title;
  const resolved = resolvePresentationSettings(settings, projectJson(project));
  const [language, fallback] = resolveProjectLanguage(project.language);
  detail.effective_language = resolved.language;
  detail.project_language = { code: language, fallback };
  // The host is looking at what the draft will do: its own resolved language is the target.
  detail.translation_status = await translationStatus(
    d,
    report,
    project,
    settings,
    capture.state ?? freshState(),
    capture.run ?? null,
  );
  return detail;
}

export interface DraftState {
  readonly config: Row;
  readonly published: Json;
  readonly settings: Json;
  readonly revision: number;
  readonly savedAt: string | null;
}

export async function draftState(store: PopcornStore, report: Row): Promise<DraftState> {
  const config = await store.latestConfig(String(report.id));
  if (!config) throw new Error("Popcorn settings revision not found");
  const fallbackTitle = orStr(report.user_instructions, "Popcorn");
  const raw = dict(config.popcorn_settings);
  const published = normalizeSettings(raw, fallbackTitle);
  const stored = dict(raw._present_draft);
  const settings = normalizeSettings(
    isRecord(stored.settings) ? stored.settings : published,
    fallbackTitle,
  );
  // Result bindings advance outside the editor; an older draft must not roll them back.
  if (truthy(settings.presentation) && truthy(published.presentation))
    settings.presentation = {
      ...dict(settings.presentation),
      result_bindings: dict(published.presentation).result_bindings ?? {},
    };
  const revision =
    typeof stored.revision === "number" && Number.isInteger(stored.revision) ? stored.revision : 0;
  return {
    config,
    published,
    settings,
    revision: Math.max(0, revision),
    savedAt: typeof stored.saved_at === "string" ? stored.saved_at : null,
  };
}

export async function saveDraft(
  d: PopcornDeps,
  report: Row,
  patch: Json,
  expectedRevision: number,
): Promise<DraftState> {
  return settingsLock(d, String(report.id), async (store) => {
    const state = await draftState(store, report);
    if (state.revision !== expectedRevision) throw draftConflict();
    const fallbackTitle = orStr(report.user_instructions, "Popcorn");
    const settings = mergeSettings(state.settings, patch, fallbackTitle);
    const at = savedAt(d.now());
    const revision = state.revision + 1;
    const raw: Json = isRecord(state.config.popcorn_settings)
      ? { ...state.config.popcorn_settings }
      : { ...state.published };
    raw._present_draft = { revision, saved_at: at, settings };
    // An autosave touches the draft only: the room hears nothing until the host publishes.
    await store.writeSettings(String(state.config.id), raw);
    return { ...state, settings, revision, savedAt: at };
  });
}

export async function publishDraft(
  d: PopcornDeps,
  report: Row,
  expectedRevision: number,
): Promise<DraftState> {
  return settingsLock(d, String(report.id), async (store, tx) => {
    const state = await draftState(store, report);
    if (state.revision !== expectedRevision) throw draftConflict();
    const at = savedAt(d.now());
    const revision = state.revision + 1;
    const settings: Json = {
      ...state.settings,
      _present_draft: { revision, saved_at: at, settings: state.settings },
    };
    await writeSettings(
      d,
      store,
      tx,
      report,
      state.config,
      settings,
      orStr(report.user_instructions, "Popcorn"),
      true,
    );
    return { ...state, published: state.settings, revision, savedAt: at };
  });
}

/**
 * A few words of the opening live, the rest of the draft left alone: merged onto the
 * published settings and onto the draft in one write, under the lock, so it asks for no
 * revision. `validate` sees the published settings the write would leave.
 */
export async function publishOpening(
  d: PopcornDeps,
  report: Row,
  patch: Json,
  validate: (published: Json) => Promise<void>,
): Promise<DraftState> {
  return settingsLock(d, String(report.id), async (store, tx: Sql) => {
    const state = await draftState(store, report);
    const fallbackTitle = orStr(report.user_instructions, "Popcorn");
    const published = mergeSettings(state.published, patch, fallbackTitle);
    await validate(published);
    const settings = mergeSettings(state.settings, patch, fallbackTitle);
    const raw = state.config.popcorn_settings;
    let revision = state.revision;
    let at = state.savedAt;
    const stored: Json = { ...published };
    // Without a stored draft the draft reads as the published settings and keeps following them.
    if (isRecord(raw) && isRecord(raw._present_draft)) {
      revision += 1;
      at = savedAt(d.now());
      stored._present_draft = { revision, saved_at: at, settings };
    }
    await writeSettings(d, store, tx, report, state.config, stored, fallbackTitle, true);
    return { ...state, published, settings, revision, savedAt: at };
  });
}

// ── results a presentation adopts ───────────────────────────────────

/** The newest results each block could show: a saved run, the deck view, the map view. */
export async function availableBindings(
  d: PopcornDeps,
  map: MapStore,
  report: Row,
  projectId: string,
): Promise<Record<string, string>> {
  const versions = await listVersions(d.store, String(report.id), 1);
  const first = versions[0];
  const bindings: Record<string, string> = first
    ? { stakeholders: first.id, tensions: first.id }
    : {};
  try {
    const deck = (await d.deck.currentDeck(projectId)) ?? (await d.deck.assembleDeck(projectId));
    if (deck) {
      const available = new Set(
        (Array.isArray(deck.manifest.producers) ? deck.manifest.producers : [])
          .map(dict)
          .filter((p) => truthy(p.available))
          .map((p) => pyStr(p.recipeId ?? null)),
      );
      if (available.has("tensions")) bindings.tensions = `analysis:${deck.id}`;
      if (available.has("stakeholders")) bindings.stakeholders = `analysis:${deck.id}`;
    }
    const snapshot = await map.currentSnapshot(projectId);
    if (snapshot) bindings.map = snapshot.id;
  } catch (err) {
    // An unavailable map must not stop a ready popcorn presentation.
    if (!(err instanceof AnalysisStoreError)) throw err;
    d.logger.warn({ err }, "present: analysis bindings unavailable");
  }
  return bindings;
}

export async function adoptResults(
  d: PopcornDeps,
  map: MapStore,
  report: Row,
  projectId: string,
  initialOnly = false,
): Promise<void> {
  // Looking for results reads outside the lock; what is bound now is read inside it, so a
  // binding the host adopted meanwhile is never replaced by an older one.
  const available = await availableBindings(d, map, report, projectId);
  if (!Object.keys(available).length) return;
  await settingsLock(d, String(report.id), async (store, tx) => {
    const manifest = dict((await loadSettingsFor(store, report)).presentation);
    const current = dict(manifest.result_bindings);
    const blocks = Array.isArray(manifest.blocks) ? manifest.blocks : [];
    const updates = Object.fromEntries(
      Object.entries(available).filter(
        ([block, identity]) =>
          blocks.includes(block) &&
          current[block] !== identity &&
          (!initialOnly || !(block in current)),
      ),
    );
    if (Object.keys(updates).length)
      await updateSettingsUnlocked(d, store, tx, report, {
        presentation: { result_bindings: updates },
      });
  });
}

/** The session's conversations, oldest first, with the deck's legend names. */
export async function conversationLegend(
  store: PopcornStore,
  report: Row | null,
): Promise<{ order: string[]; names: Record<string, string> }> {
  if (!report) return { order: [], names: {} };
  const loop = await store.loopForReport(String(report.id));
  const state = normalizeState(loop?.popcorn_state);
  const conversations = dict(state.conversations);
  const order = (state.order as unknown[]).map((c) => pyStr(c));
  const names: Record<string, string> = {};
  for (const cid of order) {
    const label = orStr(dict(conversations[cid]).label).trim();
    if (label) names[cid] = label;
  }
  return { order, names };
}
