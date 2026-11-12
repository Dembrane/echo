import { newId, ValidationError } from "@dembrane/core";
import type { schema } from "@dembrane/db";
import { resolveLocale } from "@dembrane/i18n";
import { z } from "zod";
import { invalidBodyField } from "./body-issues";
import type { PROJECT_UPDATE_FIELDS } from "./projects";
import type { ProjectsStorage } from "./storage";

/**
 * Project templates: what a new project starts with when the host says what it is for.
 * Data only, plus the functions that apply and describe it. Names, "great for" lines and
 * the card wording live in the frontend's catalogs, keyed by `key`; the server holds the
 * settings, the card metadata the picker filters on, and what participants and table hosts
 * read (the name box label, tags and the host guide), in the project's language.
 *
 * Registry v2 (ECHO-1053): templates by purpose. The evidence they come from: customer
 * calls (resident evenings with 4 to 20 tables, strategy days of 20 to 175 people, working
 * groups that need minutes, interviews and kitchen-table visits, World Café and Open Space
 * events, assemblies), how projects are used (a single session 243, a series 205, upload
 * 145, a live event on many phones 110; Dutch 53%, English 43%), and what goes wrong in the
 * room: hosts skip Verify under time pressure (the reminder was skipped 237 times, used
 * 169), a loud participant takes over, people press Stop before verifying, "session name"
 * reads as a person's name, and tags used for topics get messy (they are rounds here).
 *
 * Group sessions verify with one topic where time is short (one topic starts at once, no
 * picker), the table check ("agreements") by default; two topics only where the purpose
 * needs both. Cross-pollination is on only where hearing other groups is the point.
 *
 * Never preset: anonymize_transcripts (it removes the audio for good), legal_basis and
 * privacy_policy_url (an admin's call with their data protection officer), asking for the
 * participant's email (ECHO-1052), and is_dembrane_event_cta_enabled (switching it off is
 * paid; the default stays).
 *
 * Host guide texts in English and Dutch are written by hand; German, French, Spanish,
 * Italian, Ukrainian and Czech are model-translated and wait for review; every language
 * addresses the host informally. With Verify and Explore both on, the portal's one button
 * is "ECHO" and opens the choice, so those scripts say "press ECHO, then Verify". Button names in
 * them are the portal's own labels in that language (Italian, Ukrainian and Czech keep the
 * English ones, as the portal does).
 */

/** The project languages the portal, transcription and summaries support: i18n's LOCALES, by language. */
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
  "heard",
] as const;

/** Explore modes the reply prompt knows (conversations/src/v1/reply.ts). */
export const EXPLORE_MODES = ["summarize", "brainstorm", "custom"] as const;

/** The longest name box label: one short line on a phone. The PATCH holds it to the same. */
export const NAME_LABEL_MAX = 80;

/**
 * The project fields a preset may set: a strict subset of PROJECT_UPDATE_FIELDS (the
 * type below fails to compile otherwise). Anything else in a preset is a parse error.
 * The create request's overrides (accepted setup suggestions, ECHO-1043) are held to the
 * same fields. Asking for the participant's email is left out on purpose (ECHO-1052): it
 * sits behind ENABLE_PARTICIPANT_EMAIL, and neither a template nor an override may switch
 * it on. The name box label is not here: it is localised, so it is `name_label` below.
 */
export const PresetFields = z
  .object({
    is_conversation_allowed: z.boolean(),
    default_conversation_ask_for_participant_name: z.boolean(),
    default_conversation_tutorial_slug: TUTORIAL,
    image_generation_model: z.enum(["MODEST"]),
    is_verify_enabled: z.boolean(),
    is_verify_on_finish_enabled: z.boolean(),
    is_get_reply_enabled: z.boolean(),
    is_get_reply_cross_pollination_enabled: z.boolean(),
    get_reply_mode: z.enum(EXPLORE_MODES),
    /** Only with get_reply_mode "custom"; the wrapper around it stays (ECHO-1052). */
    get_reply_prompt: z.string().min(1).max(4000),
    enable_ai_title_and_tags: z.boolean(),
  })
  .partial()
  .strict();
export type PresetField = keyof z.infer<typeof PresetFields>;
/** Settings a host accepted on top of a template's preset (ECHO-1043): any preset field. */
export type PresetOverrides = z.infer<typeof PresetFields>;
export const PRESET_FIELD_NAMES = Object.keys(PresetFields.shape) as PresetField[];
// Compile-time: every preset field is one the project PATCH accepts.
const _fieldsAreUpdatable: readonly (typeof PROJECT_UPDATE_FIELDS)[number][] = [] as PresetField[];
void _fieldsAreUpdatable;

/**
 * A host guide as a template writes it: what a table host reads from a phone. The project
 * stores it in the shape the host guide page edits (frontend HostGuidePage).
 */
const GuideDef = z
  .object({
    title: Localized,
    steps: z.array(Localized).min(3).max(6),
    tips: z.array(Localized).min(1).max(3),
  })
  .strict();

const Preset = z
  .object({
    fields: PresetFields,
    /** conversation_ask_for_participant_name_label: shown in place of "Session name". */
    name_label: Localized.optional(),
    /** Portal tags, in order. */
    tags: z.array(Localized).max(12).default([]),
    /** Verify topics participants choose from; empty means the table check alone (ECHO-1052). */
    verification_topics: z.array(z.enum(BUILT_IN_TOPICS)).default([]),
    /** Where the host lands after creating. */
    landing: z.enum(["home", "upload"]).default("home"),
    /** The host script the project's host guide starts with. */
    host_guide: GuideDef.optional(),
  })
  .strict();

/** The five verbs of dembrane's use-cases page, which the picker filters by. */
export const TEMPLATE_VERBS = ["gather", "understand", "explore", "align", "decide"] as const;
/** How it is recorded: one phone or file, or many groups at once on many phones. */
export const TEMPLATE_SETUPS = ["one_recording", "many_groups"] as const;
/** The use-cases page's sectors. Metadata only; the picker does not filter on them yet. */
export const TEMPLATE_SECTORS = ["public", "networks_events", "consulting", "internal"] as const;

/**
 * How the picker offers a template: a card, a quiet link under the cards (upload, blank),
 * or not at all (the first, logistic templates: valid for the API and for projects made
 * with them, no longer offered).
 */
const Card = z
  .object({
    offer: z.enum(["card", "link", "none"]),
    verbs: z.array(z.enum(TEMPLATE_VERBS)).max(2).default([]),
    setup: z.enum(TEMPLATE_SETUPS),
    sectors: z.array(z.enum(TEMPLATE_SECTORS)).default([]),
    /** In the picker's first view, the short "most used" set. */
    featured: z.boolean().default(false),
    /** A well-known format the card follows, by name only (no text taken from its source). */
    method: z.string().min(1).max(40).optional(),
  })
  .strict();

export const TEMPLATE_KEYS = [
  // v2: by purpose.
  "resident_evening",
  "round_table",
  "focus_group",
  "interviews",
  "kitchen_table",
  "strategy_day",
  "working_group",
  "retrospective",
  "ideation",
  "futures",
  "world_cafe",
  "open_space",
  "one_two_four_all",
  "conversation_cafe",
  "citizens_assembly",
  "conference",
  // v1: by logistics. Still valid, not offered as cards.
  "conversation",
  "series",
  "event",
  "upload",
  "blank",
] as const;

const Template = z
  .object({
    key: z.enum(TEMPLATE_KEYS),
    version: z.number().int().positive(),
    card: Card,
    preset: Preset,
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.card.offer === "card") {
      if (!t.card.verbs.length)
        ctx.addIssue({ code: "custom", message: `${t.key}: a card needs a verb` });
      if (!t.preset.host_guide)
        ctx.addIssue({ code: "custom", message: `${t.key}: a card needs a host guide` });
    }
    const f = t.preset.fields;
    if ((f.get_reply_mode === "custom") !== (f.get_reply_prompt !== undefined))
      ctx.addIssue({ code: "custom", message: `${t.key}: a custom Explore mode needs its prompt` });
    if (f.is_get_reply_cross_pollination_enabled && !f.is_get_reply_enabled)
      ctx.addIssue({ code: "custom", message: `${t.key}: cross-pollination needs Explore` });
    if (f.is_verify_on_finish_enabled && !f.is_verify_enabled)
      ctx.addIssue({ code: "custom", message: `${t.key}: the reminder needs Verify` });
    if (t.preset.verification_topics.length && !f.is_verify_enabled)
      ctx.addIssue({ code: "custom", message: `${t.key}: topics need Verify` });
  });
export type ProjectTemplate = z.infer<typeof Template>;
export type ProjectTemplateKey = ProjectTemplate["key"];

/** What the create wizard wrote on every project before templates: `blank` is exactly this. */
const WIZARD_DEFAULTS = {
  is_conversation_allowed: true,
  default_conversation_ask_for_participant_name: true,
  default_conversation_tutorial_slug: "None",
  image_generation_model: "MODEST",
} as const;

const L = (
  en: string,
  nl: string,
  de: string,
  fr: string,
  es: string,
  it: string,
  uk: string,
  cs: string,
): Localized => ({ en, nl, de, fr, es, it, uk, cs });

// ── Participant-facing words ──────────────────────────────────────────

const ROUND = (n: number): Localized =>
  L(
    `Round ${n}`,
    `Ronde ${n}`,
    `Runde ${n}`,
    `Tour ${n}`,
    `Ronda ${n}`,
    `Turno ${n}`,
    `Раунд ${n}`,
    `Kolo ${n}`,
  );
const MORNING = L(
  "Morning",
  "Ochtend",
  "Vormittag",
  "Matin",
  "Mañana",
  "Mattina",
  "Ранок",
  "Dopoledne",
);
const AFTERNOON = L(
  "Afternoon",
  "Middag",
  "Nachmittag",
  "Après-midi",
  "Tarde",
  "Pomeriggio",
  "Після обіду",
  "Odpoledne",
);
const FOURS = L(
  "Groups of four",
  "Groepjes van vier",
  "Vierergruppen",
  "Groupes de quatre",
  "Grupos de cuatro",
  "Gruppi da quattro",
  "Групи по четверо",
  "Čtveřice",
);
const WHOLE_GROUP = L(
  "Whole group",
  "Hele groep",
  "Ganze Gruppe",
  "Groupe entier",
  "Grupo completo",
  "Tutto il gruppo",
  "Уся група",
  "Celá skupina",
);

