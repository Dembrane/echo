import { brand } from "@dembrane/mail";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import displayTtf from "../assets/fonts/DMSans-Display.ttf" with { type: "file" };
import textTtf from "../assets/fonts/DMSans-Text.ttf" with { type: "file" };
import type { AcceptanceField, FieldKind, Language } from "./offer";

export { offerPdf } from "./offer-pdf";

/**
 * PDFs of account documents, with pdf-lib (pure JavaScript, so it runs under Bun and in the
 * compiled API binary). echo renders the offer (offer-pdf.ts) and text documents itself and
 * knows where it drew each blank, so their fields are placed automatically; an uploaded PDF
 * gets its fields from staff. Signing stamps the values and the signature image onto the
 * unsigned PDF at the field positions and appends an audit page. Text documents, stamped
 * values and the audit page are set in the offer's DM Sans (one weight; size and the muted
 * colour make the hierarchy). Characters it has no glyph for (emoji, most non-Latin
 * scripts) are left out of the PDF, never out of the stored values.
 */

/** A field as placed: fractions of the page from its top-left corner, pages from 1. */
export interface PlacedField {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly kind: FieldKind;
  readonly label: string;
  readonly required: boolean;
  readonly key: string | null;
  /** Who fills it; the customer's signer when absent. */
  readonly role?: "signer" | "second" | "dembrane";
}

export interface RenderedPdf {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly fields: PlacedField[];
}

export interface AuditRecord {
  readonly documentTitle: string;
  readonly documentId: string;
  readonly reference: string | null;
  readonly version: number;
  readonly sha256: string;
  readonly signerName: string;
  readonly signerRole: string | null;
  readonly email: string;
  readonly organisation: string;
  readonly address: string | null;
  readonly vatNumber: string | null;
  /** Whether the signer said they may agree to data processing; null when not asked. */
  readonly dpaAuthorised: boolean | null;
  readonly signedAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly confirmationText: string;
  readonly signatureId: string;
  readonly method: string;
  readonly imageSha256: string;
  /** The language the document was signed in. */
  readonly language: "en" | "nl";
  readonly legal: readonly {
    kind: string;
    version: string;
    effectiveOn: string | null;
    sha256: string;
  }[];
  /** What happened to the document up to this signature, oldest first. */
  readonly trail: readonly { at: string; what: string }[];
  /** An offer with options: each option and whether the signer chose it. */
  readonly choices?: readonly { label: string; chosen: boolean }[];
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const hex = (h: string) =>
  rgb(
    Number.parseInt(h.slice(1, 3), 16) / 255,
    Number.parseInt(h.slice(3, 5), 16) / 255,
    Number.parseInt(h.slice(5, 7), 16) / 255,
  );
const INK = hex(brand.color.text);
const MUTED = hex(brand.color.muted);
const FIELD_LINE = hex(brand.color.control);

/** The DM Sans cuts, read once: the bytes to embed and the characters they can draw. */
let cuts: Promise<{ text: Uint8Array; display: Uint8Array; chars: Set<number> }> | null = null;
function fonts() {
  cuts ??= (async () => {
    const text = await Bun.file(textTtf).bytes();
    const display = await Bun.file(displayTtf).bytes();
    const chars = new Set(
      (fontkit.create(text) as unknown as { characterSet: number[] }).characterSet,
    );
    return { text, display, chars };
  })();
  return cuts;
}

/** Embeds the text cut as `regular` and the display cut (for titles) as `bold`. */
async function embedFonts(doc: PDFDocument) {
  const f = await fonts();
  doc.registerFontkit(fontkit);
  // A fixed name keeps the bytes of the same render the same.
  const regular = await doc.embedFont(f.text, { subset: true, customName: "DMSans-Text" });
  const bold = await doc.embedFont(f.display, { subset: true, customName: "DMSans-Display" });
  return { regular, bold, chars: f.chars };
}
/** A date's and a PDF's metadata must not change the bytes of the same render. */
const EPOCH = new Date("2026-01-01T00:00:00Z");

class Writer {
  page: PDFPage;
  y: number;
  readonly fields: PlacedField[] = [];
  private readonly cache = new Map<string, boolean>();
  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    /** The display cut: same weight, for titles. Hierarchy is size, never weight. */
    readonly bold: PDFFont,
    private readonly chars: Set<number>,
  ) {
    this.page = doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  /** Drops characters the font has no glyph for. */
  clean(text: string, _font: PDFFont = this.regular): string {
    let out = "";
    for (const ch of text.replace(/\t/g, "    ")) {
      let ok = this.cache.get(ch);
      if (ok === undefined) {
        ok = this.chars.has(ch.codePointAt(0) as number);
        this.cache.set(ch, ok);
      }
      if (ok) out += ch;
    }
    return out;
  }

  width(text: string, size: number, font: PDFFont) {
    return font.widthOfTextAtSize(text, size);
  }

  pageNumber() {
    return this.doc.getPageCount();
  }

  newPage() {
    this.page = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.newPage();
  }

  wrap(text: string, size: number, font: PDFFont, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const para of this.clean(text, font).split("\n")) {
      let line = "";
      for (const whole of para.split(/ +/)) {
        // A word wider than the line (a hash, a long address) breaks between characters.
        let word = whole;
        while (this.width(word, size, font) > maxWidth && word.length > 1) {
          let n = word.length - 1;
          while (n > 1 && this.width(word.slice(0, n), size, font) > maxWidth) n--;
          if (line) lines.push(line);
          lines.push(word.slice(0, n));
          line = "";
          word = word.slice(n);
        }
        const next = line ? `${line} ${word}` : word;
        if (this.width(next, size, font) <= maxWidth || !line) line = next;
        else {
          lines.push(line);
          line = word;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  text(
    text: string,
    opts: {
      size?: number;
      bold?: boolean;
      x?: number;
      width?: number;
      color?: typeof INK;
      gap?: number;
      /** Drawn at `markerX` on the first line: a clause number or a bullet. */
      marker?: string;
      markerX?: number;
    } = {},
  ) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.regular;
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? A4[0] - MARGIN - x;
    let marker = opts.marker;
    for (const line of this.wrap(text, size, font, width)) {
      this.ensure(size * 1.4);
      const y = this.y - size;
      if (marker) {
        const m = this.clean(marker);
        this.page.drawText(m, { x: opts.markerX ?? MARGIN, y, size, font, color: MUTED });
        marker = undefined;
      }
      this.page.drawText(line, { x, y, size, font, color: opts.color ?? INK });
      this.y -= size * 1.4;
    }
    this.y -= opts.gap ?? 0;
  }

  space(h: number) {
    this.y -= h;
  }

  rule() {
    this.ensure(8);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y - 4 },
      end: { x: A4[0] - MARGIN, y: this.y - 4 },
      thickness: 0.5,
      color: MUTED,
    });
    this.y -= 10;
  }

