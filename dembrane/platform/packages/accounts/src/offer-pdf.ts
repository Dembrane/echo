import { brand } from "@dembrane/mail";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, PDFString, rgb } from "pdf-lib";
import displayTtf from "../assets/fonts/DMSans-Display.ttf" with { type: "file" };
import textTtf from "../assets/fonts/DMSans-Text.ttf" with { type: "file" };
import wordmarkPng from "../assets/offer/wordmark.png" with { type: "file" };
import type { AcceptanceField, ClauseLine, OfferContent, OfferGroup, OfferLayout } from "./offer";
import { layoutOffer } from "./offer";
import type { PlacedField, RenderedPdf } from "./pdf";

/**
 * The offer PDF, on the design system for what dembrane sends (brand/CALL_TO_CASH.md).
 * Every offer has one look, whatever its template and language; the template and the
 * language choose the words (offer.ts), never the layout.
 *
 * Page one reads top to bottom: the wordmark, what this is and its title, the facts in a
 * ruled row (reference, date, valid until, and the customer's own reference when given),
 * the greeting, the lines table ruled above and below with the numbers right-aligned, and
 * subtotal, VAT and total with the total the largest number on the page. The acceptance starts its own page: labelled lines to write
 * on, which become the fields, then the incorporation clause. dembrane's company details
 * and the page number sit in the footer of every page.
 *
 * One family at one weight (DM Sans 320, cut for print by assets/fonts/build.py); size and
 * space make the hierarchy. Measures are in points from the top-left of an A4 page.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
/** 20 mm each side. */
const MARGIN = 56.69;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const RIGHT = PAGE_W - MARGIN;
/** The wordmark's top and height; where the body starts and the last point it may reach. */
const MARK_TOP = 44;
const MARK_H = 17;
const BODY_TOP = 112;
const BODY_BOTTOM = 772;
/** The footer's rule and its two lines. */
const FOOTER_RULE = 790;
const FOOTER_TOP = 798;
/** DM Sans: ascent and descent per unit of size; a line's natural height is their sum. */
const ASCENT = 0.992;
const NATURAL = 1.302;
/** The same render must give the same bytes, so the dates are fixed. */
const EPOCH = new Date("2026-01-01T00:00:00Z");

type Color = ReturnType<typeof rgb>;
const hex = (h: string): Color =>
  rgb(
    Number.parseInt(h.slice(1, 3), 16) / 255,
    Number.parseInt(h.slice(3, 5), 16) / 255,
    Number.parseInt(h.slice(5, 7), 16) / 255,
  );
const TEXT = hex(brand.color.text);
const MUTED = hex(brand.color.muted);
const QUIET = hex(brand.color.quiet);
const CONTROL = hex(brand.color.control);
const ACTION = hex(brand.color.action);
const T = brand.type.print;
const STROKE = brand.shape.stroke.print;

/** Text at title sizes takes the display cut (optical size 24); running text the text cut. */
type FontKey = "text" | "display";
const fontFor = (size: number): FontKey => (size >= T.title ? "display" : "text");

interface Run {
  readonly t: string;
  readonly s: number;
  readonly c: Color;
  readonly underline?: boolean;
  readonly url?: string;
}
type Style = Omit<Run, "t">;

interface Para {
  readonly runs: readonly Run[];
  /** Line height as a multiple of the size. */
  readonly leading: number;
  readonly before?: number;
  readonly after?: number;
  readonly left?: number;
  readonly align?: "left" | "right";
  /** A list marker on the first line, `at` points from the container's left. */
  readonly marker?: { readonly at: number; readonly draw: Run | { disc: number; c: Color } };
}

interface Piece {
  readonly run: Run;
  readonly text: string;
  readonly width: number;
}
interface Word {
  readonly pieces: Piece[];
  readonly width: number;
  /** Width of the space before this word when it does not start a line. */
  readonly space: number;
}
interface Line {
  readonly words: Word[];
  readonly width: number;
  readonly size: number;
}
interface Laid {
  readonly para: Para;
  readonly lines: Line[];
  readonly height: number;
  readonly width: number;
}

