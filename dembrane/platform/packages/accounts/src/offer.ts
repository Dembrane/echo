import { type BillTo, billToLines } from "./bill-to";
import { dutchDate } from "./legal/parse";
import {
  charged,
  type OfferLine,
  type PricedLine,
  priceLines,
  type Totals,
  type VatTreatment,
} from "./money";

/**
 * The words of an offer, from the Google Doc templates of sales (packages/accounts/reference:
 * subscription and event, English and Dutch) rewritten in dembrane's voice: the kind of
 * offer over the customer's name, the facts (reference, date, valid until), a greeting, the
 * lines table, subtotal, VAT and total, any amendments, the closing, the acceptance and the
 * incorporation clause naming the documents that apply to this kind of offer, and its
 * amendments. The clause keeps the templates' legal wording word for word.
 * The template and the language choose the words; every offer has the same look (offer-pdf.ts).
 * The same structure feeds the text the customer reads (and the sha256 binds) and the PDF.
 * Versions and dates of the legal texts always come from the pinned rows, never from here.
 */

/**
 * A subscription (a yearly licence), a single event, or a custom offer: one that does not fit
 * the other two, and the only kind that may carry amendments to the standard documents.
 */
export const OFFER_TEMPLATES = ["subscription", "event", "custom"] as const;
export type OfferTemplate = (typeof OFFER_TEMPLATES)[number];
export const BILLING_UNITS = ["seat", "month"] as const;
export type BillingUnit = (typeof BILLING_UNITS)[number];
export const LANGUAGES = ["en", "nl"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface OfferItem extends OfferLine {
  /** The bulleted lines under the description ("Unlimited recording hours"). */
  readonly bullets: readonly string[];
  /** What the quantity counts, next to it in the table: "12 months", "8 hours". */
  readonly unit?: string | undefined;
}

/**
 * The words of an offer that staff and sam may change: a template's defaults (the
 * offer_template row, else DEFAULT_TEXT), copied into each offer when it is drafted and
 * changed there for that customer alone. Sending freezes them with the PDF.
 */
export interface OfferText {
  /** Above the customer's name, and the document's name with its number: "Offer", "Offerte". */
  readonly kind: string;
  /** The word before the person's name: "Hi", "Dear", "Beste". */
  readonly greeting: string;
  /** Paragraphs separated by a blank line; one that starts with "## " is a heading. */
  readonly intro: string;
  /** One line each; an empty line leaves space above the next ("Best regards,"). */
  readonly closing: string;
  /** Description, quantity, unit price, amount. */
  readonly columns: readonly [string, string, string, string];
}

/** A template's words and how many days its offers stay valid. */
export interface OfferTemplateText extends OfferText {
  readonly valid_days: number;
}

export interface PinnedText {
  readonly version: string;
  readonly effective_on: string | null;
  readonly url: string;
}

/** dembrane's letterhead as the offer carries it. */
export interface Letterhead {
  readonly name: string;
  readonly address: string;
  readonly vat: string;
  readonly kvk: string;
  readonly iban: string;
  readonly bic: string;
}

export type FieldKind = "signature" | "initials" | "name" | "role" | "date" | "text" | "checkbox";

/** One blank of the acceptance block: the words before it and the field it becomes. */
export interface AcceptanceField {
  readonly prefix: string;
  readonly kind: FieldKind;
  readonly key: string | null;
  readonly label: string;
  readonly required: boolean;
}

export interface Acceptance {
  readonly fields: readonly AcceptanceField[];
  readonly statement: string;
  readonly signing: readonly AcceptanceField[];
}

export interface OfferContent {
  readonly template: OfferTemplate;
  readonly language: Language;
  /** Who the offer is for: the name under "Event offer" on the PDF's first page. */
  readonly offer_name: string;
  /** ISO date the offer was made; validity counts from here. */
  readonly date: string;
  readonly reference: string;
  /** Who the greeting names. */
  readonly person_name: string | null;
  /** "T.a.v." on event offers. */
  readonly attention: string | null;
  readonly currency: string;
  readonly valid_days: number;
  readonly company: Letterhead;
  readonly legal: {
    readonly terms: PinnedText;
    readonly sla: PinnedText;
    readonly dpa: PinnedText;
  };
  readonly items: readonly OfferItem[];
  /**
   * The offer's own words. Absent on offers drafted before templates were data: those keep
   * their template's words and columns from COPY until they are saved again.
   */
  readonly text?: OfferText;
  /** Absent on offers made before it existed: Dutch VAT on the lines. */
  readonly vat_treatment?: VatTreatment;
  /** Subscription offers: what the quantity counts. Absent means seats, as before it existed. */
  readonly billing_unit?: BillingUnit;
  /** Custom offers only: numbered terms that take precedence over the standard documents. */
  readonly amendments?: readonly Amendment[];
  /**
   * True on offers whose DPA is its own document, sent with the offer. Absent on offers made
   * before: there the signer said whether they may also agree to data processing.
   */
  readonly dpa_separate?: boolean;
  /**
   * The customer's own terms for data processing, listed in place of our DPA: the offer is
   * all they sign, and no DPA of its own is sent.
   */
  readonly processing_terms?: string;
  /**
   * The customer's purchase order or reference for this offer, printed beside ours. The
   * signer may confirm or change it; their value goes on the invoice.
   */
  readonly customer_reference?: string;
  /**
   * Who is invoiced when it is not the customer, printed as "Invoiced to" so the customer
   * sees it before signing; the invoice request carries it in place of their billing details.
   */
  readonly bill_to?: BillTo;
}

/** A term staff agree with one customer, in the offer's language. */
export interface Amendment {
  /** What it changes, in a few words: "Liability cap". */
  readonly title: string;
  /** The term itself; paragraphs separated by a blank line. */
  readonly body: string;
}

interface Copy {
  readonly facts: {
    readonly reference: string;
    readonly date: string;
    readonly validUntil: string;
    readonly attention: string;
    readonly customerReference: string;
  };
  readonly greeting: string;
  readonly intro: readonly string[];
  readonly columns: readonly [string, string, string, string];
  /** Subscription offers billed per month instead of per seat. */
  readonly monthColumns?: readonly [string, string, string, string];
  readonly totals: { readonly subtotal: string; readonly vat: string; readonly total: string };
  /** The amount cell of a line included at no charge. */
  readonly included: string;
  /** The block of optional lines under the totals: its heading and the line under it. */
  readonly optional: { readonly title: string; readonly note: string };
  /** The party invoiced in place of the customer: its heading and the words on its lines. */
  readonly billTo: { readonly title: string; readonly reference: string };
  /** Why there is no VAT, in the words the invoice uses. */
  readonly vatNote: Record<Exclude<VatTreatment, "standard">, string>;
  readonly closing: readonly string[];
  readonly acceptanceTitle: string;
  readonly acceptanceIntro: string;
  readonly acceptance: Acceptance;
  readonly amendmentsTitle: string;
  readonly words: ClauseWords;
  readonly months: readonly string[];
}

const blank = "____________________";
const ver = (t: PinnedText, sep: string) => `${t.version}${sep}${dutchDate(t.effective_on)}`;

/**
 * A piece of a clause line. The templates link the name of each legal text and underline a
 * few words; plain text cannot, so there the address follows the version in words.
 */
export type ClausePart =
  | string
  | { readonly link: string; readonly url: string }
  | { readonly underline: string }
  | { readonly textOnly: string };
export type ClauseLine = readonly ClausePart[];

const linked = (name: string, t: PinnedText): ClausePart => ({ link: name, url: t.url });
const address = (t: PinnedText): ClausePart => ({ textOnly: `, ${t.url}` });

/** A clause line as plain text: links by their words, the address after the version. */
export function clauseText(line: ClauseLine): string {
  return line
    .map((p) =>
      typeof p === "string"
        ? p
        : "link" in p
          ? p.link
          : "underline" in p
            ? p.underline
            : p.textOnly,
    )
    .join("");
}
/** A field as the offer asks for it: its label over a line to write on. */
const f = (
  label: string,
  kind: FieldKind,
  key: string | null = null,
  required = true,
): AcceptanceField => ({ prefix: label, kind, key, label, required });

// The acceptance fields of each template. The templates ask for no role; a role field is
// added because the signature record and its confirmation name it.
const EN_SIGNING = [f("Date", "date"), f("Signature", "signature")];
const NL_SIGNING = [f("Datum", "date"), f("Handtekening", "signature")];

/** The incorporation clause: its opening, the numbered documents, the closing lines. */
export interface Clause {
  readonly opening: string;
  readonly items: readonly ClauseLine[];
  readonly closing: readonly string[];
}

/** The words of the clause in one template and language; which documents apply is computed. */
interface ClauseWords {
  readonly opening: string;
  readonly offer: string;
  /** "The" and "of dembrane B.V." around the linked name of the terms. */
  readonly terms: readonly [string, string, string];
  /** "Annex", "Appendix", "Bijlage". */
  readonly annex: string;
  readonly sla: string;
  readonly dpa: string;
  readonly version: string;
  /** "Amendment", "Aanvulling". */
  readonly amendment: string;
  /** After an amendment's title: where its text is. */
  readonly amendmentWhere: string;
  /** The DPA is its own document; this offer does not sign it. */
  readonly dpaSeparate: string;
  /** An amendment wins over the documents above it. */
  readonly amendmentsFirst: string;
  readonly precedence: string;
  readonly received: string;
}

const EN_DPA_SEPARATE =
  "The Data Processing Agreement is signed separately, by someone authorised to enter into data processing arrangements on behalf of the organisation; this offer does not sign it. The Agreement is complete only once the Data Processing Agreement is signed too (art. 3.6 of the General Terms and Conditions).";
const EN_AMENDMENTS_FIRST =
  "Where an amendment in this offer differs from the documents listed above, the amendment applies.";

const EN_SUB_WORDS: ClauseWords = {
  opening:
    "By signing this offer, you also declare that you have read and agree to the following documents, which together constitute the Agreement:",
  offer: "This order confirmation/offer",
  terms: ["The ", "General Terms and Conditions", " of dembrane B.V."],
  annex: "Annex",
  sla: "Service Level Agreement",
  dpa: "Data Processing Agreement",
  version: "version",
  amendment: "Amendment",
  amendmentWhere: ", as set out in this offer",
  dpaSeparate: EN_DPA_SEPARATE,
  amendmentsFirst: EN_AMENDMENTS_FIRST,
  precedence:
    "In the event of any conflict, the order of precedence as set out in article 2.4 of the General Terms and Conditions shall apply.",
  received:
    "By signing, you declare that you have received the above documents or are able to access them via the links provided.",
};

const EN_EVENT_WORDS: ClauseWords = {
  ...EN_SUB_WORDS,
  opening:
    "By signing this offer, you declare that you have received knowledge of and agree with the following documents, which together form the Agreement:",
  offer: "This work order/offer",
  annex: "Appendix",
  precedence:
    "In case of conflict, the hierarchy as determined in article 2.4 of the General Terms and Conditions applies.",
  received:
    "By signing, you declare that you have received the aforementioned documents or can consult them via the above links.",
};

const NL_WORDS: ClauseWords = {
  opening:
    "Met de ondertekening van deze offerte verklaart u tevens kennis te hebben genomen van en akkoord te gaan met de volgende documenten, die tezamen de Overeenkomst vormen:",
  offer: "Deze opdrachtbevestiging/offerte",
  terms: ["De ", "Algemene Voorwaarden", " van dembrane B.V."],
  annex: "Bijlage",
  sla: "Service Level Agreement",
  dpa: "Verwerkersovereenkomst",
  version: "versie",
  amendment: "Aanvulling",
  amendmentWhere: ", zoals opgenomen in deze offerte",
  dpaSeparate:
    "De Verwerkersovereenkomst wordt apart ondertekend, door iemand die namens de organisatie verwerkingsafspraken mag aangaan; deze offerte ondertekent die niet. De Overeenkomst is pas volledig als ook de Verwerkersovereenkomst is ondertekend (art. 3.6 van de Algemene Voorwaarden).",
  amendmentsFirst:
    "Waar een aanvulling in deze offerte afwijkt van de hierboven genoemde documenten, geldt de aanvulling.",
  precedence:
    "In geval van strijdigheid geldt de rangorde zoals bepaald in artikel 2.4 van de Algemene Voorwaarden.",
  received:
    "Door ondertekening verklaart u bovengenoemde documenten te hebben ontvangen dan wel via de bovenstaande links te kunnen raadplegen.",
};

/** The standard documents an offer of this kind incorporates: an event has no SLA. */
export function legalKinds(template: OfferTemplate): readonly ("terms" | "sla" | "dpa")[] {
  return template === "event" ? ["terms", "dpa"] : ["terms", "sla", "dpa"];
}

/**
 * The clause of one offer: the offer, the terms, the annexes that apply lettered in order,
 * the customer's own processing terms where they replace our DPA, then each amendment by
 * number. Our DPA is named but signed on its own.
 */
function buildClause(w: ClauseWords, content: OfferContent): Clause {
  const l = content.legal;
  const kinds = legalKinds(content.template);
  const amendments = content.amendments ?? [];
  const version = (t: PinnedText): ClausePart[] => [
    ` (${w.version} ${ver(t, ", ")}`,
    address(t),
    ")",
  ];
  const own = content.processing_terms;
  const annexes = (["sla", "dpa"] as const).filter(
    (k) => kinds.includes(k) && !(k === "dpa" && own),
  );
  const lines: ClausePart[][] = [
    [w.offer],
    [w.terms[0], linked(w.terms[1], l.terms), w.terms[2], ...version(l.terms)],
    ...annexes.map((k, i) => [
      `${w.annex} ${String.fromCharCode(65 + i)}: `,
      linked(k === "sla" ? w.sla : w.dpa, l[k]),
      ...version(l[k]),
    ]),
    ...(own ? [[own]] : []),
    ...amendments.map((a, i) => [`${w.amendment} ${i + 1}: ${a.title}${w.amendmentWhere}`]),
  ];
  const items = lines.map((line, i) => [...line, i === lines.length - 1 ? "." : ";"]);
  return {
    opening: w.opening,
    items,
    closing: [
      ...(own ? [] : [w.dpaSeparate]),
      ...(amendments.length ? [w.amendmentsFirst] : []),
      w.precedence,
      w.received,
    ],
  };
}

const EN_ACCEPT: Acceptance = {
  fields: [
    f("Name", "name"),
    f("Organisation", "text", "organisation"),
    f("Address", "text", "address"),
    f("Role", "role"),
    f("Your reference (PO number)", "text", "po_number", false),
  ],
  statement:
    "By signing, the person named below accepts this offer on behalf of the organisation named below.",
  signing: EN_SIGNING,
};

const NL_ACCEPT = (withVat: boolean): Acceptance => ({
  fields: [
    f("Naam", "name"),
    f("Organisatie", "text", "organisation"),
    f("Adres", "text", "address"),
    ...(withVat ? [f("Btw-nummer", "text", "vat_number", false)] : []),
    f("Functie", "role"),
    f("Uw referentie (inkoopnummer)", "text", "po_number", false),
  ],
  statement:
    "Met ondertekening aanvaardt de hieronder genoemde persoon deze offerte namens de hieronder genoemde organisatie.",
  signing: NL_SIGNING,
});

const EN_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const NL_MONTHS = [
  "januari",
  "februari",
  "maart",
  "april",
  "mei",
  "juni",
  "juli",
  "augustus",
  "september",
  "oktober",
  "november",
  "december",
];

const EN_FRAME = {
  facts: {
    reference: "Reference",
    date: "Date",
    validUntil: "Valid until",
    attention: "For the attention of",
    customerReference: "Your reference",
  },
  totals: { subtotal: "Subtotal (excl. VAT)", vat: "VAT", total: "Total (incl. VAT)" },
  included: "Included",
  optional: { title: "Optional", note: "Not in the total above." },
  billTo: { title: "Invoiced to", reference: "Reference" },
  vatNote: {
    reverse_charge: "VAT reverse-charged: Article 196, Directive 2006/112/EC.",
    outside_eu:
      "No Dutch VAT: the service is supplied outside the EU (Article 44, Directive 2006/112/EC).",
  },
  amendmentsTitle: "Amendments to the standard documents",
  acceptanceTitle: "Accept this offer",
  // The e-signing clause sits where the reader signs.
  acceptanceIntro:
    "To accept this offer, fill in the fields below and sign electronically. The parties agree that this signature binds them as a handwritten one would (article 3:15a of the Dutch Civil Code).",
  acceptance: EN_ACCEPT,
  months: EN_MONTHS,
};
const NL_FRAME = {
  facts: {
    reference: "Referentie",
    date: "Datum",
    validUntil: "Geldig tot",
    attention: "T.a.v.",
    customerReference: "Uw referentie",
  },
  totals: { subtotal: "Subtotaal (excl. btw)", vat: "Btw", total: "Totaal (incl. btw)" },
  included: "Inbegrepen",
  optional: { title: "Optioneel", note: "Niet in het totaal hierboven." },
  billTo: { title: "Factuur aan", reference: "Referentie" },
  vatNote: {
    reverse_charge: "Btw verlegd: artikel 196, Richtlijn 2006/112/EG.",
    outside_eu:
      "Geen Nederlandse btw: de dienst wordt buiten de EU verricht (artikel 44, Richtlijn 2006/112/EG).",
  },
  amendmentsTitle: "Aanvullingen op de standaarddocumenten",
  acceptanceTitle: "Offerte accepteren",
  acceptanceIntro:
    "Vul de velden hieronder in en onderteken elektronisch om deze offerte te accepteren. Partijen komen overeen dat die handtekening hen bindt zoals een handgeschreven handtekening (artikel 3:15a BW).",
  months: NL_MONTHS,
};

// The frame of each template and language. Its greeting, intro, columns and closing are what
// offers drafted before OfferText printed (legacyText); new offers take DEFAULT_TEXT.
const COPY: Record<OfferTemplate, Record<Language, Copy>> = {
  subscription: {
    en: {
      ...EN_FRAME,
      greeting: "Hi",
      intro: [
        "Here is what your dembrane subscription includes and what it costs. If anything is unclear, ask us; we are happy to talk it through.",
      ],
      columns: ["Description", "Price per seat per month", "Seats", "Amount"],
      monthColumns: ["Description", "Price per month", "Months", "Amount"],
      closing: ["We look forward to working with you.", "Best regards,", "Team dembrane"],
      words: EN_SUB_WORDS,
    },
    nl: {
      ...NL_FRAME,
      greeting: "Beste",
      intro: [
        "Hieronder staat wat het dembrane-abonnement inhoudt en wat het kost. Is iets niet duidelijk? Vraag het ons gerust; we lichten het graag toe.",
      ],
      columns: ["Omschrijving", "Prijs per seat per maand", "Seats", "Bedrag"],
      monthColumns: ["Omschrijving", "Prijs per maand", "Maanden", "Bedrag"],
      closing: ["We kijken uit naar de samenwerking.", "Met vriendelijke groet,", "Team dembrane"],
      acceptance: NL_ACCEPT(true),
      words: NL_WORDS,
    },
  },
  event: {
    en: {
      ...EN_FRAME,
      greeting: "Dear",
      intro: [
        "Here is our offer for using dembrane at your event.",
        "What dembrane does",
        "dembrane is a tech-for-good company from Eindhoven. During your event, participants share their input in an accessible, digital way; that input is visible and ready to analyse straight away, and we report on it quickly, alongside your usual methods.",
      ],
      columns: ["Description", "Quantity", "Unit price", "Amount"],
      closing: ["We look forward to working with you.", "Kind regards,", "Team dembrane"],
      words: EN_EVENT_WORDS,
    },
    nl: {
      ...NL_FRAME,
      greeting: "Beste",
      intro: [
        "Hierbij onze offerte om dembrane in te zetten op jullie evenement.",
        "Wat dembrane doet",
        "dembrane is een tech-for-good-bedrijf uit Eindhoven. Tijdens het evenement delen deelnemers hun input op een laagdrempelige, digitale manier; die input is direct zichtbaar en analyseerbaar, en we rapporteren er snel over, als aanvulling op jullie gebruikelijke methoden.",
      ],
      columns: ["Omschrijving", "Aantal", "Prijs per stuk", "Bedrag"],
      closing: ["We kijken uit naar de samenwerking.", "Met vriendelijke groet,", "Team dembrane"],
      acceptance: NL_ACCEPT(false),
      words: NL_WORDS,
    },
  },
  custom: {
    en: {
      ...EN_FRAME,
      greeting: "Dear",
      intro: [
        "Here is our offer, put together for what we agreed with you. If anything is unclear, ask us; we are happy to talk it through.",
      ],
      columns: ["Description", "Quantity", "Unit price", "Amount"],
      closing: ["We look forward to working with you.", "Kind regards,", "Team dembrane"],
      words: EN_SUB_WORDS,
    },
    nl: {
      ...NL_FRAME,
      greeting: "Beste",
      intro: [
        "Hieronder staat ons aanbod, afgestemd op wat we met jullie hebben afgesproken. Is iets niet duidelijk? Vraag het ons gerust; we lichten het graag toe.",
      ],
      columns: ["Omschrijving", "Aantal", "Prijs per stuk", "Bedrag"],
      closing: ["We kijken uit naar de samenwerking.", "Met vriendelijke groet,", "Team dembrane"],
      acceptance: NL_ACCEPT(true),
      words: NL_WORDS,
    },
  },
};

const EN_COLUMNS = ["Description", "Quantity", "Unit price", "Amount"] as const;
const NL_COLUMNS = ["Omschrijving", "Aantal", "Prijs per stuk", "Bedrag"] as const;
const EN_ASK = "If anything is unclear, ask us; we are happy to talk it through.";
const NL_ASK = "Is iets niet duidelijk? Vraag het ons gerust; we lichten het graag toe.";

/**
 * The words a template gives a new offer while it has no offer_template row. Every template
 * opens the same way, with what the offer includes and what it costs, and has the same table;
 * the template itself only decides these defaults and which legal documents apply.
 */
export const DEFAULT_TEXT: Record<OfferTemplate, Record<Language, OfferTemplateText>> = {
  subscription: {
    en: {
      kind: "Yearly license offer",
      greeting: "Hi",
      intro: `Here is what your dembrane subscription includes and what it costs. ${EN_ASK}`,
      closing: "We look forward to working with you.\n\nBest regards,\nTeam dembrane",
      columns: EN_COLUMNS,
      valid_days: 14,
    },
    nl: {
      kind: "Offerte jaarlicentie",
      greeting: "Beste",
      intro: `Hieronder staat wat het dembrane-abonnement inhoudt en wat het kost. ${NL_ASK}`,
      closing: "We kijken uit naar de samenwerking.\n\nMet vriendelijke groet,\nTeam dembrane",
      columns: NL_COLUMNS,
      valid_days: 14,
    },
  },
  event: {
    en: {
      kind: "Event offer",
      greeting: "Dear",
      intro: `Here is what dembrane at your event includes and what it costs. ${EN_ASK}`,
      closing: "We look forward to working with you.\n\nKind regards,\nTeam dembrane",
      columns: EN_COLUMNS,
      valid_days: 14,
    },
    nl: {
      kind: "Offerte evenement",
      greeting: "Beste",
      intro: `Hieronder staat wat dembrane op jullie evenement inhoudt en wat het kost. ${NL_ASK}`,
      closing: "We kijken uit naar de samenwerking.\n\nMet vriendelijke groet,\nTeam dembrane",
      columns: NL_COLUMNS,
      valid_days: 14,
    },
  },
  custom: {
    en: {
      kind: "Offer",
      greeting: "Dear",
      intro: `Here is what your dembrane offer includes and what it costs. ${EN_ASK}`,
      closing: "We look forward to working with you.\n\nKind regards,\nTeam dembrane",
      columns: EN_COLUMNS,
      valid_days: 14,
    },
    nl: {
      kind: "Offerte",
      greeting: "Beste",
      intro: `Hieronder staat wat ons aanbod inhoudt en wat het kost. ${NL_ASK}`,
      closing: "We kijken uit naar de samenwerking.\n\nMet vriendelijke groet,\nTeam dembrane",
      columns: NL_COLUMNS,
      valid_days: 14,
    },
  },
};

/** The words of an offer drafted before templates were data, as COPY printed them. */
function legacyText(content: OfferContent): OfferText {
  const copy = COPY[content.template][content.language];
  const perMonth = content.template === "subscription" && content.billing_unit === "month";
  // An event's second paragraph was its heading.
  const [opening, heading, ...rest] = copy.intro;
  const intro = [opening, ...(heading ? [`## ${heading}`] : []), ...rest].join("\n\n");
  const [thanks, ...signOff] = copy.closing;
  return {
    kind: OFFER_KIND[content.template][content.language],
    greeting: copy.greeting,
    intro,
    closing: [thanks, "", ...signOff].join("\n"),
    columns: (perMonth && copy.monthColumns) || copy.columns,
  };
}

/** Paragraphs of an intro: blank lines split them, and none is empty. */
export const paragraphsOf = (s: string): string[] =>
  s
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/** "28 September 2026" or "28 september 2026". */
function longDate(iso: string, months: readonly string[]): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

/**
 * An amount as the reader's language writes it, always with cents so a column lines up:
 * "€1,250.00" in English, "€ 1.250,00" in Dutch.
 */
export function euro(cents: number, currency = "EUR", language: Language = "en"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const [group, decimal] = language === "nl" ? [".", ","] : [",", "."];
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const frac = String(abs % 100).padStart(2, "0");
  const symbol = currency === "EUR" ? (language === "nl" ? "€ " : "€") : `${currency} `;
  return `${sign}${symbol}${whole}${decimal}${frac}`;
}

/** One line of the table. */
export interface OfferRow {
  readonly description: string;
  readonly bullets: readonly string[];
  /** The three number columns, in the order `columns` names them. */
  readonly cells: readonly [string, string, string];
}

/** The parts of an offer both renderers lay out, in reading order. */
export interface OfferLayout {
  /** dembrane's company details: the footer of every page. */
  readonly company: { readonly name: string; readonly lines: readonly string[] };
  readonly kind: string;
  readonly title: string;
  /**
   * Reference, date, valid until and, when they are given, who it is for and the customer's
   * own reference: label and value.
   */
  readonly facts: readonly (readonly [string, string])[];
  readonly greeting: string;
  /** Paragraphs; one that starts with "## " is a heading over the next. */
  readonly intro: readonly string[];
  readonly columns: readonly [string, string, string, string];
  /** The charged lines and those included at no charge ("Included" where the amount goes). */
  readonly rows: readonly OfferRow[];
  /** Subtotal, VAT and total, label and amount; the last is what is paid. */
  readonly totals: readonly (readonly [string, string])[];
  /** Why there is no VAT, when it is reverse-charged or the service is outside the EU. */
  readonly vatNote: string | null;
  /**
   * The optional lines, apart under the totals with their prices, which no total counts;
   * null when there are none.
   */
  readonly optional: {
    readonly title: string;
    readonly note: string;
    readonly rows: readonly OfferRow[];
  } | null;
  /** Who the invoice goes to when it is not the customer: a heading over one line each. */
  readonly billTo: { readonly title: string; readonly lines: readonly string[] } | null;
  /** The amendments under their heading, numbered; none on most offers. */
  readonly amendmentsTitle: string;
  readonly amendments: readonly {
    readonly label: string;
    readonly title: string;
    readonly paragraphs: readonly string[];
  }[];
  /** Lines; an empty one is space above the next. */
  readonly closing: readonly string[];
  readonly acceptanceTitle: string;
  readonly acceptanceIntro: string;
  readonly acceptance: Acceptance;
  /** The clause as plain lines, numbered, for the text. */
  readonly clause: readonly string[];
  /** The same clause in parts, for the PDF: linked names, underlined words. */
  readonly clauseParts: Clause;
}

/**
 * An offer is an event, a yearly license or a custom offer, and the kind is what the
 * customer recognises it by: "Event offer" above the customer's name on the PDF, and
 * "Event offer 515" as the document's name in the app, where the customer is already
 * themselves and the number is what they pass on to whoever signs or pays.
 */
const OFFER_KIND: Record<OfferTemplate, Record<Language, string>> = {
  event: { en: "Event offer", nl: "Offerte evenement" },
  subscription: { en: "Yearly license offer", nl: "Offerte jaarlicentie" },
  custom: { en: "Offer", nl: "Offerte" },
};

export const offerKind = (template: OfferTemplate, language: Language): string =>
  OFFER_KIND[template][language];

/** The words an offer prints: its own, or for an older draft its template's from COPY. */
export const offerTextOf = (content: OfferContent): OfferText =>
  content.text ?? legacyText(content);

/** The document's name: the offer's kind and its number. */
export const offerTitle = (content: OfferContent): string =>
  `${offerTextOf(content).kind} ${content.reference}`;

export function offerTotals(content: OfferContent): Totals {
  return priceLines(content.items);
}

export function layoutOffer(content: OfferContent): OfferLayout {
  const copy = COPY[content.template][content.language];
  const text = offerTextOf(content);
  const totals = offerTotals(content);
  const c = content.company;
  // Only an older subscription draft puts the price per seat (or month) before the quantity.
  const unitFirst = !content.text && content.template === "subscription";
  const clause = buildClause(copy.words, content);
  const money = (cents: number) => euro(cents, content.currency, content.language);
  const treatment = content.vat_treatment ?? "standard";
  // The VAT row speaks for the lines it adds up: the charged ones.
  const rates = new Set(content.items.filter(charged).map((i) => i.vat_rate_bps));
  const onlyRate = rates.size === 1 ? [...rates][0] : undefined;
  const vatLabel =
    onlyRate === undefined ? copy.totals.vat : `${copy.totals.vat} ${onlyRate / 100}%`;
  const facts: [string, string][] = [
    [copy.facts.reference, content.reference],
    [copy.facts.date, longDate(content.date, copy.months)],
    [copy.facts.validUntil, longDate(validUntil(content.date, content.valid_days), copy.months)],
  ];
  if (content.attention) facts.push([copy.facts.attention, content.attention]);
  if (content.customer_reference)
    facts.push([copy.facts.customerReference, content.customer_reference]);
  const rows = totals.lines.map((l: PricedLine, i) => {
    const unit = money(l.unit_price_cents);
    const counts = content.items[i]?.unit;
    const quantity = counts ? `${l.quantity} ${counts}` : String(l.quantity);
    // Included at no charge: no price, and the word where the amount goes.
    const included = l.kind === "included";
    const price = included ? "" : unit;
    const row: OfferRow = {
      description: l.description,
      bullets: content.items[i]?.bullets ?? [],
      cells: [
        unitFirst ? price : quantity,
        unitFirst ? quantity : price,
        included ? copy.included : money(l.net_cents),
      ],
    };
    return { kind: l.kind, row };
  });
  const optional = rows.filter((r) => r.kind === "optional").map((r) => r.row);
  return {
    company: {
      name: c.name,
      lines: [
        `${c.name} · ${c.address}`,
        `KvK ${c.kvk} · ${copy.totals.vat} ${c.vat} · IBAN ${c.iban} · BIC ${c.bic}`,
      ],
    },
    kind: text.kind,
    title: content.offer_name,
    facts,
    greeting: `${text.greeting}${content.person_name ? ` ${content.person_name}` : ""},`,
    intro: paragraphsOf(text.intro),
    columns: text.columns,
    rows: rows.filter((r) => r.kind !== "optional").map((r) => r.row),
    totals: [
      [copy.totals.subtotal, money(totals.subtotal_cents)],
      [vatLabel, money(totals.vat_cents)],
      [copy.totals.total, money(totals.total_cents)],
    ],
    vatNote: treatment === "standard" ? null : copy.vatNote[treatment],
    optional: optional.length
      ? { title: copy.optional.title, note: copy.optional.note, rows: optional }
      : null,
    billTo: content.bill_to
      ? {
          title: copy.billTo.title,
          lines: billToLines(content.bill_to, content.language, {
            vat: copy.totals.vat,
            reference: copy.billTo.reference,
          }),
        }
      : null,
    amendmentsTitle: copy.amendmentsTitle,
    amendments: (content.amendments ?? []).map((a, i) => ({
      label: `${copy.words.amendment} ${i + 1}`,
      title: a.title,
      paragraphs: a.body
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    })),
    closing: text.closing.split("\n").map((line) => line.trim()),
    acceptanceTitle: copy.acceptanceTitle,
    acceptanceIntro: copy.acceptanceIntro,
    acceptance: copy.acceptance,
    clause: [
      clause.opening,
      ...clause.items.map((line, i) => `${i + 1}. ${clauseText(line)}`),
      ...clause.closing,
    ],
    clauseParts: clause,
  };
}

/**
 * The offer as text, for screen readers and search. The PDF rendered from the same layout
 * is what is signed; the acceptance blanks are its fields.
 */
export function offerText(content: OfferContent): string {
  const l = layoutOffer(content);
  const out: string[] = [
    l.kind,
    `# ${l.title}`,
    ...l.facts.map(([k, v]) => `${k}: ${v}`),
    "",
    l.greeting,
    "",
    ...l.intro.flatMap((p) => [p, ""]),
    `| ${l.columns.join(" | ")} |`,
    "| --- | --- | --- | --- |",
  ];
  for (const r of l.rows) {
    const desc = [r.description, ...r.bullets.map((b) => `• ${b}`)].join("<br>");
    out.push(`| ${desc} | ${r.cells.join(" | ")} |`);
  }
  out.push(
    "",
    ...l.totals.map(([k, v]) => `${k}: ${v}`),
    ...(l.vatNote ? [l.vatNote] : []),
    "",
    ...(l.optional
      ? [
          `## ${l.optional.title}`,
          l.optional.note,
          "",
          `| ${l.columns.join(" | ")} |`,
          "| --- | --- | --- | --- |",
          ...l.optional.rows.map(
            (r) =>
              `| ${[r.description, ...r.bullets.map((b) => `• ${b}`)].join("<br>")} | ${r.cells.join(" | ")} |`,
          ),
          "",
        ]
      : []),
    ...(l.billTo ? [`## ${l.billTo.title}`, ...l.billTo.lines, ""] : []),
    ...(l.amendments.length
      ? [
          `## ${l.amendmentsTitle}`,
          ...l.amendments.flatMap((a) => [`${a.label}: ${a.title}`, ...a.paragraphs, ""]),
        ]
      : []),
    ...l.closing,
    "",
    `## ${l.acceptanceTitle}`,
    l.acceptanceIntro,
    l.acceptance.statement,
    ...[...l.acceptance.fields, ...l.acceptance.signing].map((a) => `${a.label}: ${blank}`),
    "",
    ...l.clause,
    "",
    "---",
    ...l.company.lines,
  );
  return out.join("\n");
}

/** Today plus the validity days, as the offer's valid-until date. */
export function validUntil(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