  /** Columns of wrapped cells; the header row is muted and repeats on a new page. */
  table(header: string[], rows: string[][], size = 8.5) {
    const n = header.length;
    const total = A4[0] - 2 * MARGIN;
    const pad = 6;
    const colW = total / n;
    const lead = size * 1.35;
    const drawRow = (cells: string[], color: typeof INK) => {
      const wrapped = cells.map((c) => this.wrap(c, size, this.regular, colW - pad));
      const h = Math.max(...wrapped.map((w) => w.length)) * lead + pad;
      if (this.y - h < MARGIN) {
        this.newPage();
        if (color === INK) drawRow(header, MUTED);
      }
      wrapped.forEach((lines, i) => {
        lines.forEach((line, j) => {
          this.page.drawText(line, {
            x: MARGIN + i * colW,
            y: this.y - size - j * lead,
            size,
            font: this.regular,
            color,
          });
        });
      });
      this.y -= h;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y + pad / 2 },
        end: { x: A4[0] - MARGIN, y: this.y + pad / 2 },
        thickness: 0.5,
        color: FIELD_LINE,
      });
    };
    drawRow(header, MUTED);
    for (const r of rows) drawRow(r, INK);
    this.y -= 6;
  }

  /**
   * A labelled blank: the words, then a line where the value goes. Records the field's
   * box (in PDF points, bottom-left origin) as fractions of the page, top-left origin.
   */
  blank(a: AcceptanceField) {
    const height = a.kind === "signature" || a.kind === "initials" ? 46 : 18;
    this.ensure(height + 8);
    const label = this.clean(a.prefix);
    this.page.drawText(label, {
      x: MARGIN,
      y: this.y - height + 4,
      size: 10,
      font: this.regular,
      color: INK,
    });
    const x = Math.max(MARGIN + this.width(label, 10, this.regular) + 8, MARGIN + 170);
    const width = a.kind === "signature" ? 200 : A4[0] - MARGIN - x;
    const bottom = this.y - height;
    this.page.drawLine({
      start: { x, y: bottom + 2 },
      end: { x: x + width, y: bottom + 2 },
      thickness: 0.6,
      color: FIELD_LINE,
    });
    this.fields.push({
      page: this.pageNumber(),
      x: x / A4[0],
      y: (A4[1] - (bottom + height)) / A4[1],
      width: width / A4[0],
      height: height / A4[1],
      kind: a.kind,
      label: a.label,
      required: a.required,
      key: a.key,
    });
    this.y -= height + 6;
  }

  /** A blank already filled in: the words, the value on the line, and no field. */
  filled(label: string, value: string) {
    const height = 18;
    this.ensure(height + 8);
    const words = this.clean(label);
    const bottom = this.y - height;
    this.page.drawText(words, {
      x: MARGIN,
      y: bottom + 4,
      size: 10,
      font: this.regular,
      color: INK,
    });
    const x = Math.max(MARGIN + this.width(words, 10, this.regular) + 8, MARGIN + 170);
    // Where and how large a signature stamps a value, so both signatures read alike.
    this.page.drawText(this.clean(value), {
      x: x + 2,
      y: bottom + 4.5,
      size: 11,
      font: this.regular,
      color: INK,
    });
    this.page.drawLine({
      start: { x, y: bottom + 2 },
      end: { x: A4[0] - MARGIN, y: bottom + 2 },
      thickness: 0.6,
      color: FIELD_LINE,
    });
    this.y -= height + 6;
  }

  /** dembrane's signature applied when sending, under the customer's blanks, filled in. */
  signed(by: SignedBy, words: (typeof SIGNED_BLOCK)[Language]) {
    this.space(18);
    this.ensure(150);
    this.text(`${words.for} ${by.company}`, { bold: true, size: brand.type.print.lead, gap: 6 });
    this.filled(words.name, by.name);
    if (by.role) this.filled(words.role, by.role);
    this.filled(words.date, by.day);
    this.filled(words.signature, words.signed);
  }
}