/** The part of a fontkit font this file reads: glyph runs with their kerned advances. */
interface Shaper {
  layout(text: string): {
    glyphs: { codePoints: number[]; advanceWidth: number }[];
    positions: { xAdvance: number }[];
  };
  characterSet: number[];
}

/** Text cut where the kerning moves a glyph: each chunk is drawn at its own offset. */
interface Shaped {
  readonly chunks: readonly { readonly text: string; readonly at: number }[];
  /** Width per unit of size. */
  readonly width: number;
}

interface Assets {
  readonly fonts: Record<FontKey, Uint8Array>;
  readonly wordmark: Uint8Array;
}

let loaded: Promise<Assets> | null = null;
const read = (path: string) => Bun.file(path).bytes();
function assets(): Promise<Assets> {
  loaded ??= (async () => ({
    fonts: { text: await read(textTtf), display: await read(displayTtf) },
    wordmark: await read(wordmarkPng),
  }))();
  return loaded;
}

class Sheet {
  page!: PDFPage;
  /** Top of the next line, from the top of the page. */
  y = BODY_TOP;
  /** Space the last block asked for after itself; the next one's `before` overlaps it. */
  private pendingAfter = 0;
  readonly fields: PlacedField[] = [];
  private readonly known = new Map<string, boolean>();
  private readonly shaped = new Map<string, Shaped>();

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: Record<FontKey, PDFFont>,
    private readonly shapers: Record<FontKey, Shaper>,
    readonly wordmark: PDFImage,
  ) {
    this.newPage();
  }

  get pageNumber() {
    return this.doc.getPageCount();
  }

  /** Characters the font has no glyph for are left out of the PDF, never of the stored values. */
  clean(text: string): string {
    let out = "";
    for (const ch of text.replace(/\t/g, "    ")) {
      let ok = this.known.get(ch);
      if (ok === undefined) {
        ok = this.shapers.text.characterSet.includes(ch.codePointAt(0) as number);
        this.known.set(ch, ok);
      }
      if (ok) out += ch;
    }
    return out;
  }

  /**
   * The glyphs of `text` with the font's kerning. pdf-lib draws a string with plain
   * advances, so the text is cut wherever kerning shifts the next glyph.
   */
  private shape(text: string, font: FontKey): Shaped {
    const key = `${font}\u0000${text}`;
    const hit = this.shaped.get(key);
    if (hit) return hit;
    const run = this.shapers[font].layout(text);
    const chunks: { text: string; at: number }[] = [];
    let at = 0;
    let open = "";
    let openAt = 0;
    run.glyphs.forEach((glyph, i) => {
      if (!open) openAt = at;
      open += String.fromCodePoint(...glyph.codePoints);
      const advance = run.positions[i]?.xAdvance ?? glyph.advanceWidth;
      at += advance / 1000;
      if (advance !== glyph.advanceWidth) {
        chunks.push({ text: open, at: openAt });
        open = "";
      }
    });
    if (open) chunks.push({ text: open, at: openAt });
    const out = { chunks, width: at };
    this.shaped.set(key, out);
    return out;
  }

  width(text: string, size: number) {
    return this.shape(text, fontFor(size)).width * size;
  }

  /** Kerned text with its baseline at `baseline` (from the top of the page). */
  private text(text: string, x: number, baseline: number, run: Style) {
    const font = fontFor(run.s);
    for (const chunk of this.shape(text, font).chunks)
      this.page.drawText(chunk.text, {
        x: x + chunk.at * run.s,
        y: PAGE_H - baseline,
        size: run.s,
        font: this.fonts[font],
        color: run.c,
      });
  }

  /** Text whose top edge (not its baseline) is at `top`. */
  at(text: string, x: number, top: number, run: Style) {
    this.text(this.clean(text), x, top + ASCENT * run.s, run);
  }

  /** Text ending at `right`. */
  atRight(text: string, right: number, top: number, run: Style) {
    const t = this.clean(text);
    this.text(t, right - this.width(t, run.s), top + ASCENT * run.s, run);
  }

  rule(x1: number, x2: number, y: number, color: Color = QUIET) {
    this.page.drawLine({
      start: { x: x1, y: PAGE_H - y },
      end: { x: x2, y: PAGE_H - y },
      thickness: STROKE,
      color,
    });
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = BODY_TOP;
    this.pendingAfter = 0;
    const w = (MARK_H * this.wordmark.width) / this.wordmark.height;
    this.page.drawImage(this.wordmark, {
      x: MARGIN,
      y: PAGE_H - MARK_TOP - MARK_H,
      width: w,
      height: MARK_H,
    });
  }

  /** The footer of every page, drawn once the page count is known. */
  footers(lines: readonly string[]) {
    const pages = this.doc.getPages();
    const style = { s: T.caption, c: MUTED };
    pages.forEach((page, i) => {
      this.page = page;
      this.rule(MARGIN, RIGHT, FOOTER_RULE);
      lines.forEach((line, n) => {
        this.at(line, MARGIN, FOOTER_TOP + n * T.caption * 1.5, style);
      });
      this.atRight(`${i + 1} / ${pages.length}`, RIGHT, FOOTER_TOP, style);
    });
  }

  /** Breaks a paragraph into lines that fit `width`. */
  lay(para: Para, width: number): Laid {
    const left = para.left ?? 0;
    const words: Word[] = [];
    let pieces: Piece[] = [];
    let space = 0;
    let pendingSpace = 0;
    const flush = () => {
      if (!pieces.length) return;
      words.push({ pieces, width: pieces.reduce((s, p) => s + p.width, 0), space });
      pieces = [];
    };
    for (const raw of para.runs) {
      const run = { ...raw, t: this.clean(raw.t) };
      // Words end at spaces; a slash also lets a line break ("seat/" then "month").
      for (const part of run.t.split(/( +)|(?<=\/)(?=[^ /])/)) {
        if (!part) continue;
        if (part.startsWith(" ")) {
          flush();
          pendingSpace += this.width(part, run.s);
          space = pendingSpace;
          continue;
        }
        if (pieces.length && pieces[pieces.length - 1]?.text.endsWith("/")) {
          flush();
          space = 0;
          pendingSpace = 0;
        } else if (!pieces.length) {
          space = pendingSpace;
          pendingSpace = 0;
        }
        pieces.push({ run, text: part, width: this.width(part, run.s) });
      }
    }
    flush();

    const lines: Line[] = [];
    let current: Word[] = [];
    let used = 0;
    const size = Math.max(0, ...para.runs.map((r) => r.s));
    const close = () => {
      lines.push({ words: current, width: used, size });
      current = [];
      used = 0;
    };
    for (const word of words) {
      const next = used + (current.length ? word.space : 0) + word.width;
      if (current.length && next > width - left + 0.01) {
        close();
        current.push(word);
        used = word.width;
      } else {
        current.push(word);
        used = next;
      }
    }
    close();
    return { para, lines, height: lines.length * size * para.leading, width };
  }

  /** Draws laid-out lines with their top at `top`; `x` is the container's left edge. */
  drawLaid(laid: Laid, x: number, top: number) {
    const { para } = laid;
    let y = top;
    laid.lines.forEach((line, n) => {
      const left = para.left ?? 0;
      let cx = x + left + (para.align === "right" ? laid.width - left - line.width : 0);
      // The line's extra leading is split above and below its letters.
      const lineH = line.size * para.leading;
      const baseline = y + (lineH - line.size * NATURAL) / 2 + ASCENT * line.size;
      if (n === 0 && para.marker) this.marker(para.marker, x, baseline);
      // An underline (and its link) runs unbroken under the spaces of its run.
      let span: { run: Run; from: number; to: number } | null = null;
      const close = () => {
        if (span) this.underline(span.run, span.from, span.to, baseline);
        span = null;
      };
      line.words.forEach((word, i) => {
        if (i > 0) cx += word.space;
        for (const piece of word.pieces) {
          this.text(piece.text, cx, baseline, piece.run);
          const { run } = piece;
          if (run.underline) {
            if (span && span.run === run) span.to = cx + piece.width;
            else {
              close();
              span = { run, from: cx, to: cx + piece.width };
            }
          } else close();
          cx += piece.width;
        }
      });
      close();
      y += lineH;
    });
  }

  private marker(m: NonNullable<Para["marker"]>, x: number, baseline: number) {
    if ("disc" in m.draw) {
      const r = m.draw.disc * 0.14;
      this.page.drawCircle({
        x: x + m.at + r,
        y: PAGE_H - baseline + m.draw.disc * 0.3,
        size: r,
        color: m.draw.c,
      });
      return;
    }
    this.text(this.clean(m.draw.t), x + m.at, baseline, m.draw);
  }

  /** The font's own underline (0.1 of the size under the baseline, 0.05 thick), and the link. */
  private underline(run: Run, from: number, to: number, baseline: number) {
    const y = PAGE_H - baseline;
    this.page.drawLine({
      start: { x: from, y: y - run.s * 0.125 },
      end: { x: to, y: y - run.s * 0.125 },
      thickness: run.s * 0.05,
      color: run.c,
    });
    if (run.url) this.link(run.url, from, y - run.s * 0.31, to - from, run.s * NATURAL);
  }

  private link(url: string, x: number, y: number, width: number, height: number) {
    const annotation = this.doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + width, y + height],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    });
    this.page.node.addAnnot(this.doc.context.register(annotation));
  }

  /** Vertical room a block needs; a block that does not fit starts the next page. */
  room(height: number) {
    if (this.y + height > BODY_BOTTOM) this.newPage();
  }

  /** Space before the next block, overlapping what the last one asked for after itself. */
  gap(before: number) {
    this.y += Math.max(before, this.pendingAfter);
    this.pendingAfter = 0;
  }

  /** Ends a block: the space it wants after itself. */
  done(after: number) {
    this.pendingAfter = after;
  }

  para(para: Para, box: { x: number; width: number } = { x: MARGIN, width: CONTENT_W }) {
    const laid = this.lay(para, box.width);
    const before = Math.max(para.before ?? 0, this.pendingAfter);
    if (this.y + before + laid.height > BODY_BOTTOM) {
      this.newPage();
    } else this.y += before;
    this.pendingAfter = 0;
    this.drawLaid(laid, box.x, this.y);
    this.y += laid.height;
    this.pendingAfter = para.after ?? 0;
  }

  /** A line to write on under its label; the field's box sits on the line. */
  blank(field: AcceptanceField, x: number, width: number, top: number, room: number) {
    this.at(field.label, x, top, { s: T.caption, c: MUTED });
    const lineY = top + room;
    this.rule(x, x + width, lineY, CONTROL);
    const tall = field.kind === "signature" || field.kind === "initials";
    const boxHeight = tall ? 34 : 14;
    this.fields.push({
      page: this.pageNumber,
      x: x / PAGE_W,
      y: (lineY - boxHeight) / PAGE_H,
      width: width / PAGE_W,
      height: boxHeight / PAGE_H,
      kind: field.kind,
      label: field.label,
      required: field.required,
      key: field.key,
      ...(field.role && { role: field.role }),
    });
    return lineY;
  }

  /**
   * A box to tick with its label beside it, the field on the box. Returns the bottom of the
   * line.
   */
  tick(field: AcceptanceField, x: number, top: number): number {
    const SIZE = 12;
    this.page.drawRectangle({
      x,
      y: PAGE_H - top - SIZE,
      width: SIZE,
      height: SIZE,
      borderColor: CONTROL,
      borderWidth: STROKE * 1.5,
    });
    this.at(field.label, x + SIZE + 8, top + (SIZE - T.body) / 2 - 1, { s: T.body, c: TEXT });
    this.fields.push({
      page: this.pageNumber,
      x: x / PAGE_W,
      y: top / PAGE_H,
      width: SIZE / PAGE_W,
      height: SIZE / PAGE_H,
      kind: field.kind,
      label: field.label,
      required: field.required,
      key: field.key,
    });
    return top + SIZE;
  }
}

