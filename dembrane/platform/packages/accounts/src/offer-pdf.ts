import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, PDFString, rgb } from "pdf-lib";
import boldTtf from "../assets/fonts/DMSans-Bold.ttf" with { type: "file" };
import lightTtf from "../assets/fonts/DMSans-Light.ttf" with { type: "file" };
import calendarPng from "../assets/offer/calendar.png" with { type: "file" };
import logoPng from "../assets/offer/logo.png" with { type: "file" };
import sparklesPng from "../assets/offer/sparkles.png" with { type: "file" };
import type { AcceptanceField, ClauseLine, OfferContent, OfferLayout } from "./offer";
import { layoutOffer } from "./offer";
import type { PlacedField, RenderedPdf } from "./pdf";

/**
 * The offer PDF. Every offer has one look, whatever its template and language: the
 * letterhead and logo on every page, DM Sans light in black, the green table head, the
 * acceptance block on its own page with the legal texts linked by name, and the validity
 * line in the footer. It is the look the Google Doc templates of sales share; the template
 * and the language only choose the words (offer.ts), never the layout.
 *
 * Text flows the way the Docs do: a line is its font's natural height times the paragraph's
 * line spacing, the text sits at the top of that line, and the space after one paragraph
 * and before the next do not add up (the larger one counts). All measures are in points from
 * the top-left of an A4 page.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
/** The page margin, and the indent of body text inside it (the Docs set text at 56.85). */
const MARGIN = 28.35;
const INDENT = 28.5;
const CONTENT_W = PAGE_W - 2 * MARGIN;
/** Where the body starts under the letterhead, and the last point a line may reach above the footer. */
const BODY_TOP = 113.14;
const BODY_BOTTOM = 762;
/** DM Sans: ascent and descent per unit of size; a line's natural height is their sum. */
const ASCENT = 0.992;
const NATURAL = 1.302;
/** The same render must give the same bytes, so the dates are fixed. */
const EPOCH = new Date("2026-01-01T00:00:00Z");

type FontKey = "light" | "bold";
type Color = ReturnType<typeof rgb>;
type Emoji = "sparkles" | "calendar";

const hex = (h: string): Color =>
  rgb(
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  );
const BLACK = hex("000000");
const LETTERHEAD = hex("646568");
const FOOTER_GREY = hex("666666");
const HEAD_FILL = hex("b7feb9");

interface TextRun {
  readonly t: string;
  readonly f: FontKey;
  readonly s: number;
  readonly c: Color;
  readonly underline?: boolean;
  readonly url?: string;
}
interface EmojiRun {
  readonly emoji: Emoji;
  readonly s: number;
}
type Run = TextRun | EmojiRun;

interface Para {
  readonly runs: readonly Run[];
  /** Natural height of a line that holds no text (the paragraph mark's font). */
  readonly empty: number;
  readonly line: number;
  readonly before?: number;
  readonly after?: number;
  readonly left?: number;
  readonly right?: number;
  /** Extra indent of the first line; later lines start at `left`. */
  readonly first?: number;
  readonly align?: "left" | "right" | "center";
  /** A list marker on the first line, `at` points from the container's left. */
  readonly marker?: { readonly at: number; readonly draw: TextRun | { disc: number; c: Color } };
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
  readonly natural: number;
  readonly size: number;
  readonly indent: number;
}
interface Laid {
  readonly para: Para;
  readonly lines: Line[];
  readonly height: number;
  readonly width: number;
}

interface Cell {
  readonly paras: readonly Para[];
}
interface Row {
  readonly cells: readonly Cell[];
  readonly minHeight: number;
  readonly fill?: Color;
}
interface Table {
  readonly x: number;
  readonly cols: readonly number[];
  readonly pad: number;
  readonly border: { readonly width: number; readonly color: Color };
  readonly rows: readonly Row[];
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
  readonly logo: Uint8Array;
  readonly emoji: Record<Emoji, Uint8Array>;
}

let loaded: Promise<Assets> | null = null;
const read = (path: string) => Bun.file(path).bytes();
function assets(): Promise<Assets> {
  loaded ??= (async () => ({
    fonts: {
      light: await read(lightTtf),
      bold: await read(boldTtf),
    },
    logo: await read(logoPng),
    emoji: { sparkles: await read(sparklesPng), calendar: await read(calendarPng) },
  }))();
  return loaded;
}