const TABLE_OR_GROUP = L(
  "Table or group name",
  "Naam van je tafel of groep",
  "Name des Tisches oder der Gruppe",
  "Nom de la table ou du groupe",
  "Nombre de la mesa o del grupo",
  "Nome del tavolo o del gruppo",
  "Назва столу або групи",
  "Název stolu nebo skupiny",
);
const TABLE = L(
  "Table name or number",
  "Naam of nummer van je tafel",
  "Name oder Nummer des Tisches",
  "Nom ou numéro de la table",
  "Nombre o número de la mesa",
  "Nome o numero del tavolo",
  "Назва або номер столу",
  "Název nebo číslo stolu",
);
const GROUP = L(
  "Group name",
  "Naam van je groep",
  "Name der Gruppe",
  "Nom du groupe",
  "Nombre del grupo",
  "Nome del gruppo",
  "Назва групи",
  "Název skupiny",
);
const INTERVIEW_CODE = L(
  "Interview code (no real names)",
  "Interviewcode (geen echte namen)",
  "Interviewcode (keine echten Namen)",
  "Code de l'entretien (pas de vrais noms)",
  "Código de la entrevista (sin nombres reales)",
  "Codice dell'intervista (niente nomi veri)",
  "Код інтерв'ю (без справжніх імен)",
  "Kód rozhovoru (žádná skutečná jména)",
);
const MEETING = L(
  "Meeting name or date",
  "Naam of datum van het overleg",
  "Name oder Datum der Sitzung",
  "Nom ou date de la réunion",
  "Nombre o fecha de la reunión",
  "Nome o data della riunione",
  "Назва або дата зустрічі",
  "Název nebo datum schůzky",
);
const GROUP_OR_SCENARIO = L(
  "Group or scenario name",
  "Naam van je groep of scenario",
  "Name der Gruppe oder des Szenarios",
  "Nom du groupe ou du scénario",
  "Nombre del grupo o del escenario",
  "Nome del gruppo o dello scenario",
  "Назва групи або сценарію",
  "Název skupiny nebo scénáře",
);
const SESSION_TOPIC = L(
  "Topic of your session",
  "Onderwerp van je sessie",
  "Thema deiner Session",
  "Sujet de ta session",
  "Tema de tu sesión",
  "Tema della tua sessione",
  "Тема твоєї сесії",
  "Téma tvé sekce",
);
const SESSION_TITLE = L(
  "Session title",
  "Titel van de sessie",
  "Titel der Session",
  "Titre de la session",
  "Título de la sesión",
  "Titolo della sessione",
  "Назва сесії",
  "Název sekce",
);

// ── Host script building blocks ──────────────────────────────────────
// What the team says to hosts by hand: introductions first, then record; pause any time;
// ten minutes before the end press Verify and read the draft aloud; ask "most of us, or
// one of us?"; say what to change, Revise, Approve, then Stop.

const S = {
  record: L(
    "Do introductions first, then press Record. You can pause at any time.",
    "Doe eerst een voorstelrondje en druk dan op Opname starten. Je kunt altijd even pauzeren.",
    "Mach zuerst eine Vorstellungsrunde und tippe dann auf Aufnehmen. Du kannst jederzeit pausieren.",
    "Fais d'abord un tour de présentation, puis appuie sur Enregistrer. Tu peux faire une pause à tout moment.",
    "Haz primero una ronda de presentaciones y luego pulsa Grabar. Puedes hacer una pausa cuando quieras.",
    "Fai prima un giro di presentazioni, poi premi Record. Puoi fare una pausa in qualsiasi momento.",
    "Спершу проведи коло знайомства, потім натисни Record. Зробити паузу можна будь-коли.",
    "Nejdřív se představte a pak stiskni Record. Pozastavit můžeš kdykoli.",
  ),
  verify: L(
    "Ten minutes before the end, press Verify and read the draft aloud.",
    "Tien minuten voor het einde: druk op Verifiëren en lees het concept hardop voor.",
    "Zehn Minuten vor Schluss tippst du auf Verifizieren und liest den Entwurf laut vor.",
    "Dix minutes avant la fin, appuie sur Vérifier et lis le brouillon à voix haute.",
    "Diez minutos antes del final, pulsa Verificar y lee el borrador en voz alta.",
    "Dieci minuti prima della fine, premi Verify e leggi la bozza ad alta voce.",
    "За десять хвилин до кінця натисни Verify і прочитай чернетку вголос.",
    "Deset minut před koncem stiskni Verify a přečti návrh nahlas.",
  ),
  // With Explore on too, the portal's button reads "ECHO" and opens the choice.
  verifyOr: L(
    "Ten minutes before the end, press ECHO, then Verify, and read the draft aloud.",
    "Tien minuten voor het einde: druk op ECHO, dan op Verifiëren, en lees het concept hardop voor.",
    "Zehn Minuten vor Schluss tippst du auf ECHO, dann auf Verifizieren, und liest den Entwurf laut vor.",
    "Dix minutes avant la fin, appuie sur ECHO, puis sur Vérifier, et lis le brouillon à voix haute.",
    "Diez minutos antes del final, pulsa ECHO, luego Verificar, y lee el borrador en voz alta.",
    "Dieci minuti prima della fine, premi ECHO, poi Verify, e leggi la bozza ad alta voce.",
    "За десять хвилин до кінця натисни ECHO, потім Verify, і прочитай чернетку вголос.",
    "Deset minut před koncem stiskni ECHO, pak Verify, a přečti návrh nahlas.",
  ),
  exploreOr: L(
    "Stuck, or one voice taking over? Press ECHO, then Explore, and read the question aloud.",
    "Loopt het vast, of hoor je steeds dezelfde stem? Druk op ECHO, dan op Verkennen, en lees de vraag hardop voor.",
    "Stockt das Gespräch oder redet immer dieselbe Person? Tippe auf ECHO, dann auf Erkunden, und lies die Frage laut vor.",
    "La discussion bloque, ou une seule voix domine ? Appuie sur ECHO, puis sur Explorer, et lis la question à voix haute.",
    "¿Os habéis atascado o habla siempre la misma persona? Pulsa ECHO, luego Explorar, y lee la pregunta en voz alta.",
    "Il gruppo si è bloccato o parla sempre la stessa persona? Premi ECHO, poi Explore, e leggi la domanda ad alta voce.",
    "Розмова застрягла або говорить лише одна людина? Натисни ECHO, потім Explore, і прочитай питання вголос.",
    "Zaseklo se to, nebo mluví pořád jeden člověk? Stiskni ECHO, pak Explore, a přečti otázku nahlas.",
  ),
  ask: L(
    "Ask: does this say what most of us think, or what one of us thinks?",
    "Vraag: staat hier wat de meesten van ons denken, of wat één van ons denkt?",
    "Frag: Steht hier, was die meisten von uns denken, oder was eine Person denkt?",
    "Demande : est-ce que cela dit ce que la plupart d'entre nous pensent, ou ce qu'une seule personne pense ?",
    "Pregunta: ¿esto dice lo que piensa la mayoría de nosotros, o lo que piensa una sola persona?",
    "Chiedi: dice quello che pensa la maggior parte di noi, o quello che pensa una persona sola?",
    "Запитай: чи тут те, що думає більшість із нас, чи те, що думає одна людина?",
    "Zeptej se: říká to, co si myslí většina z nás, nebo jen jeden z nás?",
  ),
  revise: L(
    "Say what to change and press Revise. When it is right, press Approve, then Stop and Finish.",
    "Zeg wat er anders moet en druk op Aanpassen. Klopt het? Druk op Goedkeuren, dan op Stop en Afronden.",
    "Sag, was anders sein soll, und tippe auf Überarbeiten. Stimmt es, tippe auf Freigeben und dann auf Beenden.",
    "Dis ce qu'il faut changer et appuie sur Réviser. Quand c'est juste, appuie sur Approuver, puis Arrêter et Terminer.",
    "Di qué hay que cambiar y pulsa revisar. Cuando esté bien, pulsa aprobar y luego Detener y Finalizar.",
    "Di' cosa cambiare e premi Revise. Quando va bene, premi Approve, poi Stop e Finish.",
    "Скажи, що змінити, і натисни Revise. Коли все правильно, натисни Approve, потім Stop і Finish.",
    "Řekni, co změnit, a stiskni Revise. Až to sedí, stiskni Approve, pak Stop a Finish.",
  ),
} as const;

const TIP = {
  phone: L(
    "Put the phone in the middle of the table and keep the screen on.",
    "Leg de telefoon midden op tafel en laat het scherm aan.",
    "Leg das Telefon in die Mitte des Tisches und lass den Bildschirm an.",
    "Pose le téléphone au milieu de la table et laisse l'écran allumé.",
    "Pon el teléfono en el centro de la mesa y deja la pantalla encendida.",
    "Metti il telefono al centro del tavolo e lascia lo schermo acceso.",
    "Поклади телефон посередині столу й не вимикай екран.",
    "Polož telefon doprostřed stolu a nech zapnutou obrazovku.",
  ),
  pause: L(
    "Need a break? Press Stop, then Resume.",
    "Even pauze? Druk op Stop en daarna op Hervatten.",
    "Eine Pause? Tippe auf Beenden und dann auf Fortsetzen.",
    "Besoin d'une pause ? Appuie sur Arrêter, puis sur Reprendre.",
    "¿Necesitas una pausa? Pulsa Detener y luego Reanudar.",
    "Serve una pausa? Premi Stop, poi Resume.",
    "Потрібна перерва? Натисни Stop, потім Resume.",
    "Potřebuješ pauzu? Stiskni Stop a pak Resume.",
  ),
  oneVoice: L(
    "Let everyone speak once before anyone speaks twice.",
    "Laat iedereen één keer aan het woord voordat iemand voor de tweede keer praat.",
    "Lass alle einmal sprechen, bevor jemand zum zweiten Mal spricht.",
    "Laisse chacun parler une fois avant que quelqu'un ne parle une deuxième fois.",
    "Deja que todos hablen una vez antes de que alguien hable por segunda vez.",
    "Lascia parlare tutti una volta prima che qualcuno parli una seconda volta.",
    "Дай кожному сказати один раз, перш ніж хтось заговорить удруге.",
    "Nech každého promluvit jednou, než někdo promluví podruhé.",
  ),
  noNames: L(
    "Never type a real name. If someone wants to stop, press Stop and Finish.",
    "Typ nooit een echte naam. Wil iemand stoppen? Druk op Stop en Afronden.",
    "Gib nie einen echten Namen ein. Möchte jemand aufhören, tippe auf Beenden.",
    "N'écris jamais un vrai nom. Si quelqu'un veut arrêter, appuie sur Arrêter et Terminer.",
    "No escribas nunca un nombre real. Si alguien quiere parar, pulsa Detener y Finalizar.",
    "Non scrivere mai un nome vero. Se qualcuno vuole smettere, premi Stop e Finish.",
    "Ніколи не вводь справжнє ім'я. Якщо хтось хоче зупинитися, натисни Stop і Finish.",
    "Nikdy nepiš skutečné jméno. Když chce někdo skončit, stiskni Stop a Finish.",
  ),
} as const;

