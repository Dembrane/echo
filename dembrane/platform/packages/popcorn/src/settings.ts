import { meetsTier } from "@dembrane/access";
import { ConflictError, ForbiddenError } from "@dembrane/core";
import {
  cpSlice,
  dict,
  isRecord,
  type Json,
  list,
  normalizeWs,
  orStr,
  pyStr,
  strip,
  truthy,
  unique,
} from "./py";

/**
 * A session's presentation settings: the JSON on its canvas_config_revision, normalised
 * exactly as the Python service did, because the dashboard, the deck and the saved row all
 * read this shape. Merging, expanding and the tier and synthetic-frame rules live here too.
 */

export const REPORT_KIND = "popcorn";
export const LOOP_KIND = "popcorn";
export const DEFAULT_CADENCE_MINUTES = 2;
export const MIN_CADENCE_MINUTES = 1;
/** How long live can be asked for, in hours. */
export const LIVE_HOURS = [1, 8, 24] as const;
/** Extra languages a phrase may pop in, beside the one the results are translated into. */
export const MAX_ALSO_LANGUAGES = 3;

export const LANGUAGES = ["en", "nl", "de", "fr", "es", "it", "uk", "cs"] as const;
export type Language = (typeof LANGUAGES)[number];
export const isLanguage = (v: unknown): v is Language =>
  typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);

/** Legacy audience tabs mirrored from the selected presentation recipes. */
export const TOGGLEABLE_TABS = ["tensions", "stakeholders"] as const;
/** Presentation recipes in the audience's complexity order; the stored list is selection only. */
export const PRESENTATION_BLOCKS = ["popcorn", "tensions", "map", "stakeholders"] as const;
const isBlock = (v: unknown): v is (typeof PRESENTATION_BLOCKS)[number] =>
  typeof v === "string" && (PRESENTATION_BLOCKS as readonly string[]).includes(v);

/**
 * How the phrases should sound. Each chosen preset adds one host note line to the
 * extractor's user message; the free text is the host's own words.
 */
export const VOICE_PRESETS: Readonly<Record<string, string>> = {
  gentle:
    "Prefer the gentler of two ways the room said a thing. Leave out phrases that name, blame or single out a person.",
  plain:
    "Prefer the plainest wording the room used. Leave out metaphors and jokes the room did not return to.",
  decisions:
    "Favour the ideas that became a decision, a need or a next step over ideas that were only discussed.",
};
const VOICE_NOTE_MAX_CHARS = 600;

export const PARTICIPANT_LANGUAGE_CODES: Readonly<Record<string, string>> = {
  cs: "cs-CZ",
  de: "de-DE",
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  it: "it-IT",
  nl: "nl-NL",
  uk: "uk-UA",
};

/** The screens before the countdown and the bar above every tab, with their length limits. */
export const OPENING_BLOCKS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  intro: { title: 160, subtitle: 600 },
  disclosure: { text: 600, invitation_title: 160, invitation_text: 600 },
  notice: { text: 160 },
  // The data screen has no words of its own: they follow the project.
  data: {},
};
/** The two screens a synthetic demo writes for itself. */
export const FRAME_BLOCKS = ["disclosure", "notice"] as const;

export function normalizeBlock(raw: unknown, limits: Readonly<Record<string, number>>): Json {
  const r = dict(raw);
  const block: Json = { enabled: truthy(r.enabled ?? false) };
  for (const [key, limit] of Object.entries(limits))
    block[key] = cpSlice(strip(orStr(r[key])), limit);
  return block;
}

/**
 * The screen's own language (`auto` follows the project), the language the results are
 * translated into, and the extra languages the phrases pop in after it.
 */
export function normalizeLanguage(raw: unknown): Json {
  const r = dict(raw);
  const ui = orStr(r.ui, "auto");
  let target = orStr(r.translate_to);
  target = isLanguage(target) ? target : "";
  const also = unique(list(r.also)).filter(
    (code): code is Language => isLanguage(code) && code !== target,
  );
  return {
    ui: isLanguage(ui) ? ui : "auto",
    translate_to: target,
    also: also.slice(0, MAX_ALSO_LANGUAGES),
  };
}

/**
 * The language of the screen's own words. Automatic follows the results: their
 * translation when the host asked for one, else the project's language (a demo's own).
 */
