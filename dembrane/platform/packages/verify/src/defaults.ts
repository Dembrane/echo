import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { PREVIOUS_TOPICS } from "./previous-defaults";

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
  /** The instruction in English: what the database holds and every other language reads. */
  readonly prompt: string;
  /** The approved Dutch instruction, used when the project's language is Dutch. */
  readonly promptNl: string;
  readonly labels: Readonly<Record<(typeof DEFAULT_LANGUAGES)[number]["code"], string>>;
}

/**
 * The global topics every project offers (ECHO-1052), in the order hosts see them. Short,
 * checkable drafts a table can read aloud and correct: the shared rules (length, "one
 * person" versus "the group", first and last line) live in generate_artifact. The keys
 * are the ones the Python stack seeded, so stored selections keep working; `heard` is new.
 * Labels other than English and Dutch are model-translated.
 */
export const DEFAULT_TOPICS: readonly DefaultTopic[] = [
  {
    key: "agreements",
    icon: ":white_check_mark:",
    sort: 1,
    prompt:
      "List 3 to 5 points this group mostly agreed on, one sentence each, at most 20 words. " +
      "Then 'Also heard:' 1 or 2 views that differed. If none, write 'Nobody clearly disagreed. Is that right?'",
    promptNl:
      "Noem 3 tot 5 punten waar deze groep het grotendeels over eens was, elk één zin van hooguit 20 woorden. " +
      "Daarna 'Ook gehoord:' 1 of 2 afwijkende standpunten. Zo niet: 'Niemand week duidelijk af. Klopt dat?'",
    labels: {
      "en-US": "Table check",
      "nl-NL": "Tafelcheck",
      "de-DE": "Tischcheck",
      "es-ES": "Repaso de la mesa",
      "fr-FR": "Point de la table",
      "it-IT": "Verifica del tavolo",
      "uk-UA": "Перевірка за столом",
      "cs-CZ": "Kontrola u stolu",
    },
  },
  {
    key: "disagreements",
    icon: ":warning:",
    sort: 2,
    prompt:
      "List up to 3 points where views stayed different. For each, give each side in one neutral sentence, " +
      "without saying who is right.",
    promptNl:
      "Noem hooguit 3 punten waar de meningen verschillend bleven. Geef per punt elke kant in één neutrale zin, " +
      "zonder te zeggen wie gelijk heeft.",
    labels: {
      "en-US": "Differences",
      "nl-NL": "Verschillen",
      "de-DE": "Unterschiede",
      "es-ES": "Diferencias",
      "fr-FR": "Différences",
      "it-IT": "Differenze",
      "uk-UA": "Розбіжності",
      "cs-CZ": "Rozdíly",
    },
  },
  {
    key: "actions",
    icon: ":arrow_upper_right:",
    sort: 3,
    prompt:
      "List up to 5 actions or proposals that were said out loud, with who or what was named, if anyone. " +
      "Mark each 'agreed' or 'suggested by some'. Do not add actions nobody said.",
    promptNl:
      "Noem hooguit 5 acties of voorstellen die hardop zijn genoemd, met wie of wat erbij genoemd werd. " +
      "Markeer elk als 'afgesproken' of 'voorgesteld door sommigen'. Voeg geen acties toe die niemand noemde.",
    labels: {
      "en-US": "Decisions and actions",
      "nl-NL": "Besluiten en acties",
      "de-DE": "Entscheidungen und Aufgaben",
      "es-ES": "Decisiones y acciones",
      "fr-FR": "Décisions et actions",
      "it-IT": "Decisioni e azioni",
      "uk-UA": "Рішення та дії",
      "cs-CZ": "Rozhodnutí a úkoly",
    },
  },
  {
    key: "gems",
    icon: ":mag:",
    sort: 4,
    prompt:
      "List up to 3 ideas or stories that were mentioned only briefly but could matter, each in one sentence " +
      "using the speaker's own words where possible.",
    promptNl:
      "Noem hooguit 3 ideeën of verhalen die maar kort genoemd werden maar ertoe kunnen doen, elk in één zin, " +
      "zo veel mogelijk in de eigen woorden van de spreker.",
    labels: {
      "en-US": "Ideas worth keeping",
      "nl-NL": "Ideeën om te bewaren",
      "de-DE": "Ideen, die bleiben sollten",
      "es-ES": "Ideas para guardar",
      "fr-FR": "Idées à garder",
      "it-IT": "Idee da conservare",
      "uk-UA": "Ідеї, які варто зберегти",
      "cs-CZ": "Nápady, které stojí za to uchovat",
    },
  },
  {
    key: "truths",
    icon: ":eyes:",
    sort: 5,
    prompt:
      "List up to 3 difficult points the group named itself: problems, risks or doubts. Use their wording. " +
      "Do not judge people.",
    promptNl:
      "Noem hooguit 3 lastige punten die de groep zelf benoemde: problemen, risico's of twijfels. " +
      "Gebruik hun woorden. Oordeel niet over mensen.",
    labels: {
      "en-US": "Hard points",
      "nl-NL": "Lastige punten",
      "de-DE": "Schwierige Punkte",
      "es-ES": "Puntos difíciles",
      "fr-FR": "Points difficiles",
      "it-IT": "Punti difficili",
      "uk-UA": "Складні моменти",
      "cs-CZ": "Obtížné body",
    },
  },
  {
    key: "heard",
    icon: ":ear:",
    sort: 6,
    prompt:
      "Give back what this person or group told us in up to 5 short points, in their own words where possible, " +
      "in the order they said it. No interpretation.",
    promptNl:
      "Geef in hooguit 5 korte punten terug wat deze persoon of groep ons vertelde, zo veel mogelijk in hun " +
      "eigen woorden en in de volgorde waarin het gezegd is. Geen interpretatie.",
    labels: {
      "en-US": "What we heard",
      "nl-NL": "Wat we hoorden",
      "de-DE": "Was wir gehört haben",
      "es-ES": "Lo que escuchamos",
      "fr-FR": "Ce que nous avons entendu",
      "it-IT": "Cosa abbiamo sentito",
      "uk-UA": "Що ми почули",
      "cs-CZ": "Co jsme slyšeli",
    },
  },
  {
    key: "moments",
    icon: ":rocket:",
    sort: 7,
    prompt: "Name up to 2 moments where the group's view changed, saying what changed it.",
    promptNl:
      "Noem hooguit 2 momenten waarop het beeld van de groep veranderde en wat dat veroorzaakte.",
    labels: {
      "en-US": "Turning points",
      "nl-NL": "Kantelpunten",
      "de-DE": "Wendepunkte",
      "es-ES": "Puntos de inflexión",
      "fr-FR": "Tournants",
      "it-IT": "Punti di svolta",
      "uk-UA": "Поворотні моменти",
      "cs-CZ": "Zlomové okamžiky",
    },
  },
];