/** A many-groups preset: the name box for the table or group, the advanced tutorial (it
 * says "Don't lock your device!"), Verify reminded on finish, no automatic titles (they
 * would pick round tags by themselves). */
const MANY_GROUPS = {
  ...WIZARD_DEFAULTS,
  default_conversation_tutorial_slug: "advanced",
  is_verify_enabled: true,
  is_verify_on_finish_enabled: true,
} as const;

/** A one-recording preset: Verify reminded on finish, a title for each conversation. */
const ONE_RECORDING = {
  ...WIZARD_DEFAULTS,
  is_verify_enabled: true,
  is_verify_on_finish_enabled: true,
  enable_ai_title_and_tags: true,
} as const;

const EXPLORE_ONE_QUESTION = { is_get_reply_enabled: true, get_reply_mode: "summarize" } as const;
const EXPLORE_WHAT_IF = { is_get_reply_enabled: true, get_reply_mode: "brainstorm" } as const;

const PURPOSE_TEMPLATES = [
  // Municipalities and housing associations, 4 to 20 tables, one phone per table, mostly
  // Dutch. They want common ground and differences per table: the table check gives both
  // ("Also heard"), and one topic starts at once under time pressure. Explore for a stuck
  // table or a loud voice; the others' tables stay out (off).
  {
    key: "resident_evening",
    version: 1,
    card: {
      offer: "card",
      verbs: ["understand", "decide"],
      setup: "many_groups",
      sectors: ["public"],
      featured: true,
    },
    preset: {
      fields: { ...MANY_GROUPS, ...EXPLORE_ONE_QUESTION },
      name_label: TABLE,
      tags: [ROUND(1), ROUND(2)],
      verification_topics: ["agreements"],
      host_guide: {
        title: L(
          "Hosting a table at a resident evening",
          "Een tafel leiden op de bewonersavond",
          "Einen Tisch beim Anwohnerabend leiten",
          "Animer une table lors d'une soirée d'habitants",
          "Moderar una mesa en una reunión vecinal",
          "Condurre un tavolo alla serata con i residenti",
          "Ведення столу на зустрічі з мешканцями",
          "Vedení stolu na setkání s obyvateli",
        ),
        steps: [
          L(
            "Type your table name and tap the tag for this round.",
            "Typ de naam van je tafel en tik op de tag van deze ronde.",
            "Gib den Namen deines Tisches ein und tippe auf den Tag dieser Runde.",
            "Saisis le nom de ta table et touche le tag de ce tour.",
            "Escribe el nombre de tu mesa y toca la etiqueta de esta ronda.",
            "Scrivi il nome del tuo tavolo e tocca il tag di questo turno.",
            "Введи назву свого столу й торкнися тегу цього раунду.",
            "Napiš název svého stolu a klepni na štítek tohoto kola.",
          ),
          S.record,
          S.exploreOr,
          S.verifyOr,
          S.ask,
          S.revise,
        ],
        tips: [TIP.oneVoice, TIP.phone, TIP.pause],
      },
    },
  },
  // One table of partners or experts with different interests, one phone, no rush: the
  // table check and the differences both, decisions come later. No name box; titles.
  {
    key: "round_table",
    version: 1,
    card: {
      offer: "card",
      verbs: ["understand"],
      setup: "one_recording",
      sectors: ["public", "consulting"],
    },
    preset: {
      fields: { ...ONE_RECORDING, default_conversation_ask_for_participant_name: false },
      verification_topics: ["agreements", "disagreements"],
      host_guide: {
        title: L(
          "Leading a stakeholder round table",
          "Een rondetafelgesprek leiden",
          "Einen Runden Tisch leiten",
          "Animer une table ronde",
          "Moderar una mesa redonda",
          "Condurre una tavola rotonda",
          "Ведення круглого столу",
          "Vedení kulatého stolu",
        ),
        steps: [
          L(
            "Open with a round: who are you, and what interest do you bring?",
            "Begin met een rondje: wie ben je, en welk belang breng je mee?",
            "Beginne mit einer Runde: Wer bist du, und welches Interesse bringst du mit?",
            "Commence par un tour : qui es-tu, et quel intérêt représentes-tu ?",
            "Empieza con una ronda: ¿quién eres y qué interés traes?",
            "Inizia con un giro: chi sei e quale interesse porti?",
            "Почни з кола: хто ти і який інтерес представляєш?",
            "Začni kolečkem: kdo jsi a jaký zájem přinášíš?",
          ),
          S.record,
          S.verify,
          L(
            "Ask: are the differences in there too, said fairly for each side?",
            "Vraag: staan de verschillen er ook in, eerlijk voor elke kant?",
            "Frag: Stehen auch die Unterschiede drin, fair für jede Seite?",
            "Demande : les différences y sont-elles aussi, de façon juste pour chaque partie ?",
            "Pregunta: ¿están también las diferencias, contadas con justicia para cada parte?",
            "Chiedi: ci sono anche le differenze, dette in modo giusto per ogni parte?",
            "Запитай: чи є тут і розбіжності, чесно викладені для кожної сторони?",
            "Zeptej se: jsou tam i rozdíly, férově za každou stranu?",
          ),
          S.revise,
        ],
        tips: [TIP.oneVoice, TIP.pause],
      },
    },
  },
  // A moderator, one phone, 6 to 10 people; also youth panels (merged: the same settings
  // and the same script). "What we heard" gives the group's words back without reading
  // into them; one question helps when quieter people hold back.
  {
    key: "focus_group",
    version: 1,
    card: {
      offer: "card",
      verbs: ["understand"],
      setup: "one_recording",
      sectors: ["public", "consulting"],
      featured: true,
    },
    preset: {
      fields: {
        ...ONE_RECORDING,
        default_conversation_ask_for_participant_name: false,
        ...EXPLORE_ONE_QUESTION,
      },
      verification_topics: ["heard"],
      host_guide: {
        title: L(
          "Running a focus group",
          "Een focusgroep leiden",
          "Eine Fokusgruppe leiten",
          "Animer un groupe de discussion",
          "Moderar un grupo focal",
          "Condurre un focus group",
          "Проведення фокус-групи",
          "Vedení fokusní skupiny",
        ),
        steps: [
          L(
            "Say why you are here and that there are no wrong answers.",
            "Vertel waarom jullie hier zijn en dat er geen foute antwoorden zijn.",
            "Sag, warum ihr hier seid und dass es keine falschen Antworten gibt.",
            "Dis pourquoi vous êtes là et qu'il n'y a pas de mauvaises réponses.",
            "Di por qué estáis aquí y que no hay respuestas equivocadas.",
            "Di' perché siete qui e che non ci sono risposte sbagliate.",
            "Скажи, навіщо ви зібралися і що неправильних відповідей немає.",
            "Řekni, proč jste tady a že neexistují špatné odpovědi.",
          ),
          S.record,
          S.exploreOr,
          S.verifyOr,
          S.ask,
          S.revise,
        ],
        tips: [TIP.oneVoice, TIP.phone, TIP.pause],
      },
    },
  },
  // One-to-one, field and expert interviews, often a run of them: the name box asks for
  // an interview code (a typed name is personal data, and the box is read as one), titles
  // tell them apart. "What we heard" read back to the interviewee. Explore off: the
  // interviewer leads.
  {
    key: "interviews",
    version: 1,
    card: {
      offer: "card",
      verbs: ["understand", "gather"],
      setup: "one_recording",
      sectors: ["public", "consulting", "internal"],
      featured: true,
    },
    preset: {
      fields: { ...ONE_RECORDING },
      name_label: INTERVIEW_CODE,
      verification_topics: ["heard"],
      host_guide: {
        title: L(
          "Running an interview",
          "Een interview afnemen",
          "Ein Interview führen",
          "Mener un entretien",
          "Hacer una entrevista",
          "Condurre un'intervista",
          "Проведення інтерв'ю",
          "Vedení rozhovoru",
        ),
        steps: [
          L(
            "Ask for consent and say what happens with the recording.",
            "Vraag om toestemming en vertel wat er met de opname gebeurt.",
            "Bitte um Einverständnis und sag, was mit der Aufnahme geschieht.",
            "Demande le consentement et dis ce que deviendra l'enregistrement.",
            "Pide el consentimiento y explica qué pasa con la grabación.",
            "Chiedi il consenso e spiega cosa succede alla registrazione.",
            "Попроси згоди й поясни, що буде із записом.",
            "Požádej o souhlas a řekni, co se s nahrávkou stane.",
          ),
          L(
            "Type the interview code, not a name, and press Record.",
            "Typ de interviewcode, geen naam, en druk op Opname starten.",
            "Gib den Interviewcode ein, keinen Namen, und tippe auf Aufnehmen.",
            "Saisis le code de l'entretien, pas un nom, et appuie sur Enregistrer.",
            "Escribe el código de la entrevista, no un nombre, y pulsa Grabar.",
            "Scrivi il codice dell'intervista, non un nome, e premi Record.",
            "Введи код інтерв'ю, а не ім'я, і натисни Record.",
            "Napiš kód rozhovoru, ne jméno, a stiskni Record.",
          ),
          S.verify,
          L(
            "Ask: did I hear you right? Is anything missing?",
            "Vraag: heb ik je goed begrepen? Mist er iets?",
            "Frag: Habe ich dich richtig verstanden? Fehlt etwas?",
            "Demande : est-ce que je t'ai bien compris ? Manque-t-il quelque chose ?",
            "Pregunta: ¿te he entendido bien? ¿Falta algo?",
            "Chiedi: ti ho capito bene? Manca qualcosa?",
            "Запитай: чи правильно я тебе зрозумів? Чогось бракує?",
            "Zeptej se: rozuměl jsem ti dobře? Chybí něco?",
          ),
          S.revise,
        ],
        tips: [TIP.noNames, TIP.pause],
      },
    },
  },
  // Social-care visits at someone's home: sensitive, one phone, no name box (nothing to
  // type that could identify them). What we heard, and what was agreed. Explore off:
  // no model questions in someone's kitchen.
  {
    key: "kitchen_table",
    version: 1,
    card: {
      offer: "card",
      verbs: ["understand"],
      setup: "one_recording",
      sectors: ["public"],
    },
    preset: {
      fields: { ...ONE_RECORDING, default_conversation_ask_for_participant_name: false },
      verification_topics: ["heard", "actions"],
      host_guide: {
        title: L(
          "A kitchen-table conversation",
          "Een keukentafelgesprek voeren",
          "Ein Gespräch am Küchentisch",
          "Une conversation autour de la table de cuisine",
          "Una conversación en la mesa de la cocina",
          "Una conversazione al tavolo di cucina",
          "Розмова за кухонним столом",
          "Rozhovor u kuchyňského stolu",
        ),
        steps: [
          L(
            "Ask if recording is all right, and say you can stop at any moment.",
            "Vraag of opnemen goed is en zeg dat jullie op elk moment kunnen stoppen.",
            "Frag, ob die Aufnahme in Ordnung ist, und sag, dass ihr jederzeit aufhören könnt.",
            "Demande si l'enregistrement convient, et dis que vous pouvez arrêter à tout moment.",
            "Pregunta si está bien grabar y di que podéis parar en cualquier momento.",
            "Chiedi se va bene registrare e di' che potete fermarvi in qualsiasi momento.",
            "Запитай, чи можна записувати, і скажи, що зупинитися можна будь-коли.",
            "Zeptej se, jestli můžeš nahrávat, a řekni, že můžete kdykoli přestat.",
          ),
          L(
            "Put the phone where you can both see it and press Record.",
            "Leg de telefoon neer waar jullie hem allebei zien en druk op Opname starten.",
            "Leg das Telefon so hin, dass ihr es beide seht, und tippe auf Aufnehmen.",
            "Pose le téléphone là où vous le voyez tous les deux et appuie sur Enregistrer.",
            "Pon el teléfono donde lo veáis los dos y pulsa Grabar.",
            "Metti il telefono dove potete vederlo entrambi e premi Record.",
            "Поклади телефон так, щоб ви обоє його бачили, і натисни Record.",
            "Polož telefon tak, abyste ho oba viděli, a stiskni Record.",
          ),
          L(
            "Before you say goodbye, press Verify and read the draft aloud.",
            "Voor je afscheid neemt: druk op Verifiëren en lees het concept hardop voor.",
            "Bevor du dich verabschiedest, tippst du auf Verifizieren und liest den Entwurf laut vor.",
            "Avant de partir, appuie sur Vérifier et lis le brouillon à voix haute.",
            "Antes de despedirte, pulsa Verificar y lee el borrador en voz alta.",
            "Prima di salutare, premi Verify e leggi la bozza ad alta voce.",
            "Перед тим як попрощатися, натисни Verify і прочитай чернетку вголос.",
            "Než se rozloučíš, stiskni Verify a přečti návrh nahlas.",
          ),
          L(
            "Ask: is this what you told me, and what we agreed?",
            "Vraag: is dit wat je me vertelde, en wat we hebben afgesproken?",
            "Frag: Ist das, was du mir erzählt hast und was wir vereinbart haben?",
            "Demande : est-ce bien ce que tu m'as dit, et ce que nous avons convenu ?",
            "Pregunta: ¿es esto lo que me contaste y lo que acordamos?",
            "Chiedi: è quello che mi hai raccontato e quello che abbiamo concordato?",
            "Запитай: чи це те, що ти мені розповів, і про що ми домовилися?",
            "Zeptej se: je to, co jsi mi řekl a na čem jsme se dohodli?",
          ),
          S.revise,
        ],
        tips: [TIP.noNames, TIP.pause],
      },
    },
  },
  // 20 to 175 people in groups; themes before lunch, decisions and actions after: the
  // rounds are Morning and Afternoon, Verify has the table check and the actions.
  {
    key: "strategy_day",
    version: 1,
    card: {
      offer: "card",
      verbs: ["align"],
      setup: "many_groups",
      sectors: ["internal", "consulting"],
      featured: true,
    },
    preset: {
      fields: { ...MANY_GROUPS, ...EXPLORE_ONE_QUESTION },
      name_label: GROUP,
      tags: [MORNING, AFTERNOON],
      verification_topics: ["agreements", "actions"],
      host_guide: {
        title: L(
          "Leading a group on a strategy day",
          "Een groep leiden op de heidag",
          "Eine Gruppe beim Strategietag leiten",
          "Animer un groupe lors d'une journée stratégique",
          "Moderar un grupo en una jornada de estrategia",
          "Condurre un gruppo in una giornata strategica",
          "Ведення групи на стратегічному дні",
          "Vedení skupiny na strategickém dni",
        ),
        steps: [
          L(
            "Tap Morning or Afternoon and type your group name.",
            "Tik op Ochtend of Middag en typ de naam van je groep.",
            "Tippe auf Vormittag oder Nachmittag und gib den Namen deiner Gruppe ein.",
            "Touche Matin ou Après-midi et saisis le nom de ton groupe.",
            "Toca Mañana o Tarde y escribe el nombre de tu grupo.",
            "Tocca Mattina o Pomeriggio e scrivi il nome del tuo gruppo.",
            "Торкнися «Ранок» або «Після обіду» й введи назву групи.",
            "Klepni na Dopoledne nebo Odpoledne a napiš název skupiny.",
          ),
          S.record,
          S.exploreOr,
          S.verifyOr,
          L(
            "Ask: who does what, and by when? Is that in the draft?",
            "Vraag: wie doet wat, en wanneer? Staat dat erin?",
            "Frag: Wer macht was, und bis wann? Steht das im Entwurf?",
            "Demande : qui fait quoi, et pour quand ? Est-ce dans le brouillon ?",
            "Pregunta: ¿quién hace qué y para cuándo? ¿Está en el borrador?",
            "Chiedi: chi fa cosa, ed entro quando? È nella bozza?",
            "Запитай: хто що робить і до якого терміну? Це є в чернетці?",
            "Zeptej se: kdo co udělá a do kdy? Je to v návrhu?",
          ),
          S.revise,
        ],
        tips: [TIP.oneVoice, TIP.phone, TIP.pause],
      },
    },
  },
  // A small group meeting again and again that needs minutes: decisions and actions,
  // traceable. The name box tells the meetings apart ("Meeting 3", a date); titles say
  // what each was about. Explore off: it is a meeting, not a conversation to deepen.
  {
    key: "working_group",
    version: 1,
    card: {
      offer: "card",
      verbs: ["align", "decide"],
      setup: "one_recording",
      sectors: ["internal", "public"],
      featured: true,
    },
    preset: {
      fields: { ...ONE_RECORDING },
      name_label: MEETING,
      verification_topics: ["actions"],
      host_guide: {
        title: L(
          "Minutes for a working group",
          "Een verslag van de werkgroep",
          "Protokoll für eine Arbeitsgruppe",
          "Le compte rendu d'un groupe de travail",
          "El acta de un grupo de trabajo",
          "Il verbale di un gruppo di lavoro",
          "Протокол робочої групи",
          "Zápis z pracovní skupiny",
        ),
        steps: [
          L(
            "Type the meeting name or date and press Record.",
            "Typ de naam of datum van het overleg en druk op Opname starten.",
            "Gib den Namen oder das Datum der Sitzung ein und tippe auf Aufnehmen.",
            "Saisis le nom ou la date de la réunion et appuie sur Enregistrer.",
            "Escribe el nombre o la fecha de la reunión y pulsa Grabar.",
            "Scrivi il nome o la data della riunione e premi Record.",
            "Введи назву або дату зустрічі й натисни Record.",
            "Napiš název nebo datum schůzky a stiskni Record.",
          ),
          L(
            "Go through the agenda as usual. You can pause between items.",
            "Loop de agenda door zoals altijd. Tussen de punten kun je pauzeren.",
            "Geh die Tagesordnung wie gewohnt durch. Zwischen den Punkten kannst du pausieren.",
            "Suis l'ordre du jour comme d'habitude. Tu peux faire une pause entre les points.",
            "Sigue el orden del día como siempre. Puedes hacer una pausa entre los puntos.",
            "Segui l'ordine del giorno come sempre. Puoi fare una pausa tra un punto e l'altro.",
            "Іди за порядком денним, як завжди. Між пунктами можна робити паузу.",
            "Projdi program jako obvykle. Mezi body můžeš pozastavit.",
          ),
          L(
            "Five minutes before the end, press Verify and read the decisions and actions aloud.",
            "Vijf minuten voor het einde: druk op Verifiëren en lees de besluiten en acties hardop voor.",
            "Fünf Minuten vor Schluss tippst du auf Verifizieren und liest die Beschlüsse und Aufgaben laut vor.",
            "Cinq minutes avant la fin, appuie sur Vérifier et lis les décisions et actions à voix haute.",
            "Cinco minutos antes del final, pulsa Verificar y lee en voz alta las decisiones y acciones.",
            "Cinque minuti prima della fine, premi Verify e leggi ad alta voce decisioni e azioni.",
            "За п'ять хвилин до кінця натисни Verify і прочитай рішення та дії вголос.",
            "Pět minut před koncem stiskni Verify a přečti nahlas rozhodnutí a úkoly.",
          ),
          L(
            "Ask: does every action have someone and a date?",
            "Vraag: heeft elke actie een eigenaar en een datum?",
            "Frag: Hat jede Aufgabe eine verantwortliche Person und ein Datum?",
            "Demande : chaque action a-t-elle une personne et une date ?",
            "Pregunta: ¿cada acción tiene responsable y fecha?",
            "Chiedi: ogni azione ha una persona e una data?",
            "Запитай: чи має кожна дія відповідальну людину й дату?",
            "Zeptej se: má každý úkol člověka a termín?",
          ),
          S.revise,
        ],
        tips: [TIP.pause],
      },
    },
  },
  // Evaluations and retrospectives (the weakest evidence): one team, one phone. The hard
  // points in their own words, and what changes. Explore off to keep the script short.
  {
    key: "retrospective",
    version: 1,
    card: {
      offer: "card",
      verbs: ["align", "gather"],
      setup: "one_recording",
      sectors: ["internal", "consulting"],
    },
    preset: {
      fields: { ...ONE_RECORDING, default_conversation_ask_for_participant_name: false },
      verification_topics: ["truths", "actions"],
      host_guide: {
        title: L(
          "Leading an evaluation",
          "Een evaluatie leiden",
          "Eine Auswertung leiten",
          "Animer une évaluation",
          "Moderar una evaluación",
          "Condurre una valutazione",
          "Проведення оцінювання",
          "Vedení hodnocení",
        ),
        steps: [
          L(
            "Agree first: we look at what happened, not at who.",
            "Spreek eerst af: we kijken naar wat er gebeurde, niet naar wie.",
            "Vereinbart zuerst: Wir schauen darauf, was passiert ist, nicht auf wen.",
            "Mettez-vous d'abord d'accord : on regarde ce qui s'est passé, pas qui.",
            "Acordad primero: miramos lo que pasó, no quién.",
            "Mettetevi d'accordo: guardiamo a cosa è successo, non a chi.",
            "Спершу домовтеся: ми дивимося на те, що сталося, а не на те, хто винен.",
            "Nejdřív se dohodněte: díváme se na to, co se stalo, ne na to, kdo.",
          ),
          S.record,
          L(
            "Go round: what went well, what was hard, what do we change?",
            "Ga het rondje langs: wat ging goed, wat was lastig, wat doen we anders?",
            "Geh reihum: Was lief gut, was war schwierig, was ändern wir?",
            "Fais un tour : qu'est-ce qui a bien marché, qu'est-ce qui était difficile, que changeons-nous ?",
            "Haced una ronda: ¿qué fue bien, qué fue difícil, qué cambiamos?",
            "Fate un giro: cosa è andato bene, cosa è stato difficile, cosa cambiamo?",
            "Пройди по колу: що вдалося, що було важко, що змінимо?",
            "Projdi kolečko: co šlo dobře, co bylo těžké, co změníme?",
          ),
          S.verify,
          S.ask,
          S.revise,
        ],
        tips: [TIP.oneVoice, TIP.pause],
      },
    },
  },
  // Idea and innovation workshops in groups: ideas worth keeping, two "What if" prompts
  // when a group runs dry, and cross-pollination on: building on other groups is the point.
  {
    key: "ideation",
    version: 1,
    card: {
      offer: "card",
      verbs: ["explore"],
      setup: "many_groups",
      sectors: ["consulting", "internal", "networks_events"],
      featured: true,
    },
    preset: {
      fields: {
        ...MANY_GROUPS,
        ...EXPLORE_WHAT_IF,
        is_get_reply_cross_pollination_enabled: true,
      },
      name_label: GROUP,
      tags: [ROUND(1), ROUND(2)],
      verification_topics: ["gems"],
      host_guide: {
        title: L(
          "Leading a group in an ideation workshop",
          "Een groep leiden in de ideeënsessie",
          "Eine Gruppe im Ideenworkshop leiten",
          "Animer un groupe en atelier d'idéation",
          "Moderar un grupo en un taller de ideas",
          "Condurre un gruppo in un workshop di idee",
          "Ведення групи на воркшопі ідей",
          "Vedení skupiny na workshopu nápadů",
        ),
        steps: [
          L(
            "Type your group name and tap the tag for this round.",
            "Typ de naam van je groep en tik op de tag van deze ronde.",
            "Gib den Namen deiner Gruppe ein und tippe auf den Tag dieser Runde.",
            "Saisis le nom de ton groupe et touche le tag de ce tour.",
            "Escribe el nombre de tu grupo y toca la etiqueta de esta ronda.",
            "Scrivi il nome del tuo gruppo e tocca il tag di questo turno.",
            "Введи назву групи й торкнися тегу цього раунду.",
            "Napiš název skupiny a klepni na štítek tohoto kola.",
          ),
          S.record,
          L(
            "Say every idea out loud, even half ones. No judging yet.",
            "Spreek elk idee hardop uit, ook de halve. Nog niet oordelen.",
            "Sprecht jede Idee laut aus, auch halbe. Noch nicht bewerten.",
            "Dites chaque idée à voix haute, même à moitié formée. Pas encore de jugement.",
            "Di cada idea en voz alta, también las que están a medias. Todavía sin juzgar.",
            "Di' ogni idea ad alta voce, anche quelle a metà. Ancora senza giudicare.",
            "Кажіть кожну ідею вголос, навіть недодуману. Поки що без оцінок.",
            "Říkejte každý nápad nahlas, i napůl hotový. Zatím nehodnoťte.",
          ),
          L(
            "Out of ideas? Press ECHO, then Explore, and read the What if questions aloud. They may bring in other groups.",
            "Ideeën op? Druk op ECHO, dan op Verkennen, en lees de Wat als-vragen hardop voor. Die kunnen andere groepen meenemen.",
            "Keine Ideen mehr? Tippe auf ECHO, dann auf Erkunden, und lies die Was-wäre-wenn-Fragen laut vor. Sie können andere Gruppen einbeziehen.",
            "Plus d'idées ? Appuie sur ECHO, puis sur Explorer, et lis les questions Et si à voix haute. Elles peuvent reprendre d'autres groupes.",
            "¿Sin ideas? Pulsa ECHO, luego Explorar, y lee en voz alta las preguntas Y si. Pueden traer ideas de otros grupos.",
            "Finite le idee? Premi ECHO, poi Explore, e leggi ad alta voce le domande E se. Possono riprendere altri gruppi.",
            "Ідеї скінчилися? Натисни ECHO, потім Explore, і прочитай вголос питання «А що, як». Вони можуть підхопити інші групи.",
            "Došly nápady? Stiskni ECHO, pak Explore, a přečti nahlas otázky Co kdyby. Mohou přinést myšlenky jiných skupin.",
          ),
          S.verifyOr,
          S.revise,
        ],
        tips: [TIP.phone, TIP.pause],
      },
    },
  },
  // Scenario planning and co-design of a future: the hard points and the turning points,
  // "What if" prompts. Each group keeps its own scenario, so cross-pollination stays off.
  {
    key: "futures",
    version: 1,
    card: {
      offer: "card",
      verbs: ["explore"],
      setup: "many_groups",
      sectors: ["public", "consulting"],
    },
    preset: {
      fields: { ...MANY_GROUPS, ...EXPLORE_WHAT_IF },
      name_label: GROUP_OR_SCENARIO,
      tags: [ROUND(1), ROUND(2)],
      verification_topics: ["truths", "moments"],
      host_guide: {
        title: L(
          "Leading a group in a futures session",
          "Een groep leiden in de toekomstsessie",
          "Eine Gruppe in der Zukunftswerkstatt leiten",
          "Animer un groupe en atelier prospectif",
          "Moderar un grupo en una sesión de futuros",
          "Condurre un gruppo in una sessione sul futuro",
          "Ведення групи на сесії про майбутнє",
          "Vedení skupiny na setkání o budoucnosti",
        ),
        steps: [
          L(
            "Type your group or scenario name, do introductions and press Record.",
            "Typ de naam van je groep of scenario, doe een voorstelrondje en druk op Opname starten.",
            "Gib den Namen der Gruppe oder des Szenarios ein, macht eine Vorstellungsrunde und tippe auf Aufnehmen.",
            "Saisis le nom du groupe ou du scénario, faites un tour de présentation et appuie sur Enregistrer.",
            "Escribe el nombre del grupo o del escenario, haced las presentaciones y pulsa Grabar.",
            "Scrivi il nome del gruppo o dello scenario, fate le presentazioni e premi Record.",
            "Введи назву групи або сценарію, познайомтеся й натисни Record.",
            "Napiš název skupiny nebo scénáře, představte se a stiskni Record.",
          ),
          L(
            "Picture the year you are working towards and describe it as if it is already here.",
            "Stel je het jaar voor waar je naartoe werkt en beschrijf het alsof het er al is.",
            "Stellt euch das Jahr vor, auf das ihr hinarbeitet, und beschreibt es, als wäre es schon da.",
            "Imaginez l'année que vous visez et décrivez-la comme si elle était déjà là.",
            "Imagina el año hacia el que trabajáis y descríbelo como si ya hubiera llegado.",
            "Immagina l'anno verso cui lavorate e descrivilo come se fosse già arrivato.",
            "Уявіть рік, до якого ви рухаєтеся, і опишіть його так, ніби він уже настав.",
            "Představte si rok, ke kterému směřujete, a popište ho, jako by už nastal.",
          ),
          L(
            "Stuck? Press ECHO, then Explore, and read the What if questions aloud.",
            "Loopt het vast? Druk op ECHO, dan op Verkennen, en lees de Wat als-vragen hardop voor.",
            "Stockt es? Tippe auf ECHO, dann auf Erkunden, und lies die Was-wäre-wenn-Fragen laut vor.",
            "Ça bloque ? Appuie sur ECHO, puis sur Explorer, et lis les questions Et si à voix haute.",
            "¿Atascados? Pulsa ECHO, luego Explorar, y lee en voz alta las preguntas Y si.",
            "Bloccati? Premi ECHO, poi Explore, e leggi ad alta voce le domande E se.",
            "Застрягли? Натисни ECHO, потім Explore, і прочитай вголос питання «А що, як».",
            "Zasekli jste se? Stiskni ECHO, pak Explore, a přečti nahlas otázky Co kdyby.",
          ),
          S.verifyOr,
          L(
            "Ask: what has to be true for this future, and where could it turn?",
            "Vraag: wat moet er waar zijn voor deze toekomst, en waar kan het kantelen?",
            "Frag: Was muss für diese Zukunft wahr sein, und wo könnte sie kippen?",
            "Demande : que faut-il pour que cet avenir soit vrai, et où pourrait-il basculer ?",
            "Pregunta: ¿qué tiene que ser cierto para este futuro y dónde podría cambiar?",
            "Chiedi: cosa deve essere vero per questo futuro, e dove potrebbe cambiare?",
            "Запитай: що має бути правдою для такого майбутнього і де все може змінитися?",
            "Zeptej se: co musí platit, aby tahle budoucnost nastala, a kde se může zlomit?",
          ),
          S.revise,
        ],
        tips: [TIP.phone, TIP.pause],
      },
    },
  },
  // Café rounds: people change tables, the table host stays and carries the thread.
  // "What we heard" per round; the question may bring in other tables (cross-pollination
  // on: hearing the room is the point of the format).
  {
    key: "world_cafe",
    version: 1,
    card: {
      offer: "card",
      verbs: ["explore", "understand"],
      setup: "many_groups",
      sectors: ["networks_events", "public", "internal"],
      method: "World Café",
    },
    preset: {
      fields: {
        ...MANY_GROUPS,
        ...EXPLORE_ONE_QUESTION,
        is_get_reply_cross_pollination_enabled: true,
      },
      name_label: TABLE,
      tags: [ROUND(1), ROUND(2), ROUND(3)],
      verification_topics: ["heard"],
      host_guide: {
        title: L(
          "Hosting a table in café rounds",
          "Een tafel leiden bij wisseltafels",
          "Einen Tisch in Café-Runden leiten",
          "Animer une table en tours de café",
          "Moderar una mesa en rondas de café",
          "Condurre un tavolo nei turni del café",
          "Ведення столу в кав'ярняних раундах",
          "Vedení stolu v kavárenských kolech",
        ),
        steps: [
          L(
            "You stay at this table; the others move each round. Tap the tag for this round.",
            "Jij blijft aan deze tafel, de anderen schuiven elke ronde door. Tik op de tag van deze ronde.",
            "Du bleibst an diesem Tisch, die anderen wechseln jede Runde. Tippe auf den Tag dieser Runde.",
            "Tu restes à cette table, les autres changent à chaque tour. Touche le tag de ce tour.",
            "Tú te quedas en esta mesa; los demás cambian en cada ronda. Toca la etiqueta de esta ronda.",
            "Tu resti a questo tavolo, gli altri cambiano a ogni turno. Tocca il tag di questo turno.",
            "Ти залишаєшся за цим столом, інші пересідають щораунду. Торкнися тегу цього раунду.",
            "Ty zůstáváš u tohoto stolu, ostatní se každé kolo přesunou. Klepni na štítek tohoto kola.",
          ),
          L(
            "Tell newcomers in two sentences what this table heard so far, then press Record.",
            "Vertel nieuwkomers in twee zinnen wat er aan deze tafel al gezegd is en druk op Opname starten.",
            "Erzähl Neuen in zwei Sätzen, was an diesem Tisch schon gesagt wurde, und tippe auf Aufnehmen.",
            "Dis aux nouveaux en deux phrases ce que cette table a déjà entendu, puis appuie sur Enregistrer.",
            "Cuenta a los recién llegados en dos frases lo que se ha dicho en esta mesa y pulsa Grabar.",
            "Racconta ai nuovi in due frasi cosa si è detto a questo tavolo, poi premi Record.",
            "Розкажи новеньким двома реченнями, що вже прозвучало за цим столом, і натисни Record.",
            "Řekni nově příchozím dvěma větami, co u stolu zaznělo, a stiskni Record.",
          ),
          L(
            "Want to hear the room? Press ECHO, then Explore: the question can bring in other tables.",
            "Benieuwd naar de zaal? Druk op ECHO, dan op Verkennen: de vraag kan andere tafels meenemen.",
            "Neugierig auf den Raum? Tippe auf ECHO, dann auf Erkunden: Die Frage kann andere Tische einbeziehen.",
            "Envie d'entendre la salle ? Appuie sur ECHO, puis sur Explorer : la question peut reprendre d'autres tables.",
            "¿Quieres oír a la sala? Pulsa ECHO, luego Explorar: la pregunta puede traer otras mesas.",
            "Vuoi sentire la sala? Premi ECHO, poi Explore: la domanda può riprendere altri tavoli.",
            "Хочеш почути всю залу? Натисни ECHO, потім Explore: питання може підхопити інші столи.",
            "Chceš slyšet celý sál? Stiskni ECHO, pak Explore: otázka může přinést jiné stoly.",
          ),
          S.verifyOr,
          S.ask,
          S.revise,
        ],
        tips: [TIP.phone, TIP.pause],
      },
    },
  },
  // Unconferences: the person who called a session holds the phone, the name box asks
  // for its topic, and rounds are the time slots. What is worth keeping and who picks it
  // up. Explore off: groups come and go.
  {
    key: "open_space",
    version: 1,
    card: {
      offer: "card",
      verbs: ["gather", "explore"],
      setup: "many_groups",
      sectors: ["networks_events", "internal"],
      method: "Open Space",
    },
    preset: {
      fields: { ...MANY_GROUPS },
      name_label: SESSION_TOPIC,
      tags: [ROUND(1), ROUND(2), ROUND(3)],
      verification_topics: ["gems", "actions"],
      host_guide: {
        title: L(
          "Leading a session at an unconference",
          "Een sessie leiden op een unconference",
          "Eine Session auf einer Unkonferenz leiten",
          "Animer une session lors d'une non-conférence",
          "Moderar una sesión en una desconferencia",
          "Condurre una sessione in una non-conferenza",
          "Ведення сесії на анконференції",
          "Vedení sekce na nekonferenci",
        ),
        steps: [
          L(
            "You called this session, so you hold the phone. Type its topic and tap the round.",
            "Jij hebt deze sessie bedacht, dus jij hebt de telefoon. Typ het onderwerp en tik op de ronde.",
            "Du hast diese Session vorgeschlagen, also hältst du das Telefon. Gib das Thema ein und tippe auf die Runde.",
            "Tu as proposé cette session, c'est donc toi qui tiens le téléphone. Saisis le sujet et touche le tour.",
            "Tú propusiste esta sesión, así que tú llevas el teléfono. Escribe el tema y toca la ronda.",
            "Hai proposto tu questa sessione, quindi tieni tu il telefono. Scrivi il tema e tocca il turno.",
            "Ти запропонував цю сесію, тож телефон у тебе. Введи тему й торкнися раунду.",
            "Sekci jsi navrhl ty, takže držíš telefon. Napiš téma a klepni na kolo.",
          ),
          L(
            "Whoever comes is the right group. Press Record; people may walk in and out.",
            "Wie er komt, is de juiste groep. Druk op Opname starten; mensen mogen in- en weglopen.",
            "Wer kommt, ist die richtige Gruppe. Tippe auf Aufnehmen; Leute dürfen kommen und gehen.",
            "Ceux qui viennent forment le bon groupe. Appuie sur Enregistrer ; on peut entrer et sortir.",
            "Quien viene es el grupo adecuado. Pulsa Grabar; la gente puede entrar y salir.",
            "Chi viene è il gruppo giusto. Premi Record; le persone possono entrare e uscire.",
            "Хто прийшов, той і потрібна група. Натисни Record; люди можуть заходити й виходити.",
            "Kdo přijde, je ta správná skupina. Stiskni Record; lidé mohou přicházet a odcházet.",
          ),
          S.verify,
          L(
            "Ask: what do we take with us, and who picks it up?",
            "Vraag: wat nemen we mee, en wie pakt het op?",
            "Frag: Was nehmen wir mit, und wer kümmert sich darum?",
            "Demande : qu'emportons-nous, et qui s'en charge ?",
            "Pregunta: ¿qué nos llevamos y quién se encarga?",
            "Chiedi: cosa portiamo con noi, e chi se ne occupa?",
            "Запитай: що ми забираємо із собою і хто цим займеться?",
            "Zeptej se: co si odnášíme a kdo se toho ujme?",
          ),
          S.revise,
        ],
        tips: [TIP.phone, TIP.pause],
      },
    },
  },
  // Everyone's ideas in a few minutes: alone, in pairs, then fours, where it is recorded,
  // then all together. One topic (ideas worth keeping) so it starts at once; Explore off,
  // it is fast. Tags are the two recorded steps.
  {
    key: "one_two_four_all",
    version: 1,
    card: {
      offer: "card",
      verbs: ["explore", "gather"],
      setup: "many_groups",
      sectors: ["internal", "networks_events", "consulting"],
      method: "1-2-4-All",
    },
    preset: {
      fields: { ...MANY_GROUPS },
      name_label: GROUP,
      tags: [FOURS, WHOLE_GROUP],
      verification_topics: ["gems"],
      host_guide: {
        title: L(
          "Everyone's ideas, fast",
          "Snel ieders ideeën",
          "Schnell die Ideen aller",
          "Les idées de chacun, vite",
          "Las ideas de todos, rápido",
          "Le idee di tutti, in fretta",
          "Ідеї кожного, швидко",
          "Nápady všech, rychle",
        ),
        steps: [
          L(
            "Ask the question. A minute alone in silence, then a few minutes in pairs.",
            "Stel de vraag. Een minuut alleen in stilte, dan een paar minuten in tweetallen.",
            "Stell die Frage. Eine Minute still für sich, dann ein paar Minuten zu zweit.",
            "Pose la question. Une minute seul en silence, puis quelques minutes à deux.",
            "Haz la pregunta. Un minuto a solas en silencio y luego unos minutos en parejas.",
            "Fai la domanda. Un minuto da soli in silenzio, poi qualche minuto in coppia.",
            "Постав питання. Хвилина наодинці в тиші, потім кілька хвилин у парах.",
            "Polož otázku. Minutu sami v tichu, pak pár minut ve dvojicích.",
          ),
          L(
            "In fours: tap Groups of four, type a group name and press Record.",
            "Met z'n vieren: tik op Groepjes van vier, typ een groepsnaam en druk op Opname starten.",
            "Zu viert: Tippe auf Vierergruppen, gib einen Gruppennamen ein und tippe auf Aufnehmen.",
            "À quatre : touche Groupes de quatre, saisis un nom de groupe et appuie sur Enregistrer.",
            "De cuatro en cuatro: toca Grupos de cuatro, escribe un nombre de grupo y pulsa Grabar.",
            "In quattro: tocca Gruppi da quattro, scrivi un nome di gruppo e premi Record.",
            "Учотирьох: торкнися «Групи по четверо», введи назву групи й натисни Record.",
            "Ve čtveřicích: klepni na Čtveřice, napiš název skupiny a stiskni Record.",
          ),
          L(
            "After a few minutes, press Verify and read the ideas aloud.",
            "Na een paar minuten: druk op Verifiëren en lees de ideeën hardop voor.",
            "Nach ein paar Minuten tippst du auf Verifizieren und liest die Ideen laut vor.",
            "Après quelques minutes, appuie sur Vérifier et lis les idées à voix haute.",
            "Tras unos minutos, pulsa Verificar y lee las ideas en voz alta.",
            "Dopo qualche minuto, premi Verify e leggi le idee ad alta voce.",
            "За кілька хвилин натисни Verify і прочитай ідеї вголос.",
            "Po pár minutách stiskni Verify a přečti nápady nahlas.",
          ),
          L(
            "Ask: which idea stands out? Say what to change, then press Approve, Stop and Finish.",
            "Vraag: welk idee springt eruit? Zeg wat er anders moet en druk op Goedkeuren, Stop en Afronden.",
            "Frag: Welche Idee sticht heraus? Sag, was anders sein soll, und tippe auf Freigeben und Beenden.",
            "Demande : quelle idée ressort ? Dis ce qu'il faut changer, puis appuie sur Approuver, Arrêter et Terminer.",
            "Pregunta: ¿qué idea destaca? Di qué cambiar y pulsa aprobar, Detener y Finalizar.",
            "Chiedi: quale idea spicca? Di' cosa cambiare, poi premi Approve, Stop e Finish.",
            "Запитай: яка ідея вирізняється? Скажи, що змінити, і натисни Approve, Stop і Finish.",
            "Zeptej se: který nápad vyniká? Řekni, co změnit, a stiskni Approve, Stop a Finish.",
          ),
          L(
            "All together: each group shares its one idea. Record it on one phone with Whole group.",
            "Met de hele groep: elk groepje deelt zijn ene idee. Neem dat op één telefoon op met Hele groep.",
            "Alle zusammen: Jede Gruppe teilt ihre eine Idee. Nimm das auf einem Telefon mit Ganze Gruppe auf.",
            "Tous ensemble : chaque groupe partage son idée. Enregistre-la sur un téléphone avec Groupe entier.",
            "Todos juntos: cada grupo comparte su idea. Grábalo en un teléfono con Grupo completo.",
            "Tutti insieme: ogni gruppo condivide la sua idea. Registrala su un telefono con Tutto il gruppo.",
            "Усі разом: кожна група ділиться однією ідеєю. Запиши це на один телефон із тегом «Уся група».",
            "Všichni dohromady: každá skupina sdílí svůj nápad. Nahraj to na jeden telefon se štítkem Celá skupina.",
          ),
        ],
        tips: [TIP.phone],
      },
    },
  },
  // Calm talk in rounds about a hard or charged topic: each person speaks in turn without
  // replies first. "What we heard" keeps every voice; Explore off so nothing interrupts.
  {
    key: "conversation_cafe",
    version: 1,
    card: {
      offer: "card",
      verbs: ["understand"],
      setup: "many_groups",
      sectors: ["public", "networks_events", "internal"],
      method: "Conversation Café",
    },
    preset: {
      fields: { ...MANY_GROUPS },
      name_label: TABLE,
      verification_topics: ["heard"],
      host_guide: {
        title: L(
          "Hosting a calm conversation in rounds",
          "Een rustig gesprek in rondes leiden",
          "Ein ruhiges Gespräch in Runden leiten",
          "Animer une conversation calme en tours",
          "Moderar una conversación tranquila por turnos",
          "Condurre una conversazione calma a turni",
          "Ведення спокійної розмови по колу",
          "Vedení klidného rozhovoru v kolech",
        ),
        steps: [
          L(
            "Type your table name and press Record.",
            "Typ de naam van je tafel en druk op Opname starten.",
            "Gib den Namen deines Tisches ein und tippe auf Aufnehmen.",
            "Saisis le nom de ta table et appuie sur Enregistrer.",
            "Escribe el nombre de tu mesa y pulsa Grabar.",
            "Scrivi il nome del tuo tavolo e premi Record.",
            "Введи назву столу й натисни Record.",
            "Napiš název stolu a stiskni Record.",
          ),
          L(
            "First round: each person speaks in turn, with no replies. Pass an object to the next.",
            "Eerste ronde: iedereen spreekt om de beurt, zonder reacties. Geef een voorwerp door aan de volgende.",
            "Erste Runde: Alle sprechen nacheinander, ohne Antworten. Gebt einen Gegenstand weiter.",
            "Premier tour : chacun parle à son tour, sans réponse. Passez un objet à la personne suivante.",
            "Primera ronda: cada persona habla por turno, sin respuestas. Pasa un objeto a la siguiente.",
            "Primo giro: ognuno parla a turno, senza risposte. Passa un oggetto alla persona successiva.",
            "Перше коло: кожен говорить по черзі, без відповідей. Передавайте предмет наступному.",
            "První kolo: každý mluví popořadě, bez reakcí. Předávejte předmět dalšímu.",
          ),
          L(
            "Second round: in turn again, about what you heard. Then talk freely.",
            "Tweede ronde: weer om de beurt, nu over wat je hoorde. Daarna praten jullie vrij.",
            "Zweite Runde: wieder nacheinander, über das Gehörte. Danach sprecht ihr frei.",
            "Deuxième tour : de nouveau chacun son tour, sur ce que vous avez entendu. Puis parlez librement.",
            "Segunda ronda: otra vez por turnos, sobre lo que habéis oído. Después, conversación libre.",
            "Secondo giro: di nuovo a turno, su quello che avete sentito. Poi parlate liberamente.",
            "Друге коло: знову по черзі, про почуте. Далі розмовляйте вільно.",
            "Druhé kolo: znovu popořadě, o tom, co jste slyšeli. Pak volně.",
          ),
          S.verify,
          S.ask,
          S.revise,
        ],
        tips: [TIP.phone, TIP.pause],
      },
    },
  },
  // Citizens' assemblies, deliberative panels, policy juries and participatory budgeting
  // (merged: the same settings, and the script fits weighing options and budgets alike).
  // Verify or refine: the table check and the differences, so dissent is on the record.
  // Explore and cross-pollination off: a model question must not steer a deliberation.
  {
    key: "citizens_assembly",
    version: 1,
    card: {
      offer: "card",
      verbs: ["decide"],
      setup: "many_groups",
      sectors: ["public"],
    },
    preset: {
      fields: { ...MANY_GROUPS },
      name_label: TABLE,
      tags: [ROUND(1), ROUND(2)],
      verification_topics: ["agreements", "disagreements"],
      host_guide: {
        title: L(
          "Facilitating a table at a citizens' assembly",
          "Een tafel begeleiden bij het burgerberaad",
          "Einen Tisch im Bürgerrat begleiten",
          "Animer une table d'une assemblée citoyenne",
          "Moderar una mesa de una asamblea ciudadana",
          "Facilitare un tavolo di un'assemblea dei cittadini",
          "Фасилітація столу на громадянській асамблеї",
          "Facilitace stolu na občanském shromáždění",
        ),
        steps: [
          L(
            "Type your table name and tap the tag for this round.",
            "Typ de naam van je tafel en tik op de tag van deze ronde.",
            "Gib den Namen deines Tisches ein und tippe auf den Tag dieser Runde.",
            "Saisis le nom de ta table et touche le tag de ce tour.",
            "Escribe el nombre de tu mesa y toca la etiqueta de esta ronda.",
            "Scrivi il nome del tuo tavolo e tocca il tag di questo turno.",
            "Введи назву свого столу й торкнися тегу цього раунду.",
            "Napiš název svého stolu a klepni na štítek tohoto kola.",
          ),
          S.record,
          L(
            "Weigh the options one by one: what speaks for it, what against, and for whom?",
            "Weeg de opties een voor een: wat pleit ervoor, wat ertegen, en voor wie?",
            "Wägt die Optionen einzeln ab: Was spricht dafür, was dagegen, und für wen?",
            "Pesez les options une à une : qu'est-ce qui plaide pour, contre, et pour qui ?",
            "Sopesad las opciones una a una: ¿qué hay a favor, qué en contra y para quién?",
            "Valutate le opzioni una per una: cosa c'è a favore, cosa contro, e per chi?",
            "Зважте варіанти по одному: що за, що проти і для кого?",
            "Zvažte možnosti jednu po druhé: co mluví pro, co proti a pro koho?",
          ),
          S.verify,
          L(
            "Ask: is our disagreement in there too, not only what we agree on?",
            "Vraag: staat ook ons verschil van mening erin, niet alleen waar we het over eens zijn?",
            "Frag: Steht auch unsere Uneinigkeit drin, nicht nur, worin wir uns einig sind?",
            "Demande : notre désaccord y figure-t-il aussi, pas seulement ce sur quoi nous sommes d'accord ?",
            "Pregunta: ¿está también nuestro desacuerdo, no solo en lo que coincidimos?",
            "Chiedi: c'è anche il nostro disaccordo, non solo ciò su cui siamo d'accordo?",
            "Запитай: чи є тут і наші розбіжності, а не лише те, у чому ми згодні?",
            "Zeptej se: je tam i náš nesouhlas, nejen to, na čem se shodneme?",
          ),
          S.revise,
        ],
        tips: [TIP.oneVoice, TIP.phone, TIP.pause],
      },
    },
  },
  // Conference breakouts and talks, one phone per session: ideas worth keeping, and the
  // question may bring in what other sessions heard (cross-pollination on: connecting
  // sessions is the point). The name box asks for the session title; no tags.
  {
    key: "conference",
    version: 1,
    card: {
      offer: "card",
      verbs: ["gather"],
      setup: "many_groups",
      sectors: ["networks_events"],
    },
    preset: {
      fields: {
        ...MANY_GROUPS,
        ...EXPLORE_ONE_QUESTION,
        is_get_reply_cross_pollination_enabled: true,
      },
      name_label: SESSION_TITLE,
      verification_topics: ["gems"],
      host_guide: {
        title: L(
          "Capturing a conference session",
          "Een congressessie vastleggen",
          "Eine Konferenz-Session festhalten",
          "Capturer une session de conférence",
          "Recoger una sesión de un congreso",
          "Raccogliere una sessione di conferenza",
          "Запис сесії конференції",
          "Zachycení sekce konference",
        ),
        steps: [
          L(
            "Type the session title and press Record when the discussion starts.",
            "Typ de titel van de sessie en druk op Opname starten als het gesprek begint.",
            "Gib den Titel der Session ein und tippe auf Aufnehmen, wenn das Gespräch beginnt.",
            "Saisis le titre de la session et appuie sur Enregistrer quand la discussion commence.",
            "Escribe el título de la sesión y pulsa Grabar cuando empiece la conversación.",
            "Scrivi il titolo della sessione e premi Record quando inizia la discussione.",
            "Введи назву сесії й натисни Record, коли почнеться обговорення.",
            "Napiš název sekce a stiskni Record, když začne diskuse.",
          ),
          L(
            "Keep the phone close to whoever speaks. It works best for the discussion part.",
            "Houd de telefoon dicht bij wie er praat. Het werkt het best voor het gesprek.",
            "Halte das Telefon nah an der Person, die spricht. Am besten klappt es beim Gespräch.",
            "Garde le téléphone près de la personne qui parle. Cela marche le mieux pour la discussion.",
            "Mantén el teléfono cerca de quien habla. Funciona mejor en la parte de conversación.",
            "Tieni il telefono vicino a chi parla. Funziona meglio durante la discussione.",
            "Тримай телефон ближче до того, хто говорить. Найкраще це працює для обговорення.",
            "Drž telefon u toho, kdo mluví. Nejlépe to funguje při diskusi.",
          ),
          L(
            "Questions dry up? Press ECHO, then Explore: the question can bring in other sessions.",
            "Vallen de vragen stil? Druk op ECHO, dan op Verkennen: de vraag kan andere sessies meenemen.",
            "Keine Fragen mehr? Tippe auf ECHO, dann auf Erkunden: Die Frage kann andere Sessions einbeziehen.",
            "Plus de questions ? Appuie sur ECHO, puis sur Explorer : la question peut reprendre d'autres sessions.",
            "¿Se acaban las preguntas? Pulsa ECHO, luego Explorar: la pregunta puede traer otras sesiones.",
            "Finite le domande? Premi ECHO, poi Explore: la domanda può riprendere altre sessioni.",
            "Питання скінчилися? Натисни ECHO, потім Explore: питання може підхопити інші сесії.",
            "Došly otázky? Stiskni ECHO, pak Explore: otázka může přinést jiné sekce.",
          ),
          S.verifyOr,
          S.revise,
        ],
        tips: [TIP.pause],
      },
    },
  },
] as const;