async function start() {
  const doc = await PDFDocument.create();
  const { regular, bold, chars } = await embedFonts(doc);
  return new Writer(doc, regular, bold, chars);
}

async function finish(w: Writer, title: string): Promise<RenderedPdf> {
  w.doc.setTitle(title);
  w.doc.setAuthor("dembrane B.V.");
  w.doc.setProducer("dembrane echo");
  w.doc.setCreator("dembrane echo");
  w.doc.setCreationDate(EPOCH);
  w.doc.setModificationDate(EPOCH);
  const bytes = await w.doc.save({ useObjectStreams: false });
  return { bytes, pageCount: w.doc.getPageCount(), fields: w.fields };
}

const SIGNING_BLOCK: Record<Language, { title: string; fields: AcceptanceField[] }> = {
  en: {
    title: "Signature",
    fields: [
      { prefix: "Name:", kind: "name", key: null, label: "Name", required: true },
      { prefix: "Role:", kind: "role", key: null, label: "Role", required: true },
      {
        prefix: "Organisation:",
        kind: "text",
        key: "organisation",
        label: "Organisation",
        required: true,
      },
      { prefix: "Date:", kind: "date", key: null, label: "Date", required: true },
      { prefix: "Signature:", kind: "signature", key: null, label: "Signature", required: true },
    ],
  },
  nl: {
    title: "Ondertekening",
    fields: [
      { prefix: "Naam:", kind: "name", key: null, label: "Naam", required: true },
      { prefix: "Functie:", kind: "role", key: null, label: "Functie", required: true },
      {
        prefix: "Organisatie:",
        kind: "text",
        key: "organisation",
        label: "Organisatie",
        required: true,
      },
      { prefix: "Datum:", kind: "date", key: null, label: "Datum", required: true },
      {
        prefix: "Handtekening:",
        kind: "signature",
        key: null,
        label: "Handtekening",
        required: true,
      },
    ],
  },
};

const CLAUSE_INDENT = 28;

