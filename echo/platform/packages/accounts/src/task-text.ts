import type { Language } from "./offer";

/**
 * The words of the tasks echo creates, for the places the server itself writes to a
 * person: reminder emails and Slack. The API returns these tasks as a code and params and
 * the UI words them the same way in the viewer's language.
 */

export const TASK_CODES = ["sign_offer", "billing_details", "sign_dpa"] as const;
export type TaskCode = (typeof TASK_CODES)[number];
export type TaskParams = Readonly<Record<string, string>>;

const TEXT: Record<
  TaskCode,
  Record<Language, { title: (p: TaskParams) => string; body: string }>
> = {
  sign_offer: {
    en: {
      title: (p) =>
        p.document_title
          ? `Review and sign the offer: ${p.document_title}`
          : "Review and sign the offer",
      body: "Read the offer and sign it here. Someone else signs for your organisation? Name them on the offer and they get their own link.",
    },
    nl: {
      title: (p) =>
        p.document_title
          ? `Offerte bekijken en ondertekenen: ${p.document_title}`
          : "Offerte bekijken en ondertekenen",
      body: "Lees de offerte en onderteken hem hier. Tekent iemand anders voor jullie organisatie? Wijs diegene aan op de offerte; die krijgt een eigen link.",
    },
  },
  billing_details: {
    en: {
      title: () => "Billing details",
      body: "Who we invoice: legal name, address, VAT or KvK number, billing email and, if you use one, your PO number. It opens once the offer is signed.",
    },
    nl: {
      title: () => "Factuurgegevens",
      body: "Aan wie we factureren: juridische naam, adres, btw- of KvK-nummer, factuur-e-mail en, als jullie die gebruiken, het PO-nummer. Deze stap opent zodra de offerte is ondertekend.",
    },
  },
  sign_dpa: {
    en: {
      title: () => "Have the data processing agreement signed",
      body: "The person who signed the offer may not agree to data processing for your organisation. Someone authorised to (article 3.6 of the terms) signs the data processing agreement here; you can name them on the document.",
    },
    nl: {
      title: () => "Laat de verwerkersovereenkomst ondertekenen",
      body: "Wie de offerte tekende mag geen verwerkingsafspraken maken voor jullie organisatie. Iemand die dat wel mag (artikel 3.6 van de voorwaarden) ondertekent hier de verwerkersovereenkomst; je kunt diegene op het document aanwijzen.",
    },
  },
};

export const isTaskCode = (v: unknown): v is TaskCode =>
  typeof v === "string" && (TASK_CODES as readonly string[]).includes(v);

/** A task's title in a language: its own title, or its code worded. */
export function taskTitle(
  t: { code: string | null; params: unknown; title: string | null },
  language: Language,
): string {
  if (isTaskCode(t.code)) return TEXT[t.code][language].title((t.params ?? {}) as TaskParams);
  return t.title ?? "";
}

export function taskBody(
  t: { code: string | null; body: string | null },
  language: Language,
): string | null {
  return isTaskCode(t.code) ? TEXT[t.code][language].body : t.body;
}

/** "nl-NL", "nl" or a Dutch org as Dutch; anything else English. */
export const languageOf = (v: string | null | undefined): Language =>
  (v ?? "").toLowerCase().startsWith("nl") ? "nl" : "en";
