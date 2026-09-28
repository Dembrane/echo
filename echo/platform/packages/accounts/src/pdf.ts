import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import {
  type AcceptanceField,
  type FieldKind,
  type Language,
  layoutOffer,
  type OfferContent,
} from "./offer";

/**
 * PDFs of account documents, with pdf-lib (pure JavaScript, so it runs under Bun and in the
 * compiled API binary). echo renders the offer and text documents itself and knows where
 * it drew each blank, so their fields are placed automatically; an uploaded PDF gets its
 * fields from staff. Signing stamps the values and the signature image onto the unsigned
 * PDF at the field positions and appends an audit page. The standard fonts encode
 * Windows-1252 only; other characters (emoji, most non-Latin scripts) are left out of the
 * PDF, never out of the stored values. Embedding a Unicode font is the next step if a
 * customer's name needs it.
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
  readonly dpaAuthorised: boolean;
  readonly signedAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly confirmationText: string;
  readonly signatureId: string;
  readonly method: string;
  readonly imageSha256: string;
  readonly legal: readonly {
    kind: string;
    version: string;
    effectiveOn: string | null;
    sha256: string;
  }[];
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const INK = rgb(0.176, 0.176, 0.173);
const MUTED = rgb(0.45, 0.45, 0.45);
const FIELD_LINE = rgb(0.72, 0.72, 0.72);
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
    readonly bold: PDFFont,
  ) {
    this.page = doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  /** Drops characters the font cannot encode, so drawing never throws. */
  clean(text: string, font: PDFFont = this.regular): string {
    let out = "";
    for (const ch of text.replace(/\t/g, "    ")) {
      let ok = this.cache.get(ch);
      if (ok === undefined) {
        try {
          font.encodeText(ch);
          ok = true;
        } catch {
          ok = false;
        }
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
      for (const word of para.split(/ +/)) {
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
    } = {},
  ) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.regular;
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? A4[0] - MARGIN - x;
    for (const line of this.wrap(text, size, font, width)) {
      this.ensure(size * 1.4);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: opts.color ?? INK });
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
}

