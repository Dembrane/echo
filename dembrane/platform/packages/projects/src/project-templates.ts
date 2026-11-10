import { newId, ValidationError } from "@dembrane/core";
import type { schema } from "@dembrane/db";
import { z } from "zod";
import type { PROJECT_UPDATE_FIELDS } from "./projects";
import type { ProjectsStorage } from "./storage";

/**
 * Project templates: what a new project starts with when the host says what it is for.
 * Data only, plus one apply function. Names and descriptions live in the frontend's
 * catalogs, keyed by `key`; the server holds only settings. The few strings here are what
 * participants read in the portal (a field label and tag names), in the project's language.
 *
 * Every preset comes from how dembrane is used (projects with portal activity, autumn 2026):
 * a single session is 1 or 2 conversations on one device; a series 3 to 10, with chat; a
 * live event 11 or more on many phones, where "session name" reads as a person's name and
 * Verify and Explore only help when they are on and set up; uploads skip the portal.
 *
 * Never preset: anonymize_transcripts (it removes the audio for good), legal_basis and
 * privacy_policy_url (an admin's call with their data protection officer), and
 * is_dembrane_event_cta_enabled (switching it off is paid; the default stays).
 */

/** The project languages the portal, transcription and summaries support. */
export const TEMPLATE_LANGUAGES = ["en", "nl", "de", "fr", "es", "it", "uk", "cs"] as const;
type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];

/** Participant-facing text in every project language; English is the fallback. */
const Localized = z.object(
  Object.fromEntries(TEMPLATE_LANGUAGES.map((l) => [l, z.string().min(1).max(255)])) as Record<
    TemplateLanguage,
    z.ZodString
  >,
);
export type Localized = z.infer<typeof Localized>;

/** The tutorial slugs the portal knows; "None" is what the create wizard always wrote. */
const TUTORIAL = z.enum(["None", "basic", "advanced"]);

/** Built-in verification topic keys (packages/verify/src/defaults.ts). */
export const BUILT_IN_TOPICS = [
  "agreements",
  "gems",
  "truths",
  "moments",
  "actions",
  "disagreements",
] as const;

/**
 * The project fields a preset may set: a strict subset of PROJECT_UPDATE_FIELDS (the
 * type below fails to compile otherwise). Anything else in a preset is a parse error.
 */
const PresetFields = z
  .object({
    is_conversation_allowed: z.boolean(),
    default_conversation_ask_for_participant_name: z.boolean(),
    default_conversation_ask_for_participant_email: z.boolean(),
    default_conversation_tutorial_slug: TUTORIAL,
    image_generation_model: z.enum(["MODEST"]),
    is_verify_enabled: z.boolean(),
    is_verify_on_finish_enabled: z.boolean(),
    is_get_reply_enabled: z.boolean(),
    get_reply_mode: z.enum(["summarize"]),
    enable_ai_title_and_tags: z.boolean(),
  })
  .partial()
  .strict();
type PresetField = keyof z.infer<typeof PresetFields>;
// Compile-time: every preset field is one the project PATCH accepts.
const _fieldsAreUpdatable: readonly (typeof PROJECT_UPDATE_FIELDS)[number][] = [] as PresetField[];
void _fieldsAreUpdatable;

const Preset = z
  .object({
    fields: PresetFields,
    /**
     * conversation_ask_for_participant_name_label: the portal shows it in place of
     * "Session name". Not in PROJECT_UPDATE_FIELDS, so only a template sets it.
     */
    name_label: Localized.optional(),
    /** Portal tags, in order. */
    tags: z.array(Localized).max(12).default([]),
    /** Verify topics participants choose from; empty means every topic, as today. */
    verification_topics: z.array(z.enum(BUILT_IN_TOPICS)).default([]),
    /** Where the host lands after creating. */
    landing: z.enum(["home", "upload"]).default("home"),
  })
  .strict();

const Template = z
  .object({
    key: z.enum(["conversation", "series", "event", "upload", "blank"]),
    version: z.number().int().positive(),
    preset: Preset,
  })
  .strict();
export type ProjectTemplate = z.infer<typeof Template>;
export type ProjectTemplateKey = ProjectTemplate["key"];

/** What the create wizard wrote on every project before templates: `blank` is exactly this. */
const WIZARD_DEFAULTS = {
  is_conversation_allowed: true,
  default_conversation_ask_for_participant_name: true,
  default_conversation_tutorial_slug: "None",
  image_generation_model: "MODEST",
} as const;

const ROUND = (n: number): Localized => ({
  en: `Round ${n}`,
  nl: `Ronde ${n}`,
  de: `Runde ${n}`,
  fr: `Tour ${n}`,
  es: `Ronda ${n}`,
  it: `Turno ${n}`,
  uk: `Раунд ${n}`,
  cs: `Kolo ${n}`,
});