export function screenLanguage(settings: Json, demo: Json, project: Json): string {
  const language = normalizeLanguage(settings.language);
  let choice = pyStr(language.ui);
  if (choice === "auto") {
    const spoken = demo.synthetic ? demo.language : project.language;
    choice = orStr(language.translate_to) || (orStr(spoken, "en").split("-")[0] ?? "");
  }
  return isLanguage(choice) ? choice : "en";
}

export function defaultSettings(title: string, client: string | null = null): Json {
  const out: Json = {
    title,
    client: client || "",
    tabs: Object.fromEntries(TOGGLEABLE_TABS.map((t) => [t, true])),
    public: false,
    show_qr: false,
    show_branding: true,
    voice: { presets: [], note: "" },
    public_labels: "neutral",
  };
  for (const [name, limits] of Object.entries(OPENING_BLOCKS))
    out[name] = normalizeBlock(null, limits);
  out.language = normalizeLanguage(null);
  return out;
}

/**
 * The stored manifest as the room must read it. Popcorn absorbs latency, so a
 * presentation always carries it and always opens on it; older settings and patches that
 * say otherwise are normalised rather than refused.
 */
export function normalizePresentation(raw: unknown): Json | null {
  if (!isRecord(raw)) return null;
  const rawBlocks = Array.isArray(raw.blocks) ? raw.blocks : ["popcorn"];
  const selected = new Set<string>(rawBlocks.filter(isBlock));
  selected.add("popcorn");
  const hidden = list(raw.hidden_items);
  const bindings = dict(raw.result_bindings);
  return {
    version: 1,
    blocks: PRESENTATION_BLOCKS.filter((b) => selected.has(b)),
    opening: "popcorn",
    language_policy: raw.language_policy === "project" ? "project" : "explicit",
    hidden_items: unique(hidden.filter((x): x is string => typeof x === "string")).slice(0, 2000),
    result_bindings: Object.fromEntries(
      Object.entries(bindings).filter(([k, v]) => isBlock(k) && typeof v === "string"),
    ),
  };
}

export function resolveProjectLanguage(value: unknown): [string, string | null] {
  const code = (strip(orStr(value)).toLowerCase().replaceAll("_", "-").split("-")[0] ??
    "") as string;
  if (isLanguage(code)) return [code, null];
  return ["en", code === "multi" ? "multilingual" : "not_set"];
}

/** Resolve the saved language policy without changing it or starting processing. */
export function resolvePresentationSettings(settings: Json, project: Json): Json {
  const presentation = settings.presentation;
  if (!truthy(presentation) || dict(presentation).language_policy !== "project") return settings;
  const [language] = resolveProjectLanguage(project.language);
  // The policy owns the results' language; the extra popcorn languages stay the host's.
  const also = normalizeLanguage(settings.language).also;
  return { ...settings, language: { ui: language, translate_to: language, also } };
}

export function normalizeVoice(raw: unknown): Json {
  const r = dict(raw);
  let chosen: unknown[];
  if (Array.isArray(r.presets)) chosen = r.presets;
  else chosen = typeof r.preset === "string" ? [r.preset] : [];
  const presets = Object.keys(VOICE_PRESETS).filter((k) => chosen.includes(k));
  const note = cpSlice(normalizeWs(orStr(r.note)), VOICE_NOTE_MAX_CHARS);
  return { presets, note };
}

/** The text appended to the extractor's user message, or empty for the default voice. */
export function voiceHostNote(voice: unknown): string {
  const v = normalizeVoice(voice);
  const parts = [...(v.presets as string[]).map((k) => VOICE_PRESETS[k] ?? ""), v.note as string];
  return strip(parts.filter(Boolean).join("\n"));
}

export function normalizeSettings(raw: unknown, fallbackTitle: string): Json {
  const r = dict(raw);
  const recipe = dict(r.recipe_settings);
  const tabsRaw = dict(r.tabs);
  const voiceSource = "voice" in recipe ? recipe.voice : r.voice;
  const out: Json = {};
  if (isRecord(r.presentation)) out.presentation = normalizePresentation(r.presentation);
  out.title = cpSlice(strip(orStr(r.title, fallbackTitle)), 160) || fallbackTitle;
  out.client = cpSlice(strip(orStr(r.client)), 160);
  out.tabs = Object.fromEntries(TOGGLEABLE_TABS.map((t) => [t, truthy(tabsRaw[t] ?? true)]));
  out.public = truthy(r.public ?? false);
  out.show_qr = truthy(r.show_qr ?? false);
  // "made with dembrane" on the deck. Off is a Changemaker feature; the API enforces it.
  out.show_branding = truthy(r.show_branding ?? true);
  out.voice = normalizeVoice(voiceSource);
  out.recipe_settings = { voice: normalizeVoice(voiceSource) };
  for (const [name, limits] of Object.entries(OPENING_BLOCKS))
    out[name] = normalizeBlock(r[name], limits);
  out.language = normalizeLanguage(r.language);
  // The legend numbers conversations unless the host chose names; the host page always names them.
  out.public_labels = r.public_labels === "names" ? "names" : "neutral";
  return out;
}