const BODY: Style = { s: T.body, c: TEXT };
const BODY_LEADING = brand.type.leading.body;
const CAPTION: Style = { s: T.caption, c: MUTED };
/** The incorporation clause: a step under body, as small print, still in the text colour. */
const SMALL: Style = { s: 9, c: TEXT };
const runs = (t: string, style: Style): Run[] => [{ ...style, t }];
const text = (t: string, over: Partial<Para> = {}): Para => ({
  runs: runs(t, BODY),
  leading: BODY_LEADING,
  ...over,
});

/** The runs of a clause line: names linked in the action colour, the marked words underlined. */
function clauseRuns(line: ClauseLine, style: Style): Run[] {
  const out: Run[] = [];
  for (const part of line) {
    if (typeof part === "string") out.push({ ...style, t: part });
    else if ("link" in part)
      out.push({ ...style, t: part.link, c: ACTION, underline: true, url: part.url });
    else if ("underline" in part) out.push({ ...style, t: part.underline, underline: true });
  }
  return out;
}

/** What the document is and its title. */
function heading(s: Sheet, kind: string | null, title: string, size: number) {
  if (kind) s.para({ runs: runs(kind, CAPTION), leading: 1.4, after: 4 });
  s.para({ runs: runs(title, { s: size, c: TEXT }), leading: brand.type.leading.title });
}

