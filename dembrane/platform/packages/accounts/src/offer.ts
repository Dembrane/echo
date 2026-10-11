import { dutchDate } from "./legal/parse";
import { type OfferLine, type PricedLine, priceLines, type Totals } from "./money";

/**
 * The offer in the words of the Google Doc templates (packages/accounts/reference: subscription
 * and event, English and Dutch): letterhead, "<Name> x dembrane", date and offer id, a
 * greeting, the lines table, the total excluding VAT, the closing, the acceptance block and
 * the incorporation clause naming the pinned terms, SLA and DPA, then the validity line.
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
  readonly metaId: string;
  readonly attention: string;
  readonly greeting: string;
  readonly intro: readonly string[];
  readonly columns: readonly [string, string, string, string];
  readonly total: string;
  readonly closing: readonly string[];
  readonly acceptanceTitle: string;
  readonly acceptanceIntro: string;
  readonly acceptance: Acceptance;
  readonly clause: (l: OfferContent["legal"]) => Clause;
  readonly validity: string;
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
const f = (
  prefix: string,
  kind: FieldKind,
  label: string,
  key: string | null = null,
  required = true,
): AcceptanceField => ({ prefix, kind, key, label, required });

// The acceptance blanks of each template become the offer's fields. The templates ask for
// no role; a role field is added because the signature record and its confirmation name it.
const EN_SIGNING = [
  f("Date of signing:", "date", "Date of signing"),
  f("Signature:", "signature", "Signature"),
];
const NL_SIGNING = [
  f("Datum van ondertekening:", "date", "Datum van ondertekening"),
  f("Handtekening:", "signature", "Handtekening"),
];

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

const NL_ACCEPT = (withVat: boolean): Acceptance => ({
  fields: [
    f("Bij deze gaat", "name", "Naam"),
    f("van de organisatie", "text", "Organisatie", "organisation"),
    f("die is gevestigd op", "text", "Adres", "address"),
    ...(withVat ? [f("met het btw nummer", "text", "Btw-nummer", "vat_number", false)] : []),
    f("Functie:", "role", "Functie"),
  ],
  statement: "akkoord bij de inhoud van de opgemaakt offerte.",
  signing: NL_SIGNING,
});

const EVENT_ROLE_EN = [
  "Dembrane's Role:",
  "Dembrane is a tech for good start-up from Eindhoven that provides an accessible, digital way to collect input from participants during an event, making it directly visible and analyzable, and reporting quickly – supplementing traditional methods.",
];
const EVENT_ROLE_NL = [
  "Rol van dembrane:",
  "Dembrane is een tech for good start-up uit Eindhoven en biedt een laagdrempelige, digitale manier om input van deelnemers tijdens een evenement te verzamelen, direct inzichtelijk en analyseerbaar te maken, en snel te rapporteren – ter aanvulling van traditionele methoden.",
];

const COPY: Record<OfferTemplate, Record<Language, Copy>> = {
  subscription: {
    en: {
      metaId: "Offer ID",
      attention: "Attn.",
      greeting: "Hi",
      intro: [
        "Below you can find the details for your dembrane subscription. If you have any questions, don’t hesitate to ask them.",
      ],
      columns: [
        "Description",
        "Price per seat/month (excl. VAT)",
        "Amount of seats",
        "Total Price (excl. VAT)",
      ],
      total: "Total price (excl. VAT):",
      closing: ["We look forward to our future collaboration ✨", "Best regards,", "Team dembrane"],
      acceptanceTitle: "Offer acceptance",
      acceptanceIntro:
        "If you wish to accept this offer, please complete the fields below and sign the document as a final step.",
      acceptance: {
        fields: [
          f("Hereby,", "name", "Name"),
          f("of the organisation", "text", "Organisation", "organisation"),
          f("located at", "text", "Address", "address"),
          f("Role:", "role", "Role"),
        ],
        statement: "agrees to the contents of this offer.",
        signing: EN_SIGNING,
      },
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
      validity: "\u{1F4C5} This offer is valid for 14 days starting from the date it was made",
    },
    nl: {
      metaId: "Offer ID",
      attention: "T.a.v.",
      greeting: "Hi",
      intro: [
        "Hieronder vind u het overzicht voor het abonnement bij dembrane. Indien u verdere vragen heeft dan gaan we graag verder in gesprek daarover.",
      ],
      columns: ["Description", "Prijs/seat/maand", "Aantal", "Totaal (excl. BTW)"],
      total: "Totale prijs (excl. BTW):",
      closing: [
        "We kijken alvast uit naar een verdere samenwerking ✨",
        "Met vriendelijke groeten,",
        "Team dembrane",
      ],
      acceptanceTitle: "Acceptatie offerte",
      acceptanceIntro:
        "Indien je deze offerte wilt accepteren, vul dan gelieve onderstaande velden in en onderteken als laatste stap het document.",
      acceptance: NL_ACCEPT(true),
      clause: NL_CLAUSE,
      validity: "\u{1F4C5} Deze offerte is 14 dagen geldig vanaf de datum van opstellen.",
    },
  },
  event: {
    en: {
      metaId: "Offer ID",
      attention: "Attn.",
      greeting: "Dear",
      intro: [
        "Please find enclosed the offer for deploying dembrane at your event.",
        ...EVENT_ROLE_EN,
      ],
      columns: ["Description", "Quantity", "Price per Unit", "Total Price (excl. VAT)"],
      total: "Total price (excl. VAT):",
      closing: ["We look forward to further collaboration ✨", "Kind regards,", "Team dembrane"],
      acceptanceTitle: "Offer Acceptance",
      acceptanceIntro:
        "If you wish to accept this offer, please fill in the fields below and sign as the final step of the document.",
      acceptance: {
        fields: [
          f("By this", "name", "Name"),
          f("on behalf of the organization", "text", "Organisation", "organisation"),
          f("which is located at", "text", "Address", "address"),
          f("Role:", "role", "Role"),
        ],
        statement: "agree with the content of the prepared offer.",
        signing: EN_SIGNING,
      },
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
      validity: "\u{1F4C5} This offer is valid for 14 days from the date of preparation.",
    },
    nl: {
      metaId: "Offerte ID",
      attention: "T.a.v.",
      greeting: "Beste",
      intro: [
        "Bij deze de offerte voor dembrane in te zetten op jullie evenement.",
        ...EVENT_ROLE_NL,
      ],
      columns: ["Beschrijving", "Aantal", "Prijs per stuk", "Totale Prijs (excl. BTW)"],
      total: "Totale prijs (excl. BTW):",
      closing: [
        "We kijken alvast uit naar een verdere samenwerking ✨",
        "Met vriendelijke groeten,",
        "Team dembrane",
      ],
      acceptanceTitle: "Acceptatie offerte",
      acceptanceIntro:
        "Indien je deze offerte wilt accepteren, vul dan gelieve onderstaande velden in en onderteken als laatste stap het document.",
      acceptance: NL_ACCEPT(false),
      clause: NL_CLAUSE,
      validity: "\u{1F4C5} Deze offerte is 14 dagen geldig vanaf de datum van opstellen.",
    },
  },
};

export const SIGN_OFF = "Excited to turn Dialogue into Societal Success.";

/** "€1.250" for whole euros and "€1.250,50" otherwise, as the templates write amounts. */
export function euro(cents: number, currency = "EUR"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = abs % 100 ? `,${String(abs % 100).padStart(2, "0")}` : "";
  const symbol = currency === "EUR" ? "€" : `${currency} `;
  return `${sign}${symbol}${whole}${frac}`;
}