// The first registry (ECHO-1042), by logistics. Still valid for the API and for projects
// made with them; v2 marks them as offered nowhere (upload and blank are the quiet links).
// Settings are unchanged; the version moves with the registry.
const LOGISTIC_TEMPLATES = [
  {
    key: "conversation",
    version: 2,
    card: { offer: "none", setup: "one_recording" },
    preset: {
      fields: {
        ...WIZARD_DEFAULTS,
        default_conversation_ask_for_participant_name: false,
        enable_ai_title_and_tags: true,
      },
    },
  },
  {
    key: "series",
    version: 2,
    card: { offer: "none", setup: "one_recording" },
    preset: { fields: { ...WIZARD_DEFAULTS, enable_ai_title_and_tags: true } },
  },
  {
    key: "event",
    version: 2,
    card: { offer: "none", setup: "many_groups" },
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
    },
  },
  // Existing recordings: the host lands on upload, each file gets a title.
  {
    key: "upload",
    version: 2,
    card: { offer: "link", setup: "one_recording" },
    preset: {
      fields: { ...WIZARD_DEFAULTS, enable_ai_title_and_tags: true },
      landing: "upload",
    },
  },
  {
    key: "blank",
    version: 2,
    card: { offer: "link", setup: "one_recording" },
    preset: { fields: { ...WIZARD_DEFAULTS } },
  },
] as const;

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  ...PURPOSE_TEMPLATES,
  ...LOGISTIC_TEMPLATES,
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