/**
 * The facts ruled above and below: label over value, in equal columns while every one fits
 * its column. When one does not (a long customer reference), each column takes what it needs
 * plus an equal share of what is left, and facts that still do not fit go to a second row.
 */
function facts(s: Sheet, l: OfferLayout) {
  s.gap(20);
  const height = 44;
  const GAP = 12;
  const need = ([label, value]: readonly [string, string]) =>
    Math.max(s.width(label, CAPTION.s), s.width(value, BODY.s)) + GAP;
  const rows: (readonly [string, string])[][] = [[]];
  let used = 0;
  for (const f of l.facts) {
    const row = rows[rows.length - 1] as (readonly [string, string])[];
    if (row.length && used + need(f) > CONTENT_W) {
      rows.push([f]);
      used = need(f);
    } else {
      row.push(f);
      used += need(f);
    }
  }
  s.room(height * rows.length);
  const top = s.y;
  s.rule(MARGIN, RIGHT, top);
  rows.forEach((row, r) => {
    const y = top + r * height;
    if (r) s.rule(MARGIN, RIGHT, y);
    const equal = CONTENT_W / row.length;
    const fits = row.every((f) => need(f) <= equal);
    const spare = CONTENT_W - row.reduce((sum, f) => sum + need(f), 0);
    let x = MARGIN;
    for (const f of row) {
      s.at(f[0], x, y + 9, CAPTION);
      s.at(f[1], x, y + 23, BODY);
      x += fits ? equal : need(f) + spare / row.length;
    }
  });
  s.rule(MARGIN, RIGHT, top + height * rows.length);
  s.y = top + height * rows.length;
  s.done(28);
}