async function start() {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return new Writer(doc, regular, bold);
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

/** The offer as the Google Doc templates lay it out, with its acceptance blanks as fields. */
export async function offerPdf(content: OfferContent): Promise<RenderedPdf> {
  const w = await start();
  const l = layoutOffer(content);
  w.text(l.letterhead.name, { bold: true, size: 12 });
  for (const [k, value] of l.letterhead.rows) w.text(`${k} ${value}`, { size: 8.5, color: MUTED });
  w.space(18);
  w.text(l.title, { bold: true, size: 18, gap: 2 });
  w.text(l.meta, { size: 9, color: MUTED, gap: 14 });
  w.text(l.greeting, { gap: 6 });
  for (const p of l.intro) w.text(p, { gap: 6 });
  w.space(8);

  const tableWidth = A4[0] - 2 * MARGIN;
  const cols = [tableWidth * 0.46, tableWidth * 0.18, tableWidth * 0.14, tableWidth * 0.22];
  const xs = [MARGIN];
  for (let i = 1; i < cols.length; i++) xs.push((xs[i - 1] as number) + (cols[i - 1] as number));
  const header = l.columns.map((h, i) => w.wrap(h, 8.5, w.bold, (cols[i] as number) - 8));
  const headerHeight = Math.max(...header.map((h) => h.length)) * 12 + 6;
  w.ensure(headerHeight + 20);
  header.forEach((lines, i) => {
    lines.forEach((line, j) => {
      w.page.drawText(line, {
        x: xs[i] as number,
        y: w.y - 9 - j * 12,
        size: 8.5,
        font: w.bold,
        color: INK,
      });
    });
  });
  w.y -= headerHeight;
  w.rule();
  for (const row of l.rows) {
    const desc = [row.description, ...row.bullets.map((b) => `• ${b}`)].flatMap((t, k) =>
      w
        .wrap(t, 9.5, k === 0 ? w.bold : w.regular, (cols[0] as number) - 10)
        .map((line) => ({ line, bold: k === 0 })),
    );
    const height = desc.length * 13 + 6;
    w.ensure(height);
    desc.forEach((d, j) => {
      w.page.drawText(d.line, {
        x: xs[0] as number,
        y: w.y - 10 - j * 13,
        size: 9.5,
        font: d.bold ? w.bold : w.regular,
        color: INK,
      });
    });
    row.cells.forEach((cell, i) => {
      const text = w.clean(cell);
      const right = (xs[i + 1] as number) + (cols[i + 1] as number) - 6;
      w.page.drawText(text, {
        x: right - w.width(text, 9.5, w.regular),
        y: w.y - 10,
        size: 9.5,
        font: w.regular,
        color: INK,
      });
    });
    w.y -= height;
    w.rule();
  }
  w.space(4);
  w.text(l.total, { bold: true, size: 11, gap: 14 });
  for (const line of l.closing) w.text(line, { gap: 4 });
  w.space(16);
  w.ensure(260);
  w.text(l.acceptanceTitle, { bold: true, size: 13, gap: 4 });
  w.text(l.acceptanceIntro, { gap: 8 });
  for (const a of l.acceptance.fields) w.blank(a);
  w.text(l.acceptance.statement, { gap: 6 });
  for (const a of l.acceptance.signing) w.blank(a);
  w.space(10);
  for (const p of l.clause) w.text(p, { size: 8.5, gap: 3 });
  w.space(8);
  w.text(l.validity, { size: 9 });
  w.text(l.signOff, { size: 9, color: MUTED });
  return finish(w, l.title);
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

/**
 * A text document (a DPA, a plan) as a PDF. With `signing`, a signing block follows the
 * text and its blanks are the document's fields.
 */
export async function textPdf(
  title: string,
  body: string,
  opts: { signing: boolean; language: Language },
): Promise<RenderedPdf> {
  const w = await start();
  w.text(title, { bold: true, size: 16, gap: 10 });
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (!line) {
      w.space(6);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading)
      w.text(heading[2] as string, { bold: true, size: heading[1] === "#" ? 13 : 11, gap: 2 });
    else w.text(line, { size: 9.5, gap: 1 });
  }
  if (opts.signing) {
    const block = SIGNING_BLOCK[opts.language];
    w.space(16);
    w.ensure(230);
    w.text(block.title, { bold: true, size: 13, gap: 8 });
    for (const a of block.fields) w.blank(a);
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
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const signature = await doc.embedPng(images.signature);
  const initials = images.initials ? await doc.embedPng(images.initials) : signature;
  const pages = doc.getPages();
  const w = new Writer(doc, regular, bold);
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
  w.text("Signature record", { bold: true, size: 16, gap: 4 });
  w.text("Simple electronic signature (eIDAS art. 3(10)), recorded by dembrane.", {
    size: 9,
    color: MUTED,
    gap: 12,
  });
  const rows: [string, string][] = [
    ["Document", a.documentTitle],
    ["Document id", a.documentId],
    ...(a.reference ? ([["Reference", a.reference]] as [string, string][]) : []),
    ["Version", String(a.version)],
    ["SHA-256 of the unsigned PDF", a.sha256],
    ["Signer", a.signerName],
    ...(a.signerRole ? ([["Role", a.signerRole]] as [string, string][]) : []),
    ["Email (verified at sign-in)", a.email],
    ["Organisation", a.organisation],
    ...(a.address ? ([["Address", a.address]] as [string, string][]) : []),
    ...(a.vatNumber ? ([["VAT number", a.vatNumber]] as [string, string][]) : []),
    ["May agree to data processing", a.dpaAuthorised ? "yes" : "no, the DPA is signed separately"],
    ["Signature made", a.method],
    ["SHA-256 of the signature image", a.imageSha256],
    ["Signed at (UTC)", a.signedAt],
    ["IP address", a.ip ?? "not recorded"],
    ["User agent", a.userAgent ?? "not recorded"],
    ["Signature id", a.signatureId],
  ];
  for (const t of a.legal)
    rows.push([
      `Pinned ${t.kind}`,
      `version ${t.version}${t.effectiveOn ? `, ${t.effectiveOn}` : ""}, SHA-256 ${t.sha256}`,
    ]);
  for (const [k, value] of rows) {
    const before = w.y;
    const page = w.page;
    w.text(k, { bold: true, size: 9, width: 150 });
    const after = w.y;
    if (w.page === page) w.y = before;
    w.text(value, { size: 9, x: MARGIN + 160 });
    w.y = Math.min(after, w.y) - 3;
  }
  w.space(10);
  w.text("Confirmation shown and accepted", { bold: true, size: 10, gap: 2 });
  w.text(a.confirmationText, { size: 9.5 });
}