/** A stored project language as a template language: i18n's resolveLocale, English for any other. */
const languageOf = (language: string | null | undefined): TemplateLanguage =>
  resolveLocale(language).slice(0, 2) as TemplateLanguage;

const pick = (text: Localized, language: string | null | undefined): string =>
  text[languageOf(language)];

/**
 * The portal's button names in each language (the participant catalogs' Verify, Explore,
 * Revise, Approve, Record, Stop, Resume and Finish), longest first: the host guide shows
 * the ones a step names in the action colour.
 */
const BUTTON_WORDS: Record<TemplateLanguage, readonly string[]> = {
  en: ["ECHO", "Verify", "Explore", "Revise", "Approve"],
  nl: [
    "ECHO",
    "Opname starten",
    "Verifiëren",
    "Verkennen",
    "Aanpassen",
    "Goedkeuren",
    "Hervatten",
    "Afronden",
    "Stop",
  ],
  de: [
    "ECHO",
    "Verifizieren",
    "Erkunden",
    "Überarbeiten",
    "Freigeben",
    "Aufnehmen",
    "Beenden",
    "Fortsetzen",
  ],
  fr: [
    "ECHO",
    "Vérifier",
    "Explorer",
    "Réviser",
    "Approuver",
    "Enregistrer",
    "Arrêter",
    "Reprendre",
    "Terminer",
  ],
  es: [
    "ECHO",
    "Verificar",
    "Explorar",
    "revisar",
    "aprobar",
    "Grabar",
    "Detener",
    "Reanudar",
    "Finalizar",
  ],
  it: ["ECHO", "Verify", "Explore", "Revise", "Approve", "Record", "Stop", "Resume", "Finish"],
  uk: ["ECHO", "Verify", "Explore", "Revise", "Approve", "Record", "Stop", "Resume", "Finish"],
  cs: ["ECHO", "Verify", "Explore", "Revise", "Approve", "Record", "Stop", "Resume", "Finish"],
};