/** The lines table: a header of captions, a row per line, the numbers right-aligned. */
function lines(s: Sheet, l: OfferLayout) {
  const widths = [CONTENT_W - 300, 110, 70, 120];
  const xs = [MARGIN];
  for (const w of widths) xs.push((xs[xs.length - 1] as number) + w);
  const GUTTER = 12;
  // Each cell's box: the first starts at the margin, the last ends at it.
  const box = (i: number) => ({
    x: (xs[i] as number) + (i === 0 ? 0 : GUTTER / 2),
    width: (widths[i] as number) - (i === 0 || i === widths.length - 1 ? GUTTER / 2 : GUTTER),
  });
  const PAD = 9;
  const row = (cells: Para[][]) => {
    const laid = cells.map((paras, i) => paras.map((p) => s.lay(p, box(i).width)));
    const content = Math.max(...laid.map((c) => c.reduce((h, p) => h + p.height, 0)));
    const height = PAD + content + PAD;
    if (s.y + height > BODY_BOTTOM) {
      s.newPage();
      s.rule(MARGIN, RIGHT, s.y, TEXT);
    }
    const top = s.y;
    laid.forEach((cell, i) => {
      let y = top + PAD;
      for (const p of cell) {
        s.drawLaid(p, box(i).x, y);
        y += p.height;
      }
    });
    s.y = top + height;
    s.rule(MARGIN, RIGHT, s.y);
  };

  s.gap(24);
  s.room(80);
  // Only options to pick from: no table here, they follow with their own.
  if (l.groups.length) {
    s.rule(MARGIN, RIGHT, s.y, TEXT);
    row(
      l.columns.map((c, i) => [
        { runs: runs(c, CAPTION), leading: 1.4, align: i === 0 ? "left" : "right" },
      ]),
    );
  }
  const cells = (r: OfferLayout["rows"][number]): Para[][] => [
    [
      text(r.description),
      ...r.bullets.map(
        (b): Para => ({
          runs: runs(b, { ...BODY, c: MUTED }),
          leading: BODY_LEADING,
          left: 11,
          marker: { at: 1, draw: { disc: T.body, c: MUTED } },
        }),
      ),
    ],
    ...r.cells.map((c): Para[] => [text(c, { align: "right" })]),
  ];
  // A section: its heading across the table, a step up, then its lines and, ruled like a
  // row, its subtotal in the amount column.
  const group = (g: OfferGroup) => {
    if (g.title) {
      const laid = s.lay({ runs: runs(g.title, { s: T.lead, c: TEXT }), leading: 1.3 }, CONTENT_W);
      const height = 16 + laid.height + 6;
      // The heading never ends a page alone: room for it and a line under it.
      if (s.y + height + 40 > BODY_BOTTOM) {
        s.newPage();
        s.rule(MARGIN, RIGHT, s.y, TEXT);
      }
      s.drawLaid(laid, MARGIN, s.y + 16);
      s.y += height;
      s.rule(MARGIN, RIGHT, s.y);
    }
    for (const r of g.rows) row(cells(r));
    if (g.subtotal)
      row([
        [{ runs: runs(g.subtotal[0], { ...BODY, c: MUTED }), leading: BODY_LEADING }],
        [],
        [],
        [text(g.subtotal[1], { align: "right" })],
      ]);
  };
  for (const g of l.groups) group(g);

  // Subtotal and VAT, then the total over a rule in the text colour, one step up.
  const labelX = (xs[1] as number) + GUTTER / 2;
  const totals = l.totals;
  s.room(30 * totals.length + 10);
  s.y += 4;
  totals.forEach(([label, amount], i) => {
    const last = i === totals.length - 1;
    if (last) {
      s.y += 6;
      s.rule(labelX, RIGHT, s.y, TEXT);
      s.y += 9;
      const style = { s: T.lead, c: TEXT };
      s.at(label, labelX, s.y, style);
      s.atRight(amount, RIGHT, s.y, style);
      s.y += T.lead * 1.4;
    } else {
      s.y += 5;
      s.at(label, labelX, s.y, { ...BODY, c: MUTED });
      s.atRight(amount, RIGHT, s.y, BODY);
      s.y += T.body * BODY_LEADING;
    }
  });
  // Without VAT, the reason sits under the total, as the invoice puts it.
  for (const note of [l.vatNote, l.chargeNote])
    if (note)
      s.para(
        { runs: runs(note, { ...CAPTION, s: 8.5 }), leading: 1.45, before: 2 },
        { x: labelX, width: RIGHT - labelX },
      );

  // Optional lines apart, under their own heading and table, after the total they are not in.
  if (l.optional) {
    s.gap(28);
    s.room(110);
    s.para({ runs: runs(l.optional.title, { s: T.lead, c: TEXT }), leading: 1.3, after: 2 });
    s.para({ runs: runs(l.optional.note, CAPTION), leading: 1.4, after: 10 });
    s.gap(0);
    s.rule(MARGIN, RIGHT, s.y, TEXT);
    row(
      l.columns.map((c, i) => [
        { runs: runs(c, CAPTION), leading: 1.4, align: i === 0 ? "left" : "right" },
      ]),
    );
    for (const g of l.optional.groups) group(g);
  }

  // The options to pick from: each under its name, with its amount and, when exactly one is
  // picked, the total the offer comes to with it. The ticks are in the acceptance.
  if (l.choices) {
    s.gap(28);
    s.room(130);
    s.para({ runs: runs(l.choices.title, { s: T.lead, c: TEXT }), leading: 1.3, after: 2 });
    s.para({ runs: runs(l.choices.note, CAPTION), leading: 1.4, after: 10 });
    s.gap(0);
    s.rule(MARGIN, RIGHT, s.y, TEXT);
    row(
      l.columns.map((c, i) => [
        { runs: runs(c, CAPTION), leading: 1.4, align: i === 0 ? "left" : "right" },
      ]),
    );
    for (const o of l.choices.options) {
      group({ title: o.label, rows: o.rows, subtotal: o.amount });
      if (o.total) row([[text(o.total[0])], [], [], [text(o.total[1], { align: "right" })]]);
    }
  }
  s.done(36);
}