type LegalBlock =
  | { kind: "heading"; level: 1 | 2; text: string }
  | { kind: "subheading" | "paragraph" | "item" | "note"; text: string }
  | { kind: "clause"; number: string; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

/** A short line with no closing punctuation: a heading or a table cell, never prose. */
const isLabel = (l: string) =>
  l.length <= 60 && /^[A-Z]/.test(l) && !/[.:;,]$/.test(l) && l.split(" ").length <= 8;

/** "Data Subject: the person…": one entry of a list of definitions. */
const isDefinition = (l: string) => /^[A-Z][^:.]{0,40}: \S/.test(l);

/**
 * The structure a legal text lost when it became plain lines: markdown headings, "Article 3."
 * and "Annex I." headings, numbered clauses, the list after a line ending in ":", and a
 * table (three or more labels in a row, then rows of that many cells; a tab-separated line
 * is a row of cells). A cell that ran into a link ("(EU)https://…") is split back in two.
 */
export function legalBlocks(body: string): LegalBlock[] {
  const lines = body
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  const out: LegalBlock[] = [];
  let listOpen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const md = /^(#{1,3})\s+(.*)$/.exec(line);
    if (md) {
      out.push({ kind: "heading", level: md[1] === "#" ? 1 : 2, text: md[2] as string });
      listOpen = false;
      continue;
    }
    if (/^(Article \d+|Annex [IVX]+)\.\s/.test(line)) {
      out.push({ kind: "heading", level: 2, text: line });
      listOpen = false;
      continue;
    }
    if (line.includes("\t")) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] as string).includes("\t"))
        rows.push((lines[i++] as string).split("\t").map((c) => c.trim()));
      i--;
      const [header, ...rest] = rows;
      if (header) out.push({ kind: "table", header, rows: rest });
      listOpen = false;
      continue;
    }
    let labels = 0;
    while (i + labels < lines.length && isLabel(lines[i + labels] as string)) labels++;
    if (labels >= 3) {
      const run: string[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const l = lines[j] as string;
        if (j >= i + labels && /^(Article \d+|Annex [IVX]+)\.\s|^#/.test(l)) break;
        const link = /^(.*\S)(https?:\/\/\S+)$/.exec(l);
        if (link) run.push(link[1] as string, link[2] as string);
        else run.push(l);
      }
      // The header is as many labels as make the cells after it fill whole rows; a short
      // cell ("Participants") can follow the header and look like one more label.
      let n = 3;
      while (n < labels && (run.length - n) % n !== 0) n++;
      const header = run.slice(0, n);
      const rows: string[][] = [];
      for (let k = n; k + n <= run.length; k += n) rows.push(run.slice(k, k + n));
      out.push({ kind: "table", header, rows });
      i = j - 1;
      listOpen = false;
      continue;
    }
    const clause = /^(\d+\.\d+\.?)\s+(.*)$/.exec(line);
    if (listOpen && !clause && !isLabel(line)) {
      out.push({ kind: "item", text: line });
      listOpen = /;$/.test(line) || isDefinition(line);
      continue;
    }
    if (clause)
      out.push({ kind: "clause", number: clause[1] as string, text: clause[2] as string });
    else if (line.startsWith("* ")) out.push({ kind: "note", text: line });
    else if (isLabel(line)) out.push({ kind: "subheading", text: line });
    else out.push({ kind: "paragraph", text: line });
    listOpen = /:$/.test(line);
  }
  return out;
}

/** The words around dembrane's signature applied when sending, as a text document prints it. */
const SIGNED_BLOCK: Record<
  Language,
  { for: string; name: string; role: string; date: string; signature: string; signed: string }
> = {
  en: {
    for: "For",
    name: "Name:",
    role: "Role:",
    date: "Date:",
    signature: "Signature:",
    signed: "Signed electronically",
  },
  nl: {
    for: "Namens",
    name: "Naam:",
    role: "Functie:",
    date: "Datum:",
    signature: "Handtekening:",
    signed: "Elektronisch ondertekend",
  },
};

/** dembrane's signature on a text document: who, for which company, and the day. */
export interface SignedBy {
  readonly company: string;
  readonly name: string;
  readonly role: string | null;
  /** Day-month-year, as the documents print dates. */
  readonly day: string;
}

/**
 * A text document (a DPA, a plan) as a PDF. With `signing`, a signing block follows the
 * text and its blanks are the document's fields. With `signed`, dembrane's signature,
 * applied when the document is sent, follows the customer's blanks, filled in.
 */