class Sheet {
  page!: PDFPage;
  /** Top of the next line, from the top of the page. */
  y = BODY_TOP;
  /** Space the last paragraph asked for after itself; the next one's `before` overlaps it. */
  private pendingAfter = 0;
  readonly fields: PlacedField[] = [];
  private readonly known = new Map<string, boolean>();
  private readonly shaped = new Map<string, Shaped>();

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: Record<FontKey, PDFFont>,
    private readonly shapers: Record<FontKey, Shaper>,
    readonly logo: PDFImage,
    readonly emoji: Record<Emoji, PDFImage>,
    private readonly layout: OfferLayout,
  ) {
    this.newPage();
  }

  get pageNumber() {
    return this.doc.getPageCount();
  }

  /** Characters the font has no glyph for are left out of the PDF, never of the stored values. */
  clean(text: string, font: FontKey): string {
    let out = "";
    for (const ch of text.replace(/\t/g, "    ")) {
      const key = `${font}${ch}`;
      let ok = this.known.get(key);
      if (ok === undefined) {
        ok = this.shapers[font].characterSet.includes(ch.codePointAt(0) as number);
        this.known.set(key, ok);
      }
      if (ok) out += ch;
    }
    return out;
  }

  /**
   * The glyphs of `text` with the font's kerning, as the Docs set it. pdf-lib draws a string
   * with plain advances, so the text is cut wherever kerning shifts the next glyph.
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

  width(text: string, run: Pick<TextRun, "f" | "s">) {
    return this.shape(text, run.f).width * run.s;
  }

  /** Kerned text with its baseline at `baseline` (from the top of the page). */
  private text(text: string, x: number, baseline: number, run: Pick<TextRun, "f" | "s" | "c">) {
    for (const chunk of this.shape(text, run.f).chunks)
      this.page.drawText(chunk.text, {
        x: x + chunk.at * run.s,
        y: PAGE_H - baseline,
        size: run.s,
        font: this.fonts[run.f],
        color: run.c,
      });
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = BODY_TOP;
    this.pendingAfter = 0;
    this.drawFrame();
  }

  /** Text whose top edge (not its baseline) is at `top`. */
  at(text: string, x: number, top: number, run: Pick<TextRun, "f" | "s" | "c">) {
    this.text(text, x, top + ASCENT * run.s, run);
  }

  private image(img: PDFImage, x: number, top: number, side: number) {
    this.page.drawImage(img, { x, y: PAGE_H - top - side, width: side, height: side });
  }

  /** The letterhead with the logo, and the footer: the same on every page. */
  private drawFrame() {
    const c = LETTERHEAD;
    const [address, vat, iban, kvk] = this.layout.letterhead.rows;
    this.image(this.logo, 515.1, 26.04, 44.62);
    this.at(this.clean(this.layout.letterhead.name, "light"), 44.85, 50.22, {
      f: "light",
      s: 10.5,
      c,
    });
    const d = { f: "light" as const, s: 9.5, c };
    const cell = (text: string, x: number, top: number) =>
      this.at(this.clean(text, d.f), x, top, d);
    // Two rows of label and value, in the four columns of the Docs' letterhead table.
    cell(address?.[0] ?? "", 44.85, 65.95);
    cell(address?.[1] ?? "", 102.18, 65.95);
    cell(vat?.[0] ?? "", 296.82, 65.95);
    cell(vat?.[1] ?? "", 372.93, 65.95);
    cell(iban?.[0] ?? "", 44.85, 80.17);
    cell(iban?.[1] ?? "", 102.18, 80.17);
    cell(kvk?.[0] ?? "", 296.82, 80.17);
    cell(kvk?.[1] ?? "", 372.93, 80.17);

    const validity = textRuns(this.layout.validity, {
      f: "light",
      s: 10,
      c: FOOTER_GREY,
    });
    const laid = this.lay(
      { runs: this.cleanRuns(validity), empty: 10 * NATURAL, line: 1.15, align: "center" },
      PAGE_W,
    );
    this.drawLaid(laid, 0, 776.31);
    const signOff = { f: "bold" as const, s: 10, c: BLACK };
    const text = this.clean(this.layout.signOff, "bold");
    const x = (PAGE_W - this.width(text, signOff)) / 2;
    this.at(text, x, 791.28, signOff);
  }

  private cleanRuns(runs: readonly Run[]): Run[] {
    return runs.map((r) => ("emoji" in r ? r : { ...r, t: this.clean(r.t, r.f) }));
  }

  /** Breaks a paragraph into lines that fit `width`. */
  lay(para: Para, width: number): Laid {
    const left = para.left ?? 0;
    const right = para.right ?? 0;
    const first = para.first ?? 0;
    const words: Word[] = [];
    let pieces: Piece[] = [];
    let space = 0;
    let pendingSpace = 0;
    const flush = () => {
      if (!pieces.length) return;
      words.push({ pieces, width: pieces.reduce((s, p) => s + p.width, 0), space });
      pieces = [];
    };
    for (const run of para.runs) {
      if ("emoji" in run) {
        pieces.push({ run, text: "", width: EMOJI_ADVANCE * run.s });
        continue;
      }
      // Words end at spaces; a slash also lets a line break ("Prijs/seat/" then "maand").
      for (const part of run.t.split(/( +)|(?<=\/)(?=[^ /])/)) {
        if (!part) continue;
        if (part.startsWith(" ")) {
          flush();
          pendingSpace += this.width(part, run);
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
        pieces.push({ run, text: part, width: this.width(part, run) });
      }
    }
    flush();

    const lines: Line[] = [];
    let current: Word[] = [];
    let used = 0;
    const limit = (n: number) => width - left - right - (n === 0 ? first : 0);
    const close = () => {
      const sizes = current.flatMap((w) => w.pieces.map((p) => p.run.s));
      const text = current.flatMap((w) => w.pieces.filter((p) => !("emoji" in p.run)));
      const size = text.length ? Math.max(...text.map((p) => p.run.s)) : 0;
      lines.push({
        words: current,
        width: used,
        natural: size ? size * NATURAL : sizes.length ? Math.max(...sizes) * NATURAL : para.empty,
        size,
        indent: left + (lines.length === 0 ? first : 0),
      });
      current = [];
      used = 0;
    };
    for (const word of words) {
      const next = used + (current.length ? word.space : 0) + word.width;
      if (current.length && next > limit(lines.length) + 0.01) {
        close();
        current.push(word);
        used = word.width;
      } else {
        current.push(word);
        used = next;
      }
    }
    close();
    const height = lines.reduce((s, l) => s + l.natural * para.line, 0);
    return { para, lines, height, width };
  }

  /** Draws laid-out lines with their top at `top`; `x` is the container's left edge. */
  drawLaid(laid: Laid, x: number, top: number) {
    const { para } = laid;
    const right = para.right ?? 0;
    let y = top;
    laid.lines.forEach((line, n) => {
      const room = laid.width - line.indent - right - line.width;
      let cx =
        x + line.indent + (para.align === "right" ? room : para.align === "center" ? room / 2 : 0);
      const baseline = y + ASCENT * (line.size || para.empty / NATURAL);
      if (n === 0 && para.marker) this.marker(para.marker, x, baseline);
      // An underline (and its link) runs unbroken under the spaces of its run.
      let span: { run: TextRun; from: number; to: number } | null = null;
      const close = () => {
        if (span) this.underline(span.run, span.from, span.to, baseline);
        span = null;
      };
      line.words.forEach((word, i) => {
        if (i > 0) cx += word.space;
        for (const piece of word.pieces) {
          this.piece(piece, cx, baseline);
          const { run } = piece;
          if (!("emoji" in run) && run.underline) {
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
      y += line.natural * para.line;
    });
  }

  private marker(m: NonNullable<Para["marker"]>, x: number, baseline: number) {
    if ("disc" in m.draw) {
      const r = m.draw.disc * 0.19;
      this.page.drawCircle({
        x: x + m.at + r + 0.6,
        y: PAGE_H - baseline + m.draw.disc * 0.31,
        size: r,
        color: m.draw.c,
      });
      return;
    }
    this.text(m.draw.t, x + m.at, baseline, m.draw);
  }

  private piece(piece: Piece, x: number, baseline: number) {
    const { run } = piece;
    if ("emoji" in run) {
      const side = run.s * 1.17;
      this.image(this.emoji[run.emoji], x + run.s * 0.04, baseline - run.s * 0.93, side);
      return;
    }
    this.text(piece.text, x, baseline, run);
  }

  /** The font's own underline (0.1 of the size under the baseline, 0.05 thick), and the link. */
  private underline(run: TextRun, from: number, to: number, baseline: number) {
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
  private room(height: number) {
    if (this.y + height > BODY_BOTTOM) this.newPage();
  }

  para(para: Para, box: { x: number; width: number } = { x: MARGIN, width: CONTENT_W }) {
    const laid = this.lay({ ...para, runs: this.cleanRuns(para.runs) }, box.width);
    const before = Math.max(para.before ?? 0, this.pendingAfter);
    this.room(before + laid.height);
    this.y += before;
    this.drawLaid(laid, box.x, this.y);
    this.y += laid.height;
    this.pendingAfter = para.after ?? 0;
  }

  /** A table whose rows stay whole; a row that does not fit moves to the next page. */
  table(t: Table) {
    this.y += this.pendingAfter;
    this.pendingAfter = 0;
    const b = t.border.width;
    const xs = [t.x];
    for (const w of t.cols) xs.push((xs[xs.length - 1] as number) + w);
    const right = xs[xs.length - 1] as number;
    const rule = (x1: number, y1: number, x2: number, y2: number) =>
      this.page.drawLine({
        start: { x: x1, y: PAGE_H - y1 },
        end: { x: x2, y: PAGE_H - y2 },
        thickness: b,
        color: t.border.color,
      });
    let open = false;
    for (const row of t.rows) {
      const laid = row.cells.map((cell, i) =>
        cell.paras.map((p) =>
          this.lay({ ...p, runs: this.cleanRuns(p.runs) }, (t.cols[i] as number) - 2 * t.pad),
        ),
      );
      const content = Math.max(
        row.minHeight,
        ...laid.map((cell) => 2 * t.pad + cell.reduce((s, l) => s + l.height, 0)),
      );
      if (this.y + b + content + b > BODY_BOTTOM) {
        this.newPage();
        open = false;
      }
      const top = this.y;
      if (row.fill)
        this.page.drawRectangle({
          x: t.x,
          y: PAGE_H - (top + b + content),
          width: right - t.x,
          height: content + b,
          color: row.fill,
        });
      if (!open) rule(t.x - b / 2, top + b / 2, right + b / 2, top + b / 2);
      open = true;
      laid.forEach((cell, i) => {
        let y = top + b + t.pad;
        for (const l of cell) {
          this.drawLaid(l, (xs[i] as number) + t.pad, y);
          y += l.height;
        }
      });
      const bottom = top + b + content;
      rule(t.x - b / 2, bottom + b / 2, right + b / 2, bottom + b / 2);
      for (const x of xs) rule(x, top + b / 2, x, bottom + b / 2);
      this.y = bottom;
    }
    this.y += b;
  }

  /**
   * One line of the acceptance block: the words, then the rule to write on. The field's
   * box sits on the rule. `reach` is how far a typed value may run (past the rule, so a
   * long address keeps a readable size); the signature gets room above the rule.
   */
  blanks(
    items: readonly {
      field: AcceptanceField;
      style: Omit<TextRun, "t">;
      /** From the end of the words to the rule, and from the last rule to these words. */
      gap: number;
      lead?: number;
      rule: number;
      reach?: number;
    }[],
    opts: { above: number; line: number },
  ) {
    const size = items[0]?.style.s ?? 10.5;
    const height = NATURAL * size * opts.line;
    this.y += this.pendingAfter;
    this.pendingAfter = 0;
    this.room(opts.above + height);
    this.y += opts.above;
    const ruleY = this.y + ASCENT * size + 0.95;
    let x = MARGIN + INDENT;
    for (const item of items) {
      x += item.lead ?? 0;
      const label = this.clean(item.field.prefix, item.style.f);
      this.at(label, x, this.y, item.style);
      const start = x + this.width(label, item.style) + item.gap;
      this.page.drawLine({
        start: { x: start, y: PAGE_H - ruleY },
        end: { x: start + item.rule, y: PAGE_H - ruleY },
        thickness: 0.75,
        color: item.style.c,
      });
      const tall = item.field.kind === "signature" || item.field.kind === "initials";
      const boxHeight = tall ? 32 : 14;
      this.fields.push({
        page: this.pageNumber,
        x: start / PAGE_W,
        y: (ruleY - boxHeight) / PAGE_H,
        width: (item.reach ?? item.rule) / PAGE_W,
        height: boxHeight / PAGE_H,
        kind: item.field.kind,
        label: item.field.label,
        required: item.field.required,
        key: item.field.key,
      });
      x = start + item.rule;
    }
    this.y += height;
  }
}

/** The emoji of the templates take this much of the line per unit of size. */
const EMOJI_ADVANCE = 1.245;
const EMOJI: Record<string, Emoji> = { "✨": "sparkles", "\u{1F4C5}": "calendar" };

/** Text as runs in one style, with the two emoji the templates use set as images. */
function textRuns(text: string, style: Omit<TextRun, "t">): Run[] {
  const runs: Run[] = [];
  for (const part of text.split(/(✨|\u{1F4C5})/u)) {
    if (!part) continue;
    const emoji = EMOJI[part];
    runs.push(emoji ? { emoji, s: style.s } : { ...style, t: part });
  }
  return runs;
}

/** The runs of a clause line: names linked in `link` colour, the marked words underlined. */
function clauseRuns(line: ClauseLine, style: Omit<TextRun, "t">, link: Color): Run[] {
  const runs: Run[] = [];
  for (const part of line) {
    if (typeof part === "string") runs.push({ ...style, t: part });
    else if ("link" in part)
      runs.push({ ...style, t: part.link, c: link, underline: true, url: part.url });
    else if ("underline" in part) runs.push({ ...style, t: part.underline, underline: true });
  }
  return runs;
}

type Style = Omit<TextRun, "t">;

const LIGHT: Style = { f: "light", s: 10.5, c: BLACK };
const BOLD: Style = { f: "bold", s: 10.5, c: BLACK };
const LINK = hex("1155cc");
/** The natural height of a line of body text. */
const LINE = 10.5 * NATURAL;
/** The lines table: its left edge from the margin, and description, two numbers, total. */
const TABLE_AT = 29.43;
const TABLE_COLS = [290.25, 68, 68, 68];
/** Space above the first blank of the acceptance block, and above each later one. */
const FIRST_BLANK = 22.59;
const NEXT_BLANK = 21.09;

const empty = (line: number): Para => ({ runs: [], empty: LINE, line });

/**
 * The acceptance blanks. The sentence is written as blanks between its words, then the
 * date and the signature share one line. The role is asked on a line of its own after the
 * sentence: the signature record names it.
 */
function acceptance(s: Sheet, l: OfferLayout) {
  const reach = PAGE_W - MARGIN - 35.35;
  // A rule starts closer to "organisation" and to "Signature:", which end without a space.
  const gapOf = (f: AcceptanceField) =>
    f.key === "organisation" || f.kind === "signature" ? 1.5 : 4.3;
  const sentence = l.acceptance.fields.filter((f) => f.kind !== "role");
  const role = l.acceptance.fields.filter((f) => f.kind === "role");
  const one = (field: AcceptanceField, above: number) => {
    const gap = gapOf(field);
    const start = MARGIN + INDENT + s.width(s.clean(field.prefix, "light"), LIGHT) + gap;
    s.blanks(
      [
        {
          field,
          style: LIGHT,
          gap,
          rule: field.key === "organisation" ? 146.25 : 129,
          reach: reach - start,
        },
      ],
      { above, line: 1.15 },
    );
  };
  sentence.forEach((field, i) => {
    one(field, i === 0 ? FIRST_BLANK : NEXT_BLANK);
  });
  s.para({
    runs: textRuns(l.acceptance.statement, LIGHT),
    empty: LINE,
    line: 1.15,
    left: INDENT,
    right: 35.35,
  });
  for (const field of role) one(field, FIRST_BLANK);
  s.blanks(
    l.acceptance.signing.map((field, i) => ({
      field,
      style: LIGHT,
      gap: gapOf(field),
      lead: i === 0 ? 0 : 7.3,
      rule: 129,
    })),
    { above: role.length ? NEXT_BLANK : FIRST_BLANK, line: 1.15 },
  );
}

/** The one layout of an offer; `l` carries the words of its template and language. */
function draw(s: Sheet, l: OfferLayout) {
  const text = (t: string, over: Partial<Para> = {}): Para => ({
    runs: textRuns(t, LIGHT),
    empty: LINE,
    line: 1,
    left: INDENT,
    right: 78,
    ...over,
  });
  s.para({
    runs: [{ t: l.title, f: "bold", s: 15, c: BLACK }],
    empty: 15 * NATURAL,
    line: 1.15,
    before: 18,
    after: 4,
    left: INDENT,
    right: 78,
  });
  s.para({ runs: textRuns(l.meta, { ...LIGHT, s: 10 }), empty: 13.02, line: 1.2, left: INDENT });
  s.para({ runs: [], empty: 13.02, line: 1.2 });
  s.para(text(l.greeting, { line: 1.2, right: 0 }));
  s.para(empty(1.2));
  // An event offer's introduction has a heading as its second line ("Dembrane's Role:"),
  // set in bold above its paragraph.
  const [opening, ...rest] = l.intro;
  s.para(text(opening ?? ""));
  if (rest.length) {
    s.para(empty(1));
    const [heading, ...paragraphs] = rest;
    s.para({ ...text(heading ?? ""), runs: textRuns(heading ?? "", BOLD) });
    for (const p of paragraphs) s.para(text(p));
  }
  for (let i = 0; i < 3; i++) s.para(empty(1));

  const cell = (t: string, over: Partial<Para> = {}): Cell => ({
    paras: [{ runs: textRuns(t, LIGHT), empty: LINE, line: 1, ...over }],
  });
  s.table({
    x: MARGIN + TABLE_AT,
    cols: TABLE_COLS,
    pad: 5,
    border: { width: 1, color: BLACK },
    rows: [
      { minHeight: 20.5, fill: HEAD_FILL, cells: l.columns.map((c) => cell(c)) },
      ...l.rows.map((r) => ({
        minHeight: 20.5,
        cells: [
          {
            paras: [
              { runs: textRuns(r.description, BOLD), empty: LINE, line: 1.2 },
              ...r.bullets.map(
                (b): Para => ({
                  runs: textRuns(b, LIGHT),
                  empty: LINE,
                  line: 1.2,
                  left: 36,
                  marker: { at: 18, draw: { disc: 10.5, c: BLACK } },
                }),
              ),
            ],
          },
          ...r.cells.map((c) => cell(c, { align: "center" })),
        ],
      })),
    ],
  });

  s.para(empty(1));
  s.para({ runs: textRuns(l.total, BOLD), empty: LINE, line: 1, align: "right", right: 35.35 });
  s.para(empty(1));
  for (let i = 0; i < 4; i++) s.para(empty(1.15));
  const closing = (t: string) => s.para(text(t, { line: 1.15, right: 35.35 }));
  l.closing.forEach((line, i) => {
    // Two empty lines above the team's name, the last line.
    if (i > 0 && i === l.closing.length - 1) for (let k = 0; k < 2; k++) s.para(empty(1.15));
    closing(line);
  });

  // The acceptance block starts its own page.
  s.newPage();
  s.para({
    runs: [{ t: l.acceptanceTitle, f: "light", s: 15, c: BLACK }],
    empty: 15 * NATURAL,
    line: 1.15,
    after: 4,
    left: INDENT,
    right: 78,
  });
  s.para(text(l.acceptanceIntro, { line: 1.15, right: 35.35 }));
  acceptance(s, l);

  const { opening: clause, items, closing: after } = l.clauseParts;
  s.para({
    runs: textRuns(clause, BOLD),
    empty: LINE,
    line: 1.15,
    before: 12,
    after: 12,
    left: INDENT,
  });
  items.forEach((item, i) => {
    s.para({
      runs: clauseRuns(item, LIGHT, LINK),
      empty: LINE,
      line: 1.15,
      before: i === 0 ? 12 : 0,
      after: i === items.length - 1 ? 12 : 0,
      left: INDENT,
      first: 36,
      marker: { at: INDENT, draw: { ...LIGHT, t: `${i + 1}.` } },
    });
  });
  for (const p of after) s.para(text(p, { line: 1.15, before: 12, after: 12, right: 0 }));
}

/** The offer in its one look, with the acceptance blanks as fields. */
export async function offerPdf(content: OfferContent): Promise<RenderedPdf> {
  const a = await assets();
  const l = layoutOffer(content);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // A fixed name keeps the bytes of the same render the same.
  const embed = (key: FontKey, name: string) =>
    doc.embedFont(a.fonts[key], { subset: true, customName: name });
  const fonts = {
    light: await embed("light", "DMSans-Light"),
    bold: await embed("bold", "DMSans-Bold"),
  };
  const shaper = (key: FontKey) => fontkit.create(a.fonts[key]) as unknown as Shaper;
  const sheet = new Sheet(
    doc,
    fonts,
    {
      light: shaper("light"),
      bold: shaper("bold"),
    },
    await doc.embedPng(a.logo),
    {
      sparkles: await doc.embedPng(a.emoji.sparkles),
      calendar: await doc.embedPng(a.emoji.calendar),
    },
    l,
  );
  draw(sheet, l);
  doc.setTitle(l.title);
  doc.setAuthor("dembrane B.V.");
  doc.setProducer("dembrane echo");
  doc.setCreator("dembrane echo");
  doc.setCreationDate(EPOCH);
  doc.setModificationDate(EPOCH);
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: doc.getPageCount(), fields: sheet.fields };
}