/**
 * The acceptance: what signing means, then a labelled line per field. Organisation and
 * address get the full width; the date and the signature share the last line.
 */
function acceptance(s: Sheet, l: OfferLayout) {
  s.para(text(l.acceptanceIntro, { before: 14 }));
  s.para(text(l.acceptance.statement, { before: 6 }));
  s.gap(18);
  if (l.choices) {
    s.room(30 + 22 * l.choices.fields.length);
    s.para({ runs: runs(l.choices.acceptanceTitle, CAPTION), leading: 1.4, after: 8 });
    for (const field of l.choices.fields) {
      s.room(22);
      s.y = s.tick(field, MARGIN, s.y) + 10;
    }
    s.y += 8;
  }
  for (const field of l.acceptance.fields) {
    s.room(36);
    s.y = s.blank(field, MARGIN, CONTENT_W, s.y, 26) + 11;
  }
  s.room(56);
  const [date, signature] = l.acceptance.signing;
  const dateW = 150;
  const top = s.y;
  let bottom = top;
  // Both on one line, with the signature's room above it.
  if (date) bottom = s.blank(date, MARGIN, dateW, top, 48);
  if (signature) {
    const x = MARGIN + dateW + 24;
    bottom = s.blank(signature, x, RIGHT - x, top, 48);
  }
  s.y = bottom;
  // A second signature under the first: another signatory of theirs, or dembrane's.
  const second = l.second;
  if (second) {
    s.gap(26);
    s.room(80 + 36 * (second.printed.length + second.fields.length));
    s.para({ runs: runs(second.title, { s: T.lead, c: TEXT }), leading: 1.3, after: 8 });
    for (const [label, value] of second.printed) {
      s.at(label, MARGIN, s.y, CAPTION);
      s.at(value, MARGIN, s.y + 13, BODY);
      s.y += 34;
    }
    for (const field of second.fields) {
      s.room(36);
      s.y = s.blank(field, MARGIN, CONTENT_W, s.y, 26) + 11;
    }
    s.room(56);
    const [sDate, sSignature] = second.signing;
    const sTop = s.y;
    let sBottom = sTop;
    if (sDate) sBottom = s.blank(sDate, MARGIN, dateW, sTop, 48);
    if (sSignature) {
      const x = MARGIN + dateW + 24;
      sBottom = s.blank(sSignature, x, RIGHT - x, sTop, 48);
    }
    s.y = sBottom;
  }
  s.done(32);
}

