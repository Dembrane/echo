import { type BillTo, billToLines } from "./bill-to";
import { amsterdamDay, type InvoicePlan, invoiceParts } from "./invoice-plan";
import { dutchDate } from "./legal/parse";
import {
  charged,
  type OfferLine,
  type PricedLine,
  priceLines,
  sectionsOf,
  type Totals,
  type VatTreatment,
} from "./money";
import { type ChooseMode, optionAmounts, optionKey, optionsOf } from "./options";

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
  /** An optional line's option, which the customer may tick when signing ("Scenario A"). */
  readonly option?: string | undefined;
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
  /** Who fills it, on an offer with a second signature; the customer's signer when absent. */
  readonly role?: "second" | "dembrane";
}

/**
 * A second signature an offer asks for: another signatory of the customer, named or not, or
 * dembrane's counter-signature by the staff member named.
 */
export type SecondSigner =
  | { readonly kind: "customer"; readonly name: string | null; readonly email: string | null }
  | {
      readonly kind: "dembrane";
      readonly name: string;
      readonly email: string;
      readonly role: string | null;
    };

/** Who signs an offer for dembrane when it is sent: a staff member, chosen per offer. */
export interface DembraneSigner {
  readonly name: string;
  readonly role: string | null;
  readonly email: string;
}

/**
 * dembrane's signature as the offer carries it: applied when the offer is sent, by the
 * signer staff chose or else the signatory configured, so the customer's signature
 * completes the offer.
 */
export interface DembraneSignature extends DembraneSigner {
  /** When it was applied: the moment the offer was sent. */
  readonly signed_at: string;
}

/** A PDF attached to an offer: in its clause, after its pages, part of its hash. */
export interface OfferAnnex {
  /** From 1. */
  readonly number: number;
  readonly name: string;
  readonly pages: number;
  readonly sha256: string;
  readonly bytes: number;
  /** Where its file is kept. */
  readonly key: string;
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
  /**
   * How the offer is invoiced when not all at once: monthly parts or instalments, printed
   * as "How we invoice". After signing, echo asks for each part's invoice when it falls due.
   */
  readonly invoice_plan?: InvoicePlan;
  /**
   * An offer of zero staff chose on purpose (a free pilot, a scholarship): signed as any
   * offer, it asks for no billing details and is never invoiced. Absent on every other.
   */
  readonly no_charge?: true;
  /** With options on its lines: the signer ticks exactly one, or any. */
  readonly choose?: ChooseMode;
  /** A second signature: the offer is accepted once both are in. */
  readonly second_signer?: SecondSigner;
  /** PDFs attached after the offer's pages, listed in its clause. */
  readonly annexes?: readonly OfferAnnex[];
  /**
   * Who signs for dembrane when it is sent; absent takes the configured signatory then. They
   * sign the DPA the offer sends, and the offer too when `dembrane_signs_offer`.
   */
  readonly dembrane_signer?: DembraneSigner;
  /** Staff chose that dembrane signs the offer itself when it is sent; absent: it does not. */
  readonly dembrane_signs_offer?: true;
  /**
   * dembrane's signature, printed under the customer's blanks. Set when the offer is sent
   * with `dembrane_signs_offer`; absent on a draft, on an offer dembrane does not sign and on
   * an offer sent before dembrane signed what it sends.
   */
  readonly dembrane_signature?: DembraneSignature;
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
  /** The label of a section's subtotal, under its lines. */
  readonly sectionSubtotal: string;
  /** Under the total of an offer of zero on purpose: why nothing is invoiced. */
  readonly noCharge: string;
  /** The options the signer picks from: headings, notes and the words on their amounts. */
  readonly choices: {
    readonly title: Record<ChooseMode, string>;
    readonly note: Record<ChooseMode, string>;
    /** "{option}, excl. VAT" */
    readonly amount: string;
    /** "Total with {option} (incl. VAT)" */
    readonly total: string;
    /** Over the tick boxes in the acceptance. */
    readonly acceptance: Record<ChooseMode, string>;
  };
  /** The block of optional lines under the totals: its heading and the line under it. */
  readonly optional: { readonly title: string; readonly note: string };
  /** The party invoiced in place of the customer: its heading and the words on its lines. */
  readonly billTo: { readonly title: string; readonly reference: string };
  /** The table of an offer invoiced in parts: heading, columns and how each part is named. */
  readonly parts: {
    readonly title: string;
    readonly columns: readonly [string, string, string];
    readonly partOf: string;
    readonly signing: string;
    /** The 1st of the month after the month of signing, and of a month further on. */
    readonly nextMonth: string;
    readonly laterMonth: string;
  };
  /** Why there is no VAT, in the words the invoice uses. */
  readonly vatNote: Record<Exclude<VatTreatment, "standard">, string>;
  readonly closing: readonly string[];
  readonly acceptanceTitle: string;
  readonly acceptanceIntro: string;
  readonly acceptance: Acceptance;
  /** A second signature: its heading for each kind, and the labels of what it prints. */
  readonly second: {
    readonly customer: string;
    readonly dembrane: string;
    readonly name: string;
    readonly role: string;
    readonly date: string;
    readonly signature: string;
    /** Where dembrane's signature image would be, on the signature it applied when sending. */
    readonly signed: string;
  };
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
  /** After an attached annex's name: one page, or {n} pages. */
  readonly attached: readonly [string, string];
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
  attached: [", attached to this offer (1 page)", ", attached to this offer ({n} pages)"],
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
  attached: [
    ", bijgevoegd bij deze offerte (1 pagina)",
    ", bijgevoegd bij deze offerte ({n} pagina's)",
  ],
  precedence:
    "In geval van strijdigheid geldt de rangorde zoals bepaald in artikel 2.4 van de Algemene Voorwaarden.",
  received:
    "Door ondertekening verklaart u bovengenoemde documenten te hebben ontvangen dan wel via de bovenstaande links te kunnen raadplegen.",
};