/** One step or tip as the host guide page stores it: the text, and the words it colours. */
export const hostGuideItem = (text: string, language: string | null | undefined) =>
  guideItem(text, languageOf(language));

const guideItem = (text: string, language: TemplateLanguage) => ({
  content: text,
  highlights: BUTTON_WORDS[language].filter((w) => text.includes(w)),
});

/**
 * The project.host_guide a template writes, in the shape HostGuidePage reads and edits:
 * `language` is the project language's two letters (the page shows a stored guide only for
 * that language), the words fall back to English for a language without its own.
 */
export function templateHostGuide(t: ProjectTemplate, language: string | null | undefined) {
  const g = t.preset.host_guide;
  if (!g) return null;
  const lang = languageOf(language);
  const stored = (language ?? "en").toLowerCase().slice(0, 2) || "en";
  return {
    language: stored,
    title: g.title[lang],
    steps: g.steps.map((s) => guideItem(s[lang], lang)),
    tips: g.tips.map((s) => guideItem(s[lang], lang)),
  };
}

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
  const guide = templateHostGuide(t, language);
  return {
    ...set,
    ...(name_label && { conversation_ask_for_participant_name_label: pick(name_label, language) }),
    ...(verification_topics.length && {
      selected_verification_key_list: verification_topics.join(","),
    }),
    ...(guide && { host_guide: guide }),
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
 * without its preset (host guide included).
 */
export async function applyProjectTemplate(
  store: ProjectsStorage,
  c: {
    projectId: string;
    template: ProjectTemplate;
    language: string | null;
    now: string;
    /** Accepted proposals, written over the preset in the same update. */
    overrides?: PresetOverrides | null;
    /** Tags in place of the template's (the context digest's rounds, ECHO-1055). */
    tags?: readonly string[] | null;
  },
) {
  await store.updateProject(c.projectId, {
    ...templateColumns(c.template, c.language),
    ...overridesOver(c.template, c.overrides),
    updated_at: c.now,
  });
  await store.insertTags(
    (c.tags?.length ? c.tags : templateTags(c.template, c.language)).map((text, i) => ({
      id: newId(),
      project_id: c.projectId,
      text,
      sort: i + 1,
      created_at: c.now,
    })),
  );
}

const definedFields = (o: PresetOverrides | null | undefined): ProjectColumns =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as ProjectColumns;

/** Overrides that change something: one equal to the template's own value is dropped. */
export function overridesOver(
  t: ProjectTemplate,
  o: PresetOverrides | null | undefined,
): ProjectColumns {
  const preset = t.preset.fields as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(definedFields(o)).filter(([k, v]) => preset[k] !== v),
  ) as ProjectColumns;
}