/**
 * The legacy audience tabs follow the chosen blocks, and a language picked by hand stops a
 * presentation following the project's. Without a manifest there is no policy to change.
 */
export function expandSettingsPatch(patch: Json, presentationExists = true): Json {
  const out: Json = { ...patch };
  if ("presentation" in out) {
    const blocks = dict(out.presentation).blocks;
    if (blocks !== undefined && blocks !== null) {
      const chosen = list(blocks);
      out.tabs = Object.fromEntries(TOGGLEABLE_TABS.map((k) => [k, chosen.includes(k)]));
    }
  }
  if ("language" in out && !("presentation" in out) && presentationExists)
    out.presentation = { language_policy: "explicit" };
  return out;
}

export function requireBrandingTier(tier: string, removesBranding: boolean): void {
  if (removesBranding && !meetsTier(tier, "changemaker"))
    throw new ForbiddenError("Removing the dembrane mark requires the changemaker tier.");
}

export const SYNTHETIC_FRAME_LOCKED =
  "A synthetic demo's disclosure and frame are set with the demo.";
export const syntheticFrameLocked = () => new ConflictError(SYNTHETIC_FRAME_LOCKED);

/** Apply the shared partial-settings semantics and normalise the result. */
export function mergeSettings(current: Json, patch: Json, fallbackTitle: string): Json {
  const merged: Json = { ...current };
  for (const key of ["title", "client", "public", "show_qr", "show_branding", "public_labels"])
    if (key in patch && patch[key] !== null && patch[key] !== undefined) merged[key] = patch[key];
  for (const key of ["voice", "language", ...Object.keys(OPENING_BLOCKS)])
    if (isRecord(patch[key])) merged[key] = { ...dict(current[key]), ...(patch[key] as Json) };
  if (isRecord(patch.voice)) merged.recipe_settings = { voice: merged.voice };
  if (isRecord(patch.presentation)) {
    const manifest = dict(current.presentation);
    merged.presentation = { ...manifest, ...patch.presentation };
    // A bindings patch names the blocks it adopts and leaves the rest.
    if (isRecord(patch.presentation.result_bindings))
      (merged.presentation as Json).result_bindings = {
        ...dict(manifest.result_bindings),
        ...patch.presentation.result_bindings,
      };
  }
  if (isRecord(patch.tabs)) {
    const tabs: Json = { ...dict(current.tabs) };
    for (const [k, v] of Object.entries(patch.tabs))
      if ((TOGGLEABLE_TABS as readonly string[]).includes(k)) tabs[k] = truthy(v);
    merged.tabs = tabs;
  }
  return normalizeSettings(merged, fallbackTitle);
}

/** Every language the results are translated into, the whole deck's first. */
export function targetLanguages(settings: Json): string[] {
  const primary = orStr(dict(settings.language).translate_to);
  if (!primary) return [];
  const extra = list(dict(settings.language).also).filter(
    (code): code is string => isLanguage(code) && code !== primary,
  );
  return [primary, ...unique(extra)];
}

/** The language the results are translated into once the policy is resolved. */
export function translationTargets(settings: Json, project: Json): string[] {
  return targetLanguages(resolvePresentationSettings(settings, project));
}

/** What the room's presentation shows, in order, and where it opens. */
export function audienceManifest(settings: Json): Json {
  const raw = truthy(settings.presentation)
    ? settings.presentation
    : {
        blocks: [
          "popcorn",
          ...Object.entries(dict(settings.tabs))
            .filter(([, v]) => truthy(v))
            .map(([k]) => k),
        ],
      };
  const manifest = normalizePresentation(raw) as Json;
  return { version: manifest.version, blocks: manifest.blocks, opening: manifest.opening };
}