/** The parts of an offer both renderers lay out, in reading order. */
export interface OfferLayout {
  readonly letterhead: { readonly name: string; readonly rows: readonly [string, string][] };
  readonly title: string;
  readonly meta: string;
  readonly greeting: string;
  readonly intro: readonly string[];
  readonly columns: readonly [string, string, string, string];
  readonly rows: readonly {
    readonly description: string;
    readonly bullets: readonly string[];
    /** The three number columns, in the order `columns` names them. */
    readonly cells: readonly [string, string, string];
  }[];
  readonly total: string;
  readonly closing: readonly string[];
  readonly acceptanceTitle: string;
  readonly acceptanceIntro: string;
  readonly acceptance: Acceptance;
  /** The clause as plain lines, numbered, for the text. */
  readonly clause: readonly string[];
  /** The same clause in parts, for the PDF: linked names, underlined words. */
  readonly clauseParts: Clause;
  readonly validity: string;
  readonly signOff: string;
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
  const meta = [`${dutchDate(content.date)} | ${copy.metaId}: ${content.reference}`];
  if (content.attention) meta.push(`${copy.attention} ${content.attention}`);
  return {
    letterhead: {
      name: c.name,
      rows: [
        ["Address:", c.address],
        ["VAT:", c.vat],
        ["IBAN:", c.iban],
        ["KVK:", c.kvk],
      ],
    },
    title: `${content.offer_name} x dembrane`,
    meta: meta.join(" | "),
    greeting: `${copy.greeting}${content.person_name ? ` ${content.person_name}` : ""},`,
    intro: copy.intro,
    // Subscriptions put the price per seat before the number of seats; events the reverse.
    columns: copy.columns,
    rows: totals.lines.map((l: PricedLine, i) => {
      const unit = euro(l.unit_price_cents, content.currency);
      const quantity = String(l.quantity);
      return {
        description: l.description,
        bullets: content.items[i]?.bullets ?? [],
        cells: [
          unitFirst ? unit : quantity,
          unitFirst ? quantity : unit,
          euro(l.net_cents, content.currency),
        ] as const,
      };
    }),
    total: `${copy.total} ${euro(totals.subtotal_cents, content.currency)}`,
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
    validity: copy.validity,
    signOff: SIGN_OFF,
  };
}

/**
 * The offer as text, for screen readers and search. The PDF rendered from the same layout
 * is what is signed; the acceptance blanks are its fields.
 */
export function offerText(content: OfferContent): string {
  const l = layoutOffer(content);
  const out: string[] = [
    l.letterhead.name,
    ...l.letterhead.rows.map(([k, val]) => `${k} ${val}`),
    "",
    `# ${l.title}`,
    l.meta,
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
    l.total,
    "",
    ...l.closing,
    "",
    `## ${l.acceptanceTitle}`,
    l.acceptanceIntro,
    ...l.acceptance.fields.map((a) => `${a.prefix} ${blank}`),
    l.acceptance.statement,
    ...l.acceptance.signing.map((a) => `${a.prefix} ${blank}`),
    "",
    ...l.clause,
    "",
    l.validity,
    l.signOff,
  );
  return out.join("\n");
}

/** Today plus the validity days, as the offer's valid-until date. */
export function validUntil(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