export async function textPdf(
  title: string,
  body: string,
  opts: { signing: boolean; language: Language; signed?: SignedBy | null },
): Promise<RenderedPdf> {
  const w = await start();
  w.text(title, { bold: true, size: brand.type.print.display, gap: 14 });
  for (const block of legalBlocks(body)) {
    switch (block.kind) {
      case "heading":
        w.space(w.y < A4[1] - MARGIN - 60 ? 12 : 0);
        w.ensure(60);
        w.text(block.text, {
          bold: true,
          size: block.level === 1 ? brand.type.print.title : brand.type.print.lead,
          gap: 6,
        });
        break;
      case "subheading":
        w.space(6);
        w.ensure(40);
        w.text(block.text, { bold: true, size: 11, gap: 3 });
        break;
      case "clause":
        w.text(block.text, { size: 9.5, x: MARGIN + CLAUSE_INDENT, marker: block.number, gap: 5 });
        break;
      case "item":
        w.text(block.text, {
          size: 9.5,
          x: MARGIN + CLAUSE_INDENT + 12,
          marker: "–",
          markerX: MARGIN + CLAUSE_INDENT,
          gap: 3,
        });
        break;
      case "note":
        w.text(block.text, { size: brand.type.print.caption, color: MUTED, gap: 5 });
        break;
      case "table":
        w.space(2);
        w.table(block.header, block.rows);
        break;
      default:
        w.text(block.text, { size: 9.5, gap: 5 });
    }
  }
  if (opts.signing) {
    const block = SIGNING_BLOCK[opts.language];
    w.space(16);
    w.ensure(230);
    w.text(block.title, { bold: true, size: brand.type.print.title, gap: 10 });
    for (const a of block.fields) w.blank(a);
    if (opts.signed) w.signed(opts.signed, SIGNED_BLOCK[opts.language]);
  }
  return finish(w, title);
}