/** The key a project falls back to when it selected nothing: one topic, so no picker. */
export const DEFAULT_TOPIC_KEY = "agreements";

/**
 * The instruction for a global topic in the project's language: the approved Dutch text
 * for a Dutch project, otherwise the stored text. A topic someone edited in the database
 * (its prompt is no longer the shipped English one) keeps its own text in every language.
 */
export function defaultTopicPrompt(
  key: string,
  stored: string | null,
  language: string | null | undefined,
): string | null {
  const topic = DEFAULT_TOPICS.find((t) => t.key === key);
  if (!topic || stored !== topic.prompt) return stored;
  return (language ?? "").toLowerCase().startsWith("nl") ? topic.promptNl : topic.prompt;
}

export interface SeedTopicsResult {
  readonly topicsAdded: number;
  /** Global topics still on the pre-ECHO-1052 text, moved to the new prompt, sort and icon. */
  readonly topicsUpdated: number;
  readonly translationsAdded: number;
  readonly translationsUpdated: number;
}

/**
 * Adds any missing default language, global topic and label, and resets a changed label, as
 * the Python API did at startup. A global topic still holding the text the Python stack
 * seeded moves to the current prompt, sort and icon; one someone edited is left alone.
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
    let topicsUpdated = 0;
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
      const previous = PREVIOUS_TOPICS.find((t) => t.key === topic.key);
      if (previous) {
        const moved = await tx
          .update(verification_topic)
          .set({ prompt: topic.prompt, icon: topic.icon, sort: topic.sort, date_updated: now })
          .where(
            and(
              eq(verification_topic.key, topic.key),
              isNull(verification_topic.project_id),
              eq(verification_topic.prompt, previous.prompt),
            ),
          )
          .returning({ key: verification_topic.key });
        topicsUpdated += moved.length;
      }
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
    return { topicsAdded, topicsUpdated, translationsAdded, translationsUpdated };
  });
}
