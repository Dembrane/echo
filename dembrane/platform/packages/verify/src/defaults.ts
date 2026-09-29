import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, eq, isNull, sql } from "drizzle-orm";

const { languages, verification_topic, verification_topic_translations: translations } = schema;

/** The languages topic translations point at, as the Python stack seeded them. */
export const DEFAULT_LANGUAGES = [
  { code: "en-US", name: "English (United States)", direction: "ltr" },
  { code: "nl-NL", name: "Dutch (Netherlands)", direction: "ltr" },
  { code: "de-DE", name: "German (Germany)", direction: "ltr" },
  { code: "es-ES", name: "Spanish (Spain)", direction: "ltr" },
  { code: "fr-FR", name: "French (France)", direction: "ltr" },
  { code: "it-IT", name: "Italian (Italy)", direction: "ltr" },
  { code: "uk-UA", name: "Ukrainian (Ukraine)", direction: "ltr" },
  { code: "cs-CZ", name: "Czech (Czech Republic)", direction: "ltr" },
] as const;

interface DefaultTopic {
  readonly key: string;
  readonly icon: string;
  readonly sort: number;
  readonly prompt: string;
  readonly labels: Readonly<Record<(typeof DEFAULT_LANGUAGES)[number]["code"], string>>;
}

/** The global topics every project offers, copied from server/dembrane/seed.py. */
export const DEFAULT_TOPICS: readonly DefaultTopic[] = [
  {
    key: "agreements",
    icon: ":white_check_mark:",
    sort: 1,
    prompt:
      "Extract the concrete agreements and shared understandings from this conversation. " +
      "Focus on points where multiple participants explicitly or implicitly aligned. " +
      "Include both major decisions and small points of consensus. Present these as clear, " +
      "unambiguous statements that all participants would recognize as accurate. Distinguish " +
      "between firm agreements and tentative consensus. If participants used different words " +
      "to express the same idea, synthesize into shared language. Format as a living document " +
      "of mutual understanding. Output character should be diplomatic but precise, like meeting " +
      "minutes with soul.",
    labels: {
      "en-US": "What we actually agreed on",
      "nl-NL": "Waar we het over eens werden",
      "de-DE": "Worauf wir uns wirklich geeinigt haben",
      "es-ES": "En qué estuvimos de acuerdo",
      "fr-FR": "Ce qu'on a décidé ensemble",
      "it-IT": "Su cosa ci siamo accordati",
      "uk-UA": "Про що ми домовились",
      "cs-CZ": "Na čem jsme se shodli",
    },
  },
  {
    key: "gems",
    icon: ":mag:",
    sort: 2,
    prompt:
      "Identify the valuable insights that emerged unexpectedly or were mentioned briefly but " +
      "contain significant potential. Look for: throwaway comments that solve problems, questions " +
      "that reframe the entire discussion, metaphors that clarify complex ideas, connections between " +
      "seemingly unrelated points, and wisdom hiding in personal anecdotes. Present these as discoveries " +
      "worth preserving, explaining why each gem matters. These are the insights people might forget but " +
      "shouldn't. Output character should be excited and precise.",
    labels: {
      "en-US": "Hidden gems",
      "nl-NL": "Verborgen parels",
      "de-DE": "Verborgene Schätze",
      "es-ES": "Joyas ocultas",
      "fr-FR": "Pépites cachées",
      "it-IT": "Perle nascoste",
      "uk-UA": "Приховані перлини",
      "cs-CZ": "Skryté klenoty",
    },
  },
  {
    key: "truths",
    icon: ":eyes:",
    sort: 3,
    prompt:
      "Surface the uncomfortable realities acknowledged in this conversation - the elephants in the room that " +
      "got named, the difficult facts accepted, the challenging feedback given or received. Include systemic " +
      "problems identified, personal blind spots revealed, and market realities confronted. Present these with " +
      "compassion but without sugar-coating. Frame them as shared recognitions that took courage to voice. " +
      "These truths are painful but necessary for genuine progress. Output character should be gentle but " +
      "unflinching.",
    labels: {
      "en-US": "Painful truths",
      "nl-NL": "Pijnlijke waarheden",
      "de-DE": "Unbequeme Wahrheiten",
      "es-ES": "Verdades incómodas",
      "fr-FR": "Vérités difficiles",
      "it-IT": "Verità scomode",
      "uk-UA": "Болючі істини",
      "cs-CZ": "Bolestivé pravdy",
    },
  },
  {
    key: "moments",
    icon: ":rocket:",
    sort: 4,
    prompt:
      "Capture the moments when thinking shifted, new possibilities emerged, or collective understanding jumped " +
      "to a new level. Identify: sudden realizations, creative solutions, perspective shifts, moments when " +
      "complexity became simple, and ideas that energized the group. Show both the breakthrough itself and what " +
      "made it possible. These are the moments when the conversation transcended its starting point. Output " +
      "character should be energetic and forward-looking.",
    labels: {
      "en-US": "Breakthrough moments",
      "nl-NL": "Doorbraken",
      "de-DE": "Durchbrüche",
      "es-ES": "Momentos decisivos",
      "fr-FR": "Moments décisifs",
      "it-IT": "Momenti di svolta",
      "uk-UA": "Моменти прориву",
      "cs-CZ": "Průlomové okamžiky",
    },
  },
  {
    key: "actions",
    icon: ":arrow_upper_right:",
    sort: 5,
    prompt:
      "Synthesize the group's emerging sense of direction and next steps. Include: explicit recommendations made, " +
      "implicit preferences expressed, priorities that emerged through discussion, and logical next actions even " +
      "if not explicitly stated. Distinguish between unanimous direction and majority leanings. Present as " +
      "provisional navigation rather than fixed commands. This is the group's best current thinking about the " +
      "path forward. Output character should be pragmatic but inspirational.",
    labels: {
      "en-US": "What we think should happen",
      "nl-NL": "Wat we denken dat moet gebeuren",
      "de-DE": "Was wir denken, das passieren sollte",
      "es-ES": "Lo que creemos que debe pasar",
      "fr-FR": "Ce qu'on pense qu'il faut faire",
      "it-IT": "Cosa pensiamo debba succedere",
      "uk-UA": "Що, на нашу думку, має статися",
      "cs-CZ": "Co by se podle nás mělo stát",
    },
  },
  {
    key: "disagreements",
    icon: ":warning:",
    sort: 6,
    prompt:
      "Document the points of productive tension where different perspectives remained distinct but respected. " +
      "Include: fundamental differences in approach, varying priorities, different risk tolerances, and contrasting " +
      "interpretations of data. Frame these not as failures to agree but as valuable diversity of thought. Show how " +
      "each perspective has merit. These disagreements are features, not bugs - they prevent premature convergence " +
      "and keep important tensions alive. Output character should be respectful and balanced.",
    labels: {
      "en-US": "Moments we agreed to disagree",
      "nl-NL": "Waar we het oneens bleven",
      "de-DE": "Worüber wir uns nicht einig wurden",
      "es-ES": "Donde no coincidimos",
      "fr-FR": "Là où on n'était pas d'accord",
      "it-IT": "Dove non eravamo d'accordo",
      "uk-UA": "Де ми погодились не погоджуватись",
      "cs-CZ": "Kdy jsme se shodli, že se neshodneme",
    },
  },
];