export async function pageCountOf(pdf: Uint8Array): Promise<number> {
  return (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
}

export interface StampField extends PlacedField {
  readonly id: string;
}

/**
 * The signed PDF: the unsigned PDF with each value written into its field and the
 * signature (and initials) image drawn into theirs, then the audit page.
 */
export async function signedPdf(
  unsigned: Uint8Array,
  fields: readonly StampField[],
  values: Readonly<Record<string, string | boolean>>,
  images: { signature: Uint8Array; initials: Uint8Array | null },
  audit: AuditRecord,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(unsigned, { updateMetadata: false });
  const { regular, bold, chars } = await embedFonts(doc);
  const signature = await doc.embedPng(images.signature);
  const initials = images.initials ? await doc.embedPng(images.initials) : signature;
  const pages = doc.getPages();
  const w = new Writer(doc, regular, bold, chars);
  // Writer adds a page for itself; it becomes the audit page, after the document's pages.
  for (const f of fields) {
    const page = pages[f.page - 1];
    if (!page) continue;
    const { width: pw, height: ph } = page.getSize();
    const box = { x: f.x * pw, y: ph - (f.y + f.height) * ph, w: f.width * pw, h: f.height * ph };
    if (f.kind === "signature" || f.kind === "initials") {
      const img = f.kind === "signature" ? signature : initials;
      const scale = Math.min(box.w / img.width, box.h / img.height);
      page.drawImage(img, {
        x: box.x,
        y: box.y,
        width: img.width * scale,
        height: img.height * scale,
      });
      continue;
    }
    const v = values[f.id];
    const text = f.kind === "checkbox" ? (v === true ? "X" : "") : typeof v === "string" ? v : "";
    if (!text) continue;
    let size = Math.min(11, box.h * 0.8);
    const clean = w.clean(text);
    while (size > 5 && regular.widthOfTextAtSize(clean, size) > box.w) size -= 0.5;
    page.drawText(clean, {
      x: box.x + 2,
      y: box.y + (box.h - size) / 2 + 1,
      size,
      font: regular,
      color: INK,
    });
  }
  drawAudit(w, audit);
  doc.setSubject(`Signed by ${audit.signerName} for ${audit.organisation}`);
  const at = new Date(audit.signedAt);
  doc.setModificationDate(at);
  return doc.save({ useObjectStreams: false });
}

function drawAudit(w: Writer, a: AuditRecord) {
  w.text("Signature record", { bold: true, size: brand.type.print.title, gap: 6 });
  w.text("Simple electronic signature (eIDAS art. 3(10)), recorded by dembrane.", {
    size: 9,
    color: MUTED,
    gap: 12,
  });
  const row = (label: string, value: string | null | undefined): [string, string][] =>
    value ? [[label, value]] : [];
  const pinned = a.legal.map((t): [string, string] => [
    LEGAL_LABEL[t.kind] ?? t.kind,
    `version ${t.version}${t.effectiveOn ? `, ${t.effectiveOn}` : ""}, SHA-256 ${t.sha256}`,
  ]);
  // Plain headings first; the ids and hashes that only matter when checking the record
  // come last. Every recorded value stays.
  drawGroups(w, [
    [
      "The document",
      [
        ["Title", a.documentTitle],
        ...row("Reference", a.reference),
        ["Version", String(a.version)],
      ],
    ],
    [
      "Who signed",
      [
        ["Name", a.signerName],
        ...row("Role", a.signerRole),
        ["Email (verified at sign-in)", a.email],
        ["Organisation", a.organisation],
        ...row("Address", a.address),
        ...row("VAT number", a.vatNumber),
        ...(a.dpaAuthorised === null
          ? []
          : ([
              [
                "May agree to data processing",
                a.dpaAuthorised ? "yes" : "no, the DPA is signed separately",
              ],
            ] as [string, string][])),
      ],
    ],
    [
      "What was agreed",
      [
        // The choice is part of what was signed: each option, chosen or not.
        ...(a.choices ?? []).map((c): [string, string] => [
          `Option: ${c.label}`,
          c.chosen ? "chosen" : "not chosen",
        ]),
        ["Language signed in", a.language === "nl" ? "Dutch (nl)" : "English (en)"],
        ...pinned,
      ],
    ],
    [
      "When and where",
      [
        ["Signed at (UTC)", a.signedAt],
        ["How the signature was made", a.method],
        ["IP address", a.ip ?? "not recorded"],
        ["Browser and device", a.userAgent ?? "not recorded"],
      ],
    ],
    [
      "Verification",
      [
        ["Document id", a.documentId],
        ["Fingerprint (SHA-256) of the unsigned PDF", a.sha256],
        ["Fingerprint (SHA-256) of the signature image", a.imageSha256],
        ["Signature id", a.signatureId],
      ],
    ],
  ]);
  drawTrail(w, a.trail);
  w.space(10);
  w.text("Confirmation shown and accepted", { size: brand.type.print.lead, gap: 4 });
  w.text(a.confirmationText, { size: 9.5 });
}

/** What the pinned legal texts are called on the record; an unknown kind prints as it is. */
const LEGAL_LABEL: Record<string, string> = { terms: "Terms", sla: "SLA", dpa: "DPA" };

/** A heading that never sits alone at the foot of a page. */
function heading(w: Writer, text: string) {
  w.space(10);
  w.ensure(60);
  w.text(text, { size: brand.type.print.lead, gap: 4 });
}

function drawGroups(
  w: Writer,
  groups: readonly (readonly [string, readonly (readonly [string, string])[]])[],
) {
  for (const [title, rows] of groups) {
    if (!rows.length) continue;
    heading(w, title);
    drawRows(w, rows);
  }
}

/** Label and value side by side, the label muted, each row as tall as its longer side. */
function drawRows(w: Writer, rows: readonly (readonly [string, string])[]) {
  for (const [k, value] of rows) {
    const before = w.y;
    const page = w.page;
    w.text(k, { size: 9, width: 150, color: MUTED });
    const after = w.y;
    if (w.page === page) w.y = before;
    w.text(value, { size: 9, x: MARGIN + 160 });
    w.y = Math.min(after, w.y) - 3;
  }
}

function drawTrail(w: Writer, trail: readonly { at: string; what: string }[]) {
  if (!trail.length) return;
  heading(w, "Audit trail (UTC)");
  drawRows(
    w,
    trail.map((t) => [t.at, t.what] as const),
  );
}

/** How the customer accepted outside dembrane, as the record and the timeline word it. */
export const OUTSIDE_VIA = {
  order_letter: "by order letter",
  email: "by email",
  paper: "by signature on paper",
  own_document: "by signing their own data processing agreement",
} as const;
export type OutsideVia = keyof typeof OUTSIDE_VIA;

/** What the acceptance record page of a document accepted outside dembrane states. */
export interface AcceptanceRecord {
  readonly documentTitle: string;
  readonly documentId: string;
  readonly reference: string | null;
  readonly version: number;
  /** SHA-256 of the PDF as sent: what the customer accepted. */
  readonly sha256: string;
  readonly via: OutsideVia;
  /** ISO day the customer accepted. */
  readonly acceptedOn: string;
  readonly name: string;
  readonly role: string | null;
  readonly email: string;
  readonly organisation: string;
  readonly customerReference: string | null;
  readonly evidence: { name: string; type: string; sha256: string; bytes: Uint8Array };
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly acceptanceId: string;
  readonly statement: string;
  readonly legal: AuditRecord["legal"];
  readonly trail: AuditRecord["trail"];
  readonly choices?: AuditRecord["choices"];
}

/** "22-10-2026", as the documents print a day. */
const printedDay = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/** The one line the record leads with: "Accepted by order letter on 22-10-2026, evidence attached." */
export const acceptanceLine = (via: OutsideVia, acceptedOn: string) =>
  `Accepted ${OUTSIDE_VIA[via]} on ${printedDay(acceptedOn)}, evidence attached.`;

/**
 * The copy of a document accepted outside dembrane: the PDF as sent, unchanged and with no
 * drawn signature, then a page saying how and when the customer accepted it, who recorded
 * it, and the evidence's SHA-256. The evidence file rides inside as an attachment, so the
 * copy proves itself without our database.
 */
export async function acceptedPdf(sent: Uint8Array, a: AcceptanceRecord): Promise<Uint8Array> {
  const doc = await PDFDocument.load(sent, { updateMetadata: false });
  const { regular, bold, chars } = await embedFonts(doc);
  const w = new Writer(doc, regular, bold, chars);
  w.text("Acceptance record", { bold: true, size: brand.type.print.title, gap: 6 });
  w.text(acceptanceLine(a.via, a.acceptedOn), { size: 11, gap: 4 });
  w.text(
    "The customer accepted this document outside dembrane. Nothing was signed here; dembrane staff recorded the acceptance with the evidence below.",
    { size: 9, color: MUTED, gap: 12 },
  );
  const rows: [string, string][] = [
    ["Document", a.documentTitle],
    ["Document id", a.documentId],
    ...(a.reference ? ([["Reference", a.reference]] as [string, string][]) : []),
    ["Version", String(a.version)],
    ["SHA-256 of the PDF as sent", a.sha256],
    ["Accepted", `${OUTSIDE_VIA[a.via]}, on ${printedDay(a.acceptedOn)}`],
    ["Accepted by", a.role ? `${a.name}, ${a.role}` : a.name],
    ["Email", a.email],
    ["Organisation", a.organisation],
    ...(a.customerReference
      ? ([["Their reference", a.customerReference]] as [string, string][])
      : []),
    ...(a.choices ?? []).map((c): [string, string] => [
      `Option: ${c.label}`,
      c.chosen ? "chosen" : "not chosen",
    ]),
    ["Evidence", `${a.evidence.name} (${a.evidence.type}), attached to this PDF`],
    ["SHA-256 of the evidence", a.evidence.sha256],
    ["Recorded by", a.recordedBy],
    ["Recorded at (UTC)", a.recordedAt],
    ["Record id", a.acceptanceId],
  ];
  for (const t of a.legal)
    rows.push([
      `Pinned ${t.kind}`,
      `version ${t.version}${t.effectiveOn ? `, ${t.effectiveOn}` : ""}, SHA-256 ${t.sha256}`,
    ]);
  drawRows(w, rows);
  drawTrail(w, a.trail);
  w.space(10);
  w.text("Recorded statement", { size: brand.type.print.lead, gap: 4 });
  w.text(a.statement, { size: 9.5 });
  await doc.attach(a.evidence.bytes, a.evidence.name, {
    mimeType: a.evidence.type,
    description: "Evidence of acceptance",
    creationDate: new Date(a.recordedAt),
    modificationDate: new Date(a.recordedAt),
  });
  doc.setSubject(`Accepted ${OUTSIDE_VIA[a.via]} by ${a.name} for ${a.organisation}`);
  doc.setModificationDate(new Date(a.recordedAt));
  return doc.save({ useObjectStreams: false });
}