/**
 * How an attached annex is named on its pages and in the clause: "Annex C: Project plan",
 * lettered on from the standard annexes the offer lists.
 */
export function annexLabel(content: OfferContent, annex: OfferAnnex): string {
  const words = COPY[content.template][content.language].words;
  const standard = (["sla", "dpa"] as const).filter(
    (k) => legalKinds(content.template).includes(k) && !(k === "dpa" && content.processing_terms),
  ).length;
  const i = (content.annexes ?? []).findIndex((a) => a.number === annex.number);
  return `${words.annex} ${String.fromCharCode(65 + standard + Math.max(i, 0))}: ${annex.name}`;
}

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
    // The PDFs attached to this offer, lettered on from the standard annexes.
    ...(content.annexes ?? []).map((a, i) => [
      `${w.annex} ${String.fromCharCode(65 + annexes.length + i)}: ${a.name}${(a.pages === 1 ? w.attached[0] : w.attached[1]).replace("{n}", String(a.pages))}`,
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
  sectionSubtotal: "Subtotal",
  noCharge: "No charge: nothing is invoiced for this offer.",
  choices: {
    title: { one: "Choose one", any: "Options to choose" },
    note: {
      one: "Tick one in the acceptance when you sign. Only the one you tick is charged.",
      any: "Tick any you want in the acceptance when you sign. Only those are charged.",
    },
    amount: "{option}, excl. VAT",
    total: "Total with {option} (incl. VAT)",
    acceptance: { one: "Your choice (tick one)", any: "Your choice (tick any)" },
  },
  optional: { title: "Optional", note: "Not in the total above." },
  billTo: { title: "Invoiced to", reference: "Reference" },
  parts: {
    title: "How we invoice",
    columns: ["Part", "When", "Amount (excl. VAT)"] as const,
    partOf: "{n} of {of}",
    signing: "On signing",
    nextMonth: "1st of the next month",
    laterMonth: "1st of the month, {n} months on",
  },
  vatNote: {
    reverse_charge: "VAT reverse-charged: Article 196, Directive 2006/112/EC.",
    outside_eu:
      "No Dutch VAT: the service is supplied outside the EU (Article 44, Directive 2006/112/EC).",
  },
  amendmentsTitle: "Amendments to the standard documents",
  second: {
    customer: "Second signature",
    dembrane: "For dembrane B.V.",
    name: "Name",
    role: "Role",
    date: "Date",
    signature: "Signature",
    signed: "Signed electronically",
  },
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
  sectionSubtotal: "Subtotaal",
  noCharge: "Kosteloos: voor deze offerte wordt niets gefactureerd.",
  choices: {
    title: { one: "Kies er één", any: "Opties om te kiezen" },
    note: {
      one: "Kruis er bij het ondertekenen één aan. Alleen wat u aankruist, wordt gerekend.",
      any: "Kruis bij het ondertekenen aan wat u wilt. Alleen dat wordt gerekend.",
    },
    amount: "{option}, excl. btw",
    total: "Totaal met {option} (incl. btw)",
    acceptance: { one: "Uw keuze (kruis er één aan)", any: "Uw keuze (kruis aan wat u wilt)" },
  },
  optional: { title: "Optioneel", note: "Niet in het totaal hierboven." },
  billTo: { title: "Factuur aan", reference: "Referentie" },
  parts: {
    title: "Zo factureren we",
    columns: ["Deel", "Wanneer", "Bedrag (excl. btw)"] as const,
    partOf: "{n} van {of}",
    signing: "Bij ondertekening",
    nextMonth: "1e van de volgende maand",
    laterMonth: "1e van de maand, {n} maanden later",
  },
  vatNote: {
    reverse_charge: "Btw verlegd: artikel 196, Richtlijn 2006/112/EG.",
    outside_eu:
      "Geen Nederlandse btw: de dienst wordt buiten de EU verricht (artikel 44, Richtlijn 2006/112/EG).",
  },
  amendmentsTitle: "Aanvullingen op de standaarddocumenten",
  second: {
    customer: "Tweede handtekening",
    dembrane: "Namens dembrane B.V.",
    name: "Naam",
    role: "Functie",
    date: "Datum",
    signature: "Handtekening",
    signed: "Elektronisch ondertekend",
  },
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

/**
 * A quantity as the reader's language writes it: whole numbers as they are, others with
 * their decimals ("1.5", "0.25"; Dutch "1,5").
 */
export function quantityText(quantity: number, language: Language = "en"): string {
  if (Number.isInteger(quantity)) return String(quantity);
  const text = quantity.toFixed(2).replace(/0$/, "");
  return language === "nl" ? text.replace(".", ",") : text;
}

/** One line of the table. */
export interface OfferRow {
  readonly description: string;
  readonly bullets: readonly string[];
  /** The three number columns, in the order `columns` names them. */
  readonly cells: readonly [string, string, string];
}

/**
 * The table's lines under one heading, and what the charged ones come to. An offer
 * without sections has one group without a title or subtotal; a section's subtotal is
 * printed only when there is more than one section.
 */
export interface OfferGroup {
  readonly title: string | null;
  readonly rows: readonly OfferRow[];
  /** Label and amount, before VAT; null when not printed. */
  readonly subtotal: readonly [string, string] | null;
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
  /** The same rows under their section headings, each with its subtotal: what is drawn. */
  readonly groups: readonly OfferGroup[];
  /** Subtotal, VAT and total, label and amount; the last is what is paid. */
  readonly totals: readonly (readonly [string, string])[];
  /** Why there is no VAT, when it is reverse-charged or the service is outside the EU. */
  readonly vatNote: string | null;
  /** Under the total of an offer of zero on purpose: that nothing is invoiced. */
  readonly chargeNote: string | null;
  /**
   * The optional lines, apart under the totals with their prices, which no total counts;
   * null when there are none.
   */
  readonly optional: {
    readonly title: string;
    readonly note: string;
    readonly rows: readonly OfferRow[];
    /** The same rows under their section headings, without subtotals. */
    readonly groups: readonly OfferGroup[];
  } | null;
  /**
   * The options the signer picks from when signing, each with its lines and amount, and
   * with `one` the offer's total with it; their tick boxes go in the acceptance.
   */
  readonly choices: {
    readonly title: string;
    readonly note: string;
    readonly options: readonly {
      readonly label: string;
      readonly rows: readonly OfferRow[];
      readonly amount: readonly [string, string];
      readonly total: readonly [string, string] | null;
    }[];
    /** Over the tick boxes. */
    readonly acceptanceTitle: string;
    readonly fields: readonly AcceptanceField[];
  } | null;
  /** Who the invoice goes to when it is not the customer: a heading over one line each. */
  readonly billTo: { readonly title: string; readonly lines: readonly string[] } | null;
  /** How an offer invoiced in parts is invoiced: one row per part; null when all at once. */
  readonly parts: {
    readonly title: string;
    readonly columns: readonly [string, string, string];
    readonly rows: readonly (readonly [string, string, string])[];
  } | null;
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
  /**
   * A second signature under the first: its heading, what it prints (dembrane's signatory
   * by name and role), and its fields, which the second signer fills in.
   */
  readonly second: {
    readonly title: string;
    readonly printed: readonly (readonly [string, string])[];
    readonly fields: readonly AcceptanceField[];
    readonly signing: readonly AcceptanceField[];
  } | null;
  /**
   * dembrane's signature, applied when the offer was sent: its heading, then name, role,
   * date and the words that stand where a signature image would, label and value. Nothing
   * in it is a field: it is filled in before the customer opens the offer.
   */
  readonly signed: {
    readonly title: string;
    readonly printed: readonly (readonly [string, string])[];
    readonly date: readonly [string, string];
    readonly signature: readonly [string, string];
  } | null;
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
    const amount = quantityText(l.quantity, content.language);
    const quantity = counts ? `${amount} ${counts}` : amount;
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
    return { kind: l.kind, option: content.items[i]?.option, row };
  });
  const optional = rows.filter((r) => r.kind === "optional" && !r.option).map((r) => r.row);
  // Options the signer picks from: their own block, each with its amount and, when exactly
  // one is picked, the total the offer comes to with it.
  const options = optionsOf(content.items);
  const mode = content.choose ?? "any";
  const choices = options.length
    ? {
        title: copy.choices.title[mode],
        note: copy.choices.note[mode],
        options: options.map((o) => {
          const amounts = optionAmounts(content.items, o);
          const words = (w: string) => w.replace("{option}", o.label);
          return {
            label: o.label,
            rows: o.lines.map((i) => (rows[i] as { row: OfferRow }).row),
            amount: [words(copy.choices.amount), money(amounts.net_cents)] as const,
            total:
              mode === "one"
                ? ([
                    words(copy.choices.total),
                    money(totals.total_cents + amounts.net_cents + amounts.vat_cents),
                  ] as const)
                : null,
          };
        }),
        acceptanceTitle: copy.choices.acceptance[mode],
        fields: options.map((o) => f(o.label, "checkbox", optionKey(o.number), false)),
      }
    : null;
  // Each section's rows, in order; its subtotal speaks for its charged lines, and only
  // when there is more than one section, since one would repeat the subtotal below it.
  const sections = sectionsOf(totals.lines);
  const grouped = (wanted: (kind: PricedLine["kind"]) => boolean, withSubtotal: boolean) =>
    sections.flatMap((sec): OfferGroup[] => {
      const picked = sec.lines.filter(({ line }) => wanted(line.kind));
      if (!picked.length) return [];
      return [
        {
          title: sec.title,
          rows: picked.map(({ index }) => (rows[index] as { row: OfferRow }).row),
          subtotal:
            withSubtotal && sections.length > 1 && sec.title
              ? [`${copy.sectionSubtotal} ${sec.title}`, money(sec.subtotal_cents)]
              : null,
        },
      ];
    });
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
    groups: grouped((kind) => kind !== "optional", true),
    choices,
    // Every line an option to pick: no table of zeros, each option carries its own total.
    totals:
      choices && !rows.some((r) => r.kind !== "optional")
        ? []
        : [
            [copy.totals.subtotal, money(totals.subtotal_cents)],
            [vatLabel, money(totals.vat_cents)],
            [copy.totals.total, money(totals.total_cents)],
          ],
    vatNote: treatment === "standard" ? null : copy.vatNote[treatment],
    chargeNote: content.no_charge ? copy.noCharge : null,
    optional: optional.length
      ? {
          title: copy.optional.title,
          note: copy.optional.note,
          rows: optional,
          groups: grouped((kind) => kind === "optional", false)
            .map((g) => ({
              ...g,
              rows: g.rows.filter((r) => optional.includes(r)),
            }))
            .filter((g) => g.rows.length),
        }
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
    parts: content.invoice_plan
      ? {
          title: copy.parts.title,
          columns: copy.parts.columns,
          rows: invoiceParts(content.invoice_plan, content.items).map((p) => {
            const words = copy.parts;
            const when =
              p.due.kind === "signing"
                ? words.signing
                : p.due.kind === "date"
                  ? longDate(p.due.date, copy.months)
                  : (p.due.months === 1 ? words.nextMonth : words.laterMonth).replace(
                      "{n}",
                      String(p.due.months),
                    );
            return [
              words.partOf.replace("{n}", String(p.number)).replace("{of}", String(p.of)),
              when,
              money(p.subtotal_cents),
            ] as const;
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
    // dembrane's signature applied at sending stands for the counter-signature it would ask.
    second:
      content.dembrane_signature && content.second_signer?.kind === "dembrane"
        ? null
        : secondBlock(copy, content.second_signer),
    signed: signedBlock(copy, content.dembrane_signature),
    clause: [
      clause.opening,
      ...clause.items.map((line, i) => `${i + 1}. ${clauseText(line)}`),
      ...clause.closing,
    ],
    clauseParts: clause,
  };
}

/**
 * The block of a second signature. Another signatory of the customer fills in their name,
 * role, date and signature; dembrane's signatory is printed by name and role and fills in
 * the date and signature.
 */
function secondBlock(copy: Copy, second: SecondSigner | undefined): OfferLayout["second"] {
  if (!second) return null;
  const w = copy.second;
  if (second.kind === "customer")
    return {
      title: w.customer,
      printed: [],
      fields: [
        { ...f(w.name, "name"), role: "second" },
        { ...f(w.role, "role"), role: "second" },
      ],
      signing: [
        { ...f(w.date, "date"), role: "second" },
        { ...f(w.signature, "signature"), role: "second" },
      ],
    };
  return {
    title: w.dembrane,
    printed: [[w.name, second.name], ...(second.role ? [[w.role, second.role] as const] : [])],
    fields: [],
    signing: [
      { ...f(w.date, "date"), role: "dembrane" },
      { ...f(w.signature, "signature"), role: "dembrane" },
    ],
  };
}

/** A date as the documents print it: day-month-year, in Amsterdam. */
export const printedDay = (at: Date): string => amsterdamDay(at).split("-").reverse().join("-");

/** dembrane's signature applied when sending, as the offer prints it. */
function signedBlock(copy: Copy, s: DembraneSignature | undefined): OfferLayout["signed"] {
  if (!s) return null;
  const w = copy.second;
  return {
    title: w.dembrane,
    printed: [[w.name, s.name], ...(s.role ? [[w.role, s.role] as const] : [])],
    date: [w.date, printedDay(new Date(s.signed_at))],
    signature: [w.signature, w.signed],
  };
}

/** Table rows as markdown: a heading row per section, its lines, then its subtotal. */
function groupLines(groups: readonly OfferGroup[]): string[] {
  return groups.flatMap((g) => [
    ...(g.title ? [`| **${g.title}** |  |  |  |`] : []),
    ...g.rows.map(
      (r) =>
        `| ${[r.description, ...r.bullets.map((b) => `• ${b}`)].join("<br>")} | ${r.cells.join(" | ")} |`,
    ),
    ...(g.subtotal ? [`| ${g.subtotal[0]} |  |  | ${g.subtotal[1]} |`] : []),
  ]);
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
    ...(l.groups.length
      ? [`| ${l.columns.join(" | ")} |`, "| --- | --- | --- | --- |", ...groupLines(l.groups)]
      : []),
  ];
  out.push(
    "",
    ...l.totals.map(([k, v]) => `${k}: ${v}`),
    ...(l.vatNote ? [l.vatNote] : []),
    ...(l.chargeNote ? [l.chargeNote] : []),
    "",
    ...(l.optional
      ? [
          `## ${l.optional.title}`,
          l.optional.note,
          "",
          `| ${l.columns.join(" | ")} |`,
          "| --- | --- | --- | --- |",
          ...groupLines(l.optional.groups),
          "",
        ]
      : []),
    ...(l.choices
      ? [
          `## ${l.choices.title}`,
          l.choices.note,
          "",
          ...l.choices.options.flatMap((o) => [
            `### ${o.label}`,
            `| ${l.columns.join(" | ")} |`,
            "| --- | --- | --- | --- |",
            ...groupLines([{ title: null, rows: o.rows, subtotal: null }]),
            "",
            `${o.amount[0]}: ${o.amount[1]}`,
            ...(o.total ? [`${o.total[0]}: ${o.total[1]}`] : []),
            "",
          ]),
        ]
      : []),
    ...(l.billTo ? [`## ${l.billTo.title}`, ...l.billTo.lines, ""] : []),
    ...(l.parts
      ? [
          `## ${l.parts.title}`,
          `| ${l.parts.columns.join(" | ")} |`,
          "| --- | --- | --- |",
          ...l.parts.rows.map((r) => `| ${r.join(" | ")} |`),
          "",
        ]
      : []),
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
    ...(l.choices
      ? [l.choices.acceptanceTitle, ...l.choices.fields.map((a) => `[ ] ${a.label}`)]
      : []),
    ...[...l.acceptance.fields, ...l.acceptance.signing].map((a) => `${a.label}: ${blank}`),
    ...(l.second
      ? [
          "",
          `### ${l.second.title}`,
          ...l.second.printed.map(([k, v]) => `${k}: ${v}`),
          ...[...l.second.fields, ...l.second.signing].map((a) => `${a.label}: ${blank}`),
        ]
      : []),
    ...(l.signed
      ? [
          "",
          `### ${l.signed.title}`,
          ...[...l.signed.printed, l.signed.date, l.signed.signature].map(([k, v]) => `${k}: ${v}`),
        ]
      : []),
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
