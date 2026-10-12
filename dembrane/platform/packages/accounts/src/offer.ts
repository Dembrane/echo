import { dutchDate } from "./legal/parse";
import { type OfferLine, type PricedLine, priceLines, type Totals } from "./money";

/**
 * The words of an offer, from the Google Doc templates of sales (packages/accounts/reference:
 * subscription and event, English and Dutch) rewritten in dembrane's voice: what it is and
 * "<Name> x dembrane", the facts (reference, date, valid until), a greeting, the lines table,
 * subtotal, VAT and total, the closing, the acceptance and the incorporation clause naming
 * the pinned terms, SLA and DPA. The clause keeps the templates' legal wording word for word.
 * The template and the language choose the words; every offer has the same look (offer-pdf.ts).
 * The same structure feeds the text the customer reads (and the sha256 binds) and the PDF.
 * Versions and dates of the legal texts always come from the pinned rows, never from here.
 */

export const OFFER_TEMPLATES = ["subscription", "event"] as const;
export type OfferTemplate = (typeof OFFER_TEMPLATES)[number];
export const LANGUAGES = ["en", "nl"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface OfferItem extends OfferLine {
  /** The bulleted lines under the description ("Unlimited recording hours"). */
  readonly bullets: readonly string[];
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
  /** The customer's name in the title: "<offer_name> x dembrane". */
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
}

interface Copy {
  /** What the document is, above its title: "Offer". */
  readonly kind: string;
  readonly facts: {
    readonly reference: string;
    readonly date: string;
    readonly validUntil: string;
    readonly attention: string;
  };
  readonly greeting: string;
  readonly intro: readonly string[];
  readonly columns: readonly [string, string, string, string];
  readonly totals: { readonly subtotal: string; readonly vat: string; readonly total: string };
  readonly closing: readonly string[];
  readonly acceptanceTitle: string;
  readonly acceptanceIntro: string;
  readonly acceptance: Acceptance;
  readonly clause: (l: OfferContent["legal"]) => Clause;
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
const u = (words: string): ClausePart => ({ underline: words });

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

// The words the templates underline in the DPA sentence stay underlined in the PDF.
const DPA_EN_SUB: ClauseLine = [
  " By signing this offer, you agree to the Data Processing Agreement. If the signatory of this offer is ",
  u("not authorised"),
  " to enter into data processing arrangements on behalf of the organisation, the Data Processing Agreement must be signed ",
  u("separately"),
  " by an authorised representative. A signing copy (PDF) is available via the link at Annex B. It is ",
  u("your responsibility"),
  " to assess whether separate signing is required. The Agreement is only complete upon valid acceptance of the Data Processing Agreement (art. 3.6 of the General Terms and Conditions).",
];
const DPA_EN_EVENT: ClauseLine = [
  " If the signatory of this offer is ",
  u("not authorized"),
  " to enter into data processing agreements on behalf of the organization, the Data Processing Agreement must be signed ",
  u("separately"),
  " by an authorized representative. A signed copy (PDF) is available via the link at Appendix B. It is ",
  u("your responsibility"),
  " to determine whether separate signing is required. The Agreement is only complete after valid acceptance of the Data Processing Agreement (art. 3.6 of the General Terms and Conditions).",
];
const DPA_NL: ClauseLine = [
  " Indien de ondertekenaar van deze offerte ",
  u("niet bevoegd"),
  " is om namens de organisatie verwerkingsafspraken aan te gaan, dient de Verwerkersovereenkomst ",
  u("separaat"),
  " te worden ondertekend door een daartoe bevoegd vertegenwoordiger. Een ondertekeningsexemplaar (PDF) is beschikbaar via de link bij Bijlage B. Het is ",
  u("uw verantwoordelijkheid"),
  " om te beoordelen of een separate ondertekening vereist is. De Overeenkomst is pas volledig na geldige aanvaarding van de Verwerkersovereenkomst (art. 3.6 van de Algemene Voorwaarden).",
];

/** The incorporation clause: its opening, the four numbered documents, the two closing lines. */
export interface Clause {
  readonly opening: string;
  readonly items: readonly ClauseLine[];
  readonly closing: readonly string[];
}

const NL_CLAUSE = (l: OfferContent["legal"]): Clause => ({
  opening:
    "Met de ondertekening van deze offerte verklaart u tevens kennis te hebben genomen van en akkoord te gaan met de volgende documenten, die tezamen de Overeenkomst vormen:",
  items: [
    ["Deze opdrachtbevestiging/offerte;"],
    [
      "De ",
      linked("Algemene Voorwaarden", l.terms),
      ` van dembrane B.V. (versie ${ver(l.terms, ", ")}`,
      address(l.terms),
      ");",
    ],
    [
      "Bijlage A: ",
      linked("Service Level Agreement", l.sla),
      ` (versie ${ver(l.sla, ", ")}`,
      address(l.sla),
      "); Een SLA is niet van toepassing bij single events;",
    ],
    [
      "Bijlage B: ",
      linked("Verwerkersovereenkomst", l.dpa),
      ` (versie ${ver(l.dpa, ", ")}`,
      address(l.dpa),
      ").",
      ...DPA_NL,
    ],
  ],
  closing: [
    "In geval van strijdigheid geldt de rangorde zoals bepaald in artikel 2.4 van de Algemene Voorwaarden.",
    "Door ondertekening verklaart u bovengenoemde documenten te hebben ontvangen dan wel via de bovenstaande links te kunnen raadplegen.",
  ],
});

const EN_ACCEPT: Acceptance = {
  fields: [
    f("Name", "name"),
    f("Organisation", "text", "organisation"),
    f("Address", "text", "address"),
    f("Role", "role"),
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
  kind: "Offer",
  facts: {
    reference: "Reference",
    date: "Date",
    validUntil: "Valid until",
    attention: "For the attention of",
  },
  totals: { subtotal: "Subtotal (excl. VAT)", vat: "VAT", total: "Total (incl. VAT)" },
  acceptanceTitle: "Accept this offer",
  acceptanceIntro: "To accept this offer, fill in the fields below and sign.",
  acceptance: EN_ACCEPT,
  months: EN_MONTHS,
};
const NL_FRAME = {
  kind: "Offerte",
  facts: { reference: "Referentie", date: "Datum", validUntil: "Geldig tot", attention: "T.a.v." },
  totals: { subtotal: "Subtotaal (excl. btw)", vat: "Btw", total: "Totaal (incl. btw)" },
  acceptanceTitle: "Offerte accepteren",
  acceptanceIntro: "Vul de velden hieronder in en onderteken om deze offerte te accepteren.",
  months: NL_MONTHS,
};

const COPY: Record<OfferTemplate, Record<Language, Copy>> = {
  subscription: {
    en: {
      ...EN_FRAME,
      greeting: "Hi",
      intro: [
        "Here is what your dembrane subscription includes and what it costs. If anything is unclear, ask us; we are happy to talk it through.",
      ],
      columns: ["Description", "Price per seat per month", "Seats", "Amount"],
      closing: ["We look forward to working with you.", "Best regards,", "Team dembrane"],
      clause: (l) => ({
        opening:
          "By signing this offer, you also declare that you have read and agree to the following documents, which together constitute the Agreement:",
        items: [
          ["This order confirmation/offer;"],
          [
            "The ",
            linked("General Terms and Conditions", l.terms),
            ` of dembrane B.V. (version ${ver(l.terms, ", ")}`,
            address(l.terms),
            ");",
          ],
          [
            "Annex A: ",
            linked("Service Level Agreement", l.sla),
            ` (version ${ver(l.sla, ", ")}`,
            address(l.sla),
            "). An SLA does not apply to single events;",
          ],
          [
            "Annex B: ",
            linked("Data Processing Agreement", l.dpa),
            ` (version ${ver(l.dpa, ", ")}`,
            address(l.dpa),
            ").",
            ...DPA_EN_SUB,
          ],
        ],
        closing: [
          "In the event of any conflict, the order of precedence as set out in article 2.4 of the General Terms and Conditions shall apply.",
          "By signing, you declare that you have received the above documents or are able to access them via the links provided.",
        ],
      }),
    },
    nl: {
      ...NL_FRAME,
      greeting: "Beste",
      intro: [
        "Hieronder staat wat het dembrane-abonnement inhoudt en wat het kost. Is iets niet duidelijk? Vraag het ons gerust; we lichten het graag toe.",
      ],
      columns: ["Omschrijving", "Prijs per seat per maand", "Seats", "Bedrag"],
      closing: ["We kijken uit naar de samenwerking.", "Met vriendelijke groet,", "Team dembrane"],
      acceptance: NL_ACCEPT(true),
      clause: NL_CLAUSE,
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
      clause: (l) => ({
        opening:
          "By signing this offer, you declare that you have received knowledge of and agree with the following documents, which together form the Agreement:",
        items: [
          ["This work order/offer;"],
          [
            "The ",
            linked("General Terms and Conditions", l.terms),
            ` of dembrane B.V. (version ${ver(l.terms, ", ")}`,
            address(l.terms),
            ");",
          ],
          [
            "Appendix A: ",
            linked("Service Level Agreement", l.sla),
            ` (version ${ver(l.sla, ", ")}`,
            address(l.sla),
            "); An SLA does not apply to single events;",
          ],
          [
            "Appendix B: ",
            linked("Data Processing Agreement", l.dpa),
            ` (version ${ver(l.dpa, ", ")}`,
            address(l.dpa),
            ").",
            ...DPA_EN_EVENT,
          ],
        ],
        closing: [
          "In case of conflict, the hierarchy as determined in article 2.4 of the General Terms and Conditions applies.",
          "By signing, you declare that you have received the aforementioned documents or can consult them via the above links.",
        ],
      }),
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
      clause: NL_CLAUSE,
    },
  },
};

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

/** The parts of an offer both renderers lay out, in reading order. */
export interface OfferLayout {
  /** dembrane's company details: the footer of every page. */
  readonly company: { readonly name: string; readonly lines: readonly string[] };
  readonly kind: string;
  readonly title: string;
  /** Reference, date, valid until and, when there is one, who it is for: label and value. */
  readonly facts: readonly (readonly [string, string])[];
  readonly greeting: string;
  /** Paragraphs; an event offer's second paragraph is a heading over its third. */
  readonly intro: readonly string[];
  readonly columns: readonly [string, string, string, string];
  readonly rows: readonly {
    readonly description: string;
    readonly bullets: readonly string[];
    /** The three number columns, in the order `columns` names them. */
    readonly cells: readonly [string, string, string];
  }[];
  /** Subtotal, VAT and total, label and amount; the last is what is paid. */
  readonly totals: readonly (readonly [string, string])[];
  readonly closing: readonly string[];
  readonly acceptanceTitle: string;
  readonly acceptanceIntro: string;
  readonly acceptance: Acceptance;
  /** The clause as plain lines, numbered, for the text. */
  readonly clause: readonly string[];
  /** The same clause in parts, for the PDF: linked names, underlined words. */
  readonly clauseParts: Clause;
}

export function offerTotals(content: OfferContent): Totals {
  return priceLines(content.items);
}

export function layoutOffer(content: OfferContent): OfferLayout {
  const copy = COPY[content.template][content.language];
  const totals = offerTotals(content);
  const c = content.company;
  const unitFirst = content.template === "subscription";
  const clause = copy.clause(content.legal);
  const money = (cents: number) => euro(cents, content.currency, content.language);
  const rates = new Set(content.items.map((i) => i.vat_rate_bps));
  const onlyRate = rates.size === 1 ? [...rates][0] : undefined;
  const vatLabel =
    onlyRate === undefined ? copy.totals.vat : `${copy.totals.vat} ${onlyRate / 100}%`;
  const facts: [string, string][] = [
    [copy.facts.reference, content.reference],
    [copy.facts.date, longDate(content.date, copy.months)],
    [copy.facts.validUntil, longDate(validUntil(content.date, content.valid_days), copy.months)],
  ];
  if (content.attention) facts.push([copy.facts.attention, content.attention]);
  return {
    company: {
      name: c.name,
      lines: [
        `${c.name} · ${c.address}`,
        `KvK ${c.kvk} · ${copy.totals.vat} ${c.vat} · IBAN ${c.iban} · BIC ${c.bic}`,
      ],
    },
    kind: copy.kind,
    title: `${content.offer_name} x dembrane`,
    facts,
    greeting: `${copy.greeting}${content.person_name ? ` ${content.person_name}` : ""},`,
    intro: copy.intro,
    // Subscriptions put the price per seat before the number of seats; events the reverse.
    columns: copy.columns,
    rows: totals.lines.map((l: PricedLine, i) => {
      const unit = money(l.unit_price_cents);
      const quantity = String(l.quantity);
      return {
        description: l.description,
        bullets: content.items[i]?.bullets ?? [],
        cells: [
          unitFirst ? unit : quantity,
          unitFirst ? quantity : unit,
          money(l.net_cents),
        ] as const,
      };
    }),
    totals: [
      [copy.totals.subtotal, money(totals.subtotal_cents)],
      [vatLabel, money(totals.vat_cents)],
      [copy.totals.total, money(totals.total_cents)],
    ],
    closing: copy.closing,
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
    "",
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