export interface SeedTopicsResult {
  readonly topicsAdded: number;
  readonly translationsAdded: number;
  readonly translationsUpdated: number;
}

/**
 * Adds any missing default language, global topic and label, and resets a changed label, as
 * the Python API did at startup. An existing topic's prompt, icon and sort are left alone.
 */
export async function seedDefaultTopics(db: Db): Promise<SeedTopicsResult> {
  return db.transaction(async (tx) => {
    // Translations have no unique key, so concurrent runs are serialized instead.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('verify:default_topics', 0))`,
    );
    await tx
      .insert(languages)
      .values(DEFAULT_LANGUAGES.map((l) => ({ ...l })))
      .onConflictDoNothing();
    const now = new Date().toISOString();
    let topicsAdded = 0;
    let translationsAdded = 0;
    let translationsUpdated = 0;
    for (const topic of DEFAULT_TOPICS) {
      const added = await tx
        .insert(verification_topic)
        .values({
          key: topic.key,
          icon: topic.icon,
          sort: topic.sort,
          prompt: topic.prompt,
          date_created: now,
        })
        .onConflictDoNothing()
        .returning({ key: verification_topic.key });
      topicsAdded += added.length;
      // A project's own topic under a default key is not ours to relabel.
      const [global] = await tx
        .select({ key: verification_topic.key })
        .from(verification_topic)
        .where(and(eq(verification_topic.key, topic.key), isNull(verification_topic.project_id)));
      if (!global) continue;
      const existing = await tx
        .select()
        .from(translations)
        .where(eq(translations.verification_topic_key, topic.key));
      for (const [code, label] of Object.entries(topic.labels)) {
        const row = existing.find((t) => t.languages_code === code);
        if (!row) {
          await tx
            .insert(translations)
            .values({ verification_topic_key: topic.key, languages_code: code, label });
          translationsAdded++;
        } else if (row.label !== label) {
          await tx.update(translations).set({ label }).where(eq(translations.id, row.id));
          translationsUpdated++;
        }
      }
    }
    return { topicsAdded, translationsAdded, translationsUpdated };
  });
}