const TABLE_OR_GROUP: Localized = {
  en: "Table or group name",
  nl: "Naam van je tafel of groep",
  de: "Name des Tisches oder der Gruppe",
  fr: "Nom de la table ou du groupe",
  es: "Nombre de la mesa o del grupo",
  it: "Nome del tavolo o del gruppo",
  uk: "Назва столу або групи",
  cs: "Název stolu nebo skupiny",
};

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  // One interview or meeting on one device, about 45 minutes: nothing to fill in before
  // recording, and a title for each conversation instead of a typed name.
  {
    key: "conversation",
    version: 1,
    preset: {
      fields: {
        ...WIZARD_DEFAULTS,
        default_conversation_ask_for_participant_name: false,
        enable_ai_title_and_tags: true,
      },
      tags: [],
      verification_topics: [],
      landing: "home",
    },
  },
  // Recurring meetings or a working group, 3 to 10 conversations: the name box tells the
  // sessions apart ("Meeting 3"), titles say what each was about.
  {
    key: "series",
    version: 1,
    preset: {
      fields: { ...WIZARD_DEFAULTS, enable_ai_title_and_tags: true },
      tags: [],
      verification_topics: [],
      landing: "home",
    },
  },
  // Many tables at once, 16 to 29 minutes each on many phones. The name box asks for the
  // table or group; tags are the rounds, tapped at the start; the advanced tutorial says
  // "Don't lock your device!" so the host doesn't have to; Verify (reminded on finish)
  // with three topics a table can sign off in five minutes; Explore for a stuck table.
  // Automatic titles stay off: they would also pick round tags on their own.
  {
    key: "event",
    version: 1,
    preset: {
      fields: {
        ...WIZARD_DEFAULTS,
        default_conversation_tutorial_slug: "advanced",
        is_verify_enabled: true,
        is_verify_on_finish_enabled: true,
        is_get_reply_enabled: true,
        get_reply_mode: "summarize",
      },
      name_label: TABLE_OR_GROUP,
      tags: [ROUND(1), ROUND(2)],
      verification_topics: ["agreements", "actions", "disagreements"],
      landing: "home",
    },
  },
  // Existing recordings: the portal stays open for a later session, the host lands on
  // upload, and each file gets a title.
  {
    key: "upload",
    version: 1,
    preset: {
      fields: { ...WIZARD_DEFAULTS, enable_ai_title_and_tags: true },
      tags: [],
      verification_topics: [],
      landing: "upload",
    },
  },
  {
    key: "blank",
    version: 1,
    preset: { fields: { ...WIZARD_DEFAULTS }, tags: [], verification_topics: [], landing: "home" },
  },
].map((t) => Template.parse(t));

export const PROJECT_TEMPLATE_KEYS = PROJECT_TEMPLATES.map((t) => t.key);

/** The template for a key, or a 422 `project.template_unknown`. */
export function projectTemplate(key: string): ProjectTemplate {
  const found = PROJECT_TEMPLATES.find((t) => t.key === key);
  if (!found)
    throw new ValidationError("project.template_unknown", {
      params: { template_key: key, known: PROJECT_TEMPLATE_KEYS.join(", ") },
    });
  return found;
}

const pick = (text: Localized, language: string | null | undefined): string => {
  const code = (language ?? "").toLowerCase().slice(0, 2);
  return (TEMPLATE_LANGUAGES as readonly string[]).includes(code)
    ? text[code as TemplateLanguage]
    : text.en;
};

type ProjectColumns = Partial<typeof schema.project.$inferInsert>;

/** The project columns a template writes, in the project's language. */
export function templateColumns(
  t: ProjectTemplate,
  language: string | null | undefined,
): ProjectColumns {
  const { fields, name_label, verification_topics } = t.preset;
  const set = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined),
  ) as ProjectColumns;
  return {
    ...set,
    ...(name_label && { conversation_ask_for_participant_name_label: pick(name_label, language) }),
    ...(verification_topics.length && {
      selected_verification_key_list: verification_topics.join(","),
    }),
    template_key: t.key,
    template_version: t.version,
  };
}

/** The tag texts a template seeds, in order, in the project's language. */
export function templateTags(t: ProjectTemplate, language: string | null | undefined): string[] {
  return t.preset.tags.map((tag) => pick(tag, language));
}

/**
 * Applies a template to a project just inserted, through the same storage the clone writes
 * with. Takes a store already inside the creating transaction, so a project never exists
 * without its preset.
 */
export async function applyProjectTemplate(
  store: ProjectsStorage,
  c: { projectId: string; template: ProjectTemplate; language: string | null; now: string },
) {
  await store.updateProject(c.projectId, {
    ...templateColumns(c.template, c.language),
    updated_at: c.now,
  });
  await store.insertTags(
    templateTags(c.template, c.language).map((text, i) => ({
      id: newId(),
      project_id: c.projectId,
      text,
      sort: i + 1,
      created_at: c.now,
    })),
  );
}

/**
 * What a template sets up, as data for the cards ("what this sets up"), so the wording
 * stays in the frontend and the facts stay with the preset.
 */
export function templateSummary(t: ProjectTemplate) {
  const f = t.preset.fields;
  const tutorial = (f.default_conversation_tutorial_slug ?? "None").toLowerCase();
  return {
    key: t.key,
    version: t.version,
    landing: t.preset.landing,
    summary: {
      asks_for_name: f.default_conversation_ask_for_participant_name ?? true,
      asks_for_group_name: Boolean(t.preset.name_label),
      tutorial: tutorial as "none" | "basic" | "advanced",
      verify: f.is_verify_enabled ?? false,
      verify_on_finish: f.is_verify_on_finish_enabled ?? false,
      verification_topics: t.preset.verification_topics,
      explore: f.is_get_reply_enabled ?? false,
      auto_titles: f.enable_ai_title_and_tags ?? false,
      tag_count: t.preset.tags.length,
    },
  };
}

export function listProjectTemplates() {
  return { templates: PROJECT_TEMPLATES.map(templateSummary) };
}