/**
 * Amendments: terms agreed with this customer that take precedence over the standard
 * documents. In body size, where the offer is read, each under its number and title.
 */
function amendments(s: Sheet, l: OfferLayout) {
  if (!l.amendments.length) return;
  s.room(60);
  s.para({ runs: runs(l.amendmentsTitle, { s: T.lead, c: TEXT }), leading: 1.3, after: 4 });
  for (const a of l.amendments) {
    s.room(40);
    s.para({
      runs: [...runs(`${a.label}  `, { ...CAPTION, s: T.body }), ...runs(a.title, BODY)],
      leading: BODY_LEADING,
      before: 10,
    });
    for (const p of a.paragraphs) s.para(text(p, { before: 4 }));
  }
  s.done(36);
}

/** The incorporation clause in small print, its documents numbered. */
function clause(s: Sheet, l: OfferLayout) {
  const { opening, items, closing } = l.clauseParts;
  const small = (t: string, over: Partial<Para> = {}): Para => ({
    runs: runs(t, SMALL),
    leading: 1.45,
    ...over,
  });
  s.gap(0);
  s.room(20);
  s.rule(MARGIN, RIGHT, s.y);
  s.para(small(opening, { before: 14, after: 6 }));
  items.forEach((item, i) => {
    s.para({
      runs: clauseRuns(item, SMALL),
      leading: 1.45,
      before: 4,
      left: 16,
      marker: { at: 0, draw: { ...SMALL, c: MUTED, t: `${i + 1}.` } },
    });
  });
  for (const p of closing) s.para(small(p, { before: 6 }));
}