/**
 * Overrides as a create request carries them: only preset fields, each with a value its
 * field accepts. Anything else is a 422 naming the field, before anything is written.
 */
export function parseOverrides(raw: unknown): PresetOverrides | null {
  if (raw === null || raw === undefined) return null;
  const parsed = PresetFields.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw invalidBodyField("overrides", raw, parsed.error);
}

/** Overrides on a project that starts bare (no template_key): the same columns, no preset. */
export async function applyOverrides(
  store: ProjectsStorage,
  c: { projectId: string; overrides: PresetOverrides; now: string },
) {
  const set = definedFields(c.overrides);
  if (Object.keys(set).length)
    await store.updateProject(c.projectId, { ...set, updated_at: c.now });
}

/**
 * What a template sets up and how the picker offers it, as data for the cards and "What
 * this sets up", so the wording stays in the frontend and the facts stay with the preset.
 * The participant-facing words (name box label, tags, host guide title) come in the
 * language asked for, English when it has none of its own.
 */
export function templateSummary(t: ProjectTemplate, language?: string | null) {
  const f = t.preset.fields;
  const tutorial = (f.default_conversation_tutorial_slug ?? "None").toLowerCase();
  const explore = f.is_get_reply_enabled ?? false;
  return {
    key: t.key,
    version: t.version,
    landing: t.preset.landing,
    card: {
      offer: t.card.offer,
      verbs: t.card.verbs,
      setup: t.card.setup,
      sectors: t.card.sectors,
      featured: t.card.featured,
      method: t.card.method ?? null,
    },
    summary: {
      asks_for_name: f.default_conversation_ask_for_participant_name ?? true,
      asks_for_group_name: Boolean(t.preset.name_label),
      name_label: t.preset.name_label ? pick(t.preset.name_label, language) : null,
      tutorial: tutorial as "none" | "basic" | "advanced",
      verify: f.is_verify_enabled ?? false,
      verify_on_finish: f.is_verify_on_finish_enabled ?? false,
      verification_topics: t.preset.verification_topics,
      explore,
      explore_mode: explore ? (f.get_reply_mode ?? "summarize") : null,
      cross_pollination: f.is_get_reply_cross_pollination_enabled ?? false,
      auto_titles: f.enable_ai_title_and_tags ?? false,
      tag_count: t.preset.tags.length,
      tags: templateTags(t, language),
      host_guide_title: t.preset.host_guide ? pick(t.preset.host_guide.title, language) : null,
    },
  };
}
export type TemplateSummary = ReturnType<typeof templateSummary>;

export function listProjectTemplates(language?: string | null) {
  return { templates: PROJECT_TEMPLATES.map((t) => templateSummary(t, language)) };
}