/**
 * Who the invoice goes to when it is not the customer: under the totals, where the reader
 * has just seen what is paid, a heading and the party one line each.
 */
function billing(s: Sheet, l: OfferLayout) {
  if (!l.billTo) return;
  s.room(40 + 16 * l.billTo.lines.length);
  s.para({ runs: runs(l.billTo.title, { s: T.lead, c: TEXT }), leading: 1.3, after: 4 });
  for (const line of l.billTo.lines) s.para({ runs: runs(line, BODY), leading: BODY_LEADING });
  s.done(36);
}

/**
 * How an offer invoiced in parts is invoiced: a heading, then one ruled row per part with
 * its name, when it falls due and its amount, right-aligned like the lines above.
 */
function parts(s: Sheet, l: OfferLayout) {
  if (!l.parts) return;
  const ROW = 22;
  const whenX = MARGIN + 90;
  s.room(40 + ROW * (l.parts.rows.length + 1));
  s.para({ runs: runs(l.parts.title, { s: T.lead, c: TEXT }), leading: 1.3, after: 8 });
  const [part, when, amount] = l.parts.columns;
  s.rule(MARGIN, RIGHT, s.y, TEXT);
  s.at(part, MARGIN, s.y + 7, CAPTION);
  s.at(when, whenX, s.y + 7, CAPTION);
  s.atRight(amount, RIGHT, s.y + 7, CAPTION);
  s.y += ROW;
  for (const [name, due, money] of l.parts.rows) {
    s.room(ROW);
    s.rule(MARGIN, RIGHT, s.y);
    s.at(name, MARGIN, s.y + 6, BODY);
    s.at(due, whenX, s.y + 6, BODY);
    s.atRight(money, RIGHT, s.y + 6, BODY);
    s.y += ROW;
  }
  s.rule(MARGIN, RIGHT, s.y);
  s.done(36);
}

/** The one layout of an offer; `l` carries the words of its template and language. */
function draw(s: Sheet, l: OfferLayout) {
  heading(s, l.kind, l.title, T.display);
  facts(s, l);
  s.para(text(l.greeting));
  // A paragraph that starts with "## " is a heading, a step up, over the ones after it.
  l.intro.forEach((p, i) => {
    if (p.startsWith("## "))
      s.para({
        runs: runs(p.slice(3), { s: T.lead, c: TEXT }),
        leading: 1.3,
        before: 18,
        after: 4,
      });
    else s.para(text(p, { before: i === 0 ? 8 : 6 }));
  });
  lines(s, l);
  billing(s, l);
  parts(s, l);
  amendments(s, l);
  // An empty line is the space above the sign-off ("Best regards," and the team).
  l.closing.forEach((line, i) => {
    if (line) s.para(text(line, { before: l.closing[i - 1] === "" ? 14 : 0 }));
  });

  // The acceptance starts its own page.
  s.newPage();
  heading(s, l.kind, l.acceptanceTitle, T.title);
  acceptance(s, l);
  clause(s, l);
}

/** The offer in its one look, with the acceptance lines as fields. */
export async function offerPdf(content: OfferContent): Promise<RenderedPdf> {
  const a = await assets();
  const l = layoutOffer(content);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // A fixed name keeps the bytes of the same render the same.
  const embed = (key: FontKey, name: string) =>
    doc.embedFont(a.fonts[key], { subset: true, customName: name });
  const fonts = {
    text: await embed("text", "DMSans-Text"),
    display: await embed("display", "DMSans-Display"),
  };
  const shaper = (key: FontKey) => fontkit.create(a.fonts[key]) as unknown as Shaper;
  const sheet = new Sheet(
    doc,
    fonts,
    { text: shaper("text"), display: shaper("display") },
    await doc.embedPng(a.wordmark),
  );
  draw(sheet, l);
  sheet.footers(l.company.lines);
  doc.setTitle(l.title);
  doc.setAuthor("dembrane B.V.");
  doc.setProducer("dembrane echo");
  doc.setCreator("dembrane echo");
  doc.setCreationDate(EPOCH);
  doc.setModificationDate(EPOCH);
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: doc.getPageCount(), fields: sheet.fields };
}
