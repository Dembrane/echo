import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, PDFString, rgb } from "pdf-lib";
import boldTtf from "../assets/fonts/DMSans-Bold.ttf" with { type: "file" };
import lightTtf from "../assets/fonts/DMSans-Light.ttf" with { type: "file" };
import italicTtf from "../assets/fonts/DMSans-LightItalic.ttf" with { type: "file" };
import regularTtf from "../assets/fonts/DMSans-Regular.ttf" with { type: "file" };
import calendarPng from "../assets/offer/calendar.png" with { type: "file" };
import logoPng from "../assets/offer/logo.png" with { type: "file" };
import sparklesPng from "../assets/offer/sparkles.png" with { type: "file" };
import type { AcceptanceField, ClauseLine, OfferContent, OfferLayout } from "./offer";
import { layoutOffer } from "./offer";
import type { PlacedField, RenderedPdf } from "./pdf";

/**
 * The offer PDF, laid out as the four Google Doc templates sales sends today
 * (packages/accounts/reference): the letterhead and logo on every page, DM Sans, the green
 * table head, the acceptance block on its own page with the legal texts linked by name, and
 * the validity line in the footer. The templates differ from each other in type and table
 * details, so each one has its own script below, with the measures of its Google Doc.
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
/** An empty paragraph in the Docs' default face (Space Grotesk 12) is this tall per line. */
const DEFAULT_EMPTY = 15.31;
/** The same render must give the same bytes, so the dates are fixed. */
const EPOCH = new Date("2026-01-01T00:00:00Z");

type FontKey = "light" | "italic" | "regular" | "bold";
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
  /** Natural height of every line, where the Doc's line holds a larger run than its text. */
  readonly natural?: number;
  readonly line: number;
  readonly before?: number;
  readonly after?: number;
  readonly left?: number;
  readonly right?: number;
  /** Extra indent of the first line; later lines start at `left`. */
  readonly first?: number;
  readonly align?: "left" | "right" | "center" | "both";
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
  readonly last: boolean;
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
      italic: await read(italicTtf),
      regular: await read(regularTtf),
      bold: await read(boldTtf),
    },
    logo: await read(logoPng),
    emoji: { sparkles: await read(sparklesPng), calendar: await read(calendarPng) },
  }))();
  return loaded;
}

/** How the letterhead and the footer differ between the templates. */
interface Frame {
  readonly name: FontKey;
  readonly details: FontKey;
  readonly validity: FontKey;
  /** The sign-off is centred, or starts at this x where the Doc indents it by hand. */
  readonly signOffAt: number | null;
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
    private readonly frame: Frame,
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
    this.at(this.clean(this.layout.letterhead.name, this.frame.name), 44.85, 50.22, {
      f: this.frame.name,
      s: 10.5,
      c,
    });
    const d = { f: this.frame.details, s: 9.5, c };
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
      f: this.frame.validity,
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
    const x = this.frame.signOffAt ?? (PAGE_W - this.width(text, signOff)) / 2;
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
    const close = (last: boolean) => {
      const sizes = current.flatMap((w) => w.pieces.map((p) => p.run.s));
      const text = current.flatMap((w) => w.pieces.filter((p) => !("emoji" in p.run)));
      const size = text.length ? Math.max(...text.map((p) => p.run.s)) : 0;
      lines.push({
        words: current,
        width: used,
        natural:
          para.natural ??
          (size ? size * NATURAL : sizes.length ? Math.max(...sizes) * NATURAL : para.empty),
        size,
        indent: left + (lines.length === 0 ? first : 0),
        last,
      });
      current = [];
      used = 0;
    };
    for (const word of words) {
      const next = used + (current.length ? word.space : 0) + word.width;
      if (current.length && next > limit(lines.length) + 0.01) {
        close(false);
        current.push(word);
        used = word.width;
      } else {
        current.push(word);
        used = next;
      }
    }
    close(true);
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
      const gaps = line.words.length - 1;
      const stretch = para.align === "both" && !line.last && gaps > 0 ? room / gaps : 0;
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
        if (i > 0) cx += word.space + stretch;
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

  gap(height: number) {
    this.y += Math.max(height, 0);
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

  /** A rule across part of the page, `at` points below the current position. */
  rule(x1: number, x2: number, at: number, width: number, color: Color) {
    this.page.drawLine({
      start: { x: x1, y: PAGE_H - (this.y + at) },
      end: { x: x2, y: PAGE_H - (this.y + at) },
      thickness: width,
      color,
    });
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

/** One template: how its letterhead and footer are set, and the script that lays it out. */
interface Script {
  readonly frame: Frame;
  draw(s: Sheet, l: OfferLayout): void;
}

type Style = Omit<TextRun, "t">;

/** Where the rules of the acceptance block start, as each Doc places them. */
interface BlankMeasures {
  /** Space above the first blank line. */
  readonly first: number;
  /** From the end of the words to the rule; `rest` where a field has no entry. */
  readonly gaps: Partial<Record<"organisation" | "address" | "date" | "signature", number>> & {
    readonly rest: number;
  };
  /** From the date's rule to the word before the signature's rule. */
  readonly signatureLead: number;
}

/**
 * The acceptance blanks. The templates write the sentence as blanks between its words, then
 * the date and the signature on one line. The role is asked on a line of its own after the
 * sentence: the Docs have no such blank, the signature record needs it.
 */
function acceptance(s: Sheet, l: OfferLayout, style: Style, m: BlankMeasures) {
  const reach = PAGE_W - MARGIN - 35.35;
  const gapOf = (f: AcceptanceField) =>
    (f.kind === "date" || f.kind === "signature" ? m.gaps[f.kind] : undefined) ??
    (f.key === "organisation" || f.key === "address" ? m.gaps[f.key] : undefined) ??
    m.gaps.rest;
  const sentence = l.acceptance.fields.filter((f) => f.kind !== "role");
  const role = l.acceptance.fields.filter((f) => f.kind === "role");
  const one = (field: AcceptanceField, above: number) => {
    const gap = gapOf(field);
    const start = MARGIN + INDENT + s.width(s.clean(field.prefix, style.f), style) + gap;
    s.blanks(
      [
        {
          field,
          style,
          gap,
          rule: field.key === "organisation" ? 146.25 : 129,
          reach: reach - start,
        },
      ],
      { above, line: 1.15 },
    );
  };
  sentence.forEach((field, i) => {
    one(field, i === 0 ? m.first : 21.09);
  });
  s.para({
    runs: textRuns(l.acceptance.statement, style),
    empty: style.s * NATURAL,
    line: 1.15,
    left: INDENT,
    right: 35.35,
  });
  for (const field of role) one(field, 22.59);
  s.blanks(
    l.acceptance.signing.map((field, i) => ({
      field,
      style,
      gap: gapOf(field),
      lead: i === 0 ? 0 : m.signatureLead,
      rule: 129,
    })),
    { above: role.length ? 21.09 : 22.59, line: 1.15 },
  );
}

/** The numbered documents of the clause and the two lines that close it. */
function clauseList(
  s: Sheet,
  l: OfferLayout,
  style: Style,
  link: Color,
  space: { first: number; between: number; last: number; closing: number },
) {
  const { items, closing } = l.clauseParts;
  items.forEach((item, i) => {
    s.para({
      runs: clauseRuns(item, style, link),
      empty: style.s * NATURAL,
      line: 1.15,
      before: i === 0 ? space.first : 0,
      after: i === items.length - 1 ? space.last : space.between,
      left: INDENT,
      first: 36,
      marker: { at: INDENT, draw: { ...style, t: `${i + 1}.` } },
    });
  });
  for (const p of closing)
    s.para({
      runs: textRuns(p, style),
      empty: style.s * NATURAL,
      line: 1.15,
      before: space.closing === 12 ? 12 : 0,
      after: space.closing,
      left: INDENT,
    });
}

/** The subscription templates: light type in black, a black-ruled table, the total in bold. */
function subscription(language: "en" | "nl"): Script {
  const light: Style = { f: "light", s: 10.5, c: BLACK };
  const bold: Style = { f: "bold", s: 10.5, c: BLACK };
  const nat = 10.5 * NATURAL;
  const en = language === "en";
  const blank = (line: number, before = 0): Para => ({ runs: [], empty: nat, line, before });
  return {
    frame: { name: "light", details: "light", validity: "light", signOffAt: null },
    draw(s, l) {
      s.para({
        runs: [{ t: l.title, f: "bold", s: 15, c: BLACK }],
        empty: 15 * NATURAL,
        line: 1.15,
        before: 18,
        after: 4,
        left: INDENT,
        right: 78,
      });
      s.para({
        runs: textRuns(l.meta, { ...light, s: 10 }),
        empty: 13.02,
        line: 1.2,
        left: INDENT,
      });
      s.para({ runs: [], empty: 13.02, line: 1.2 });
      s.para({ runs: textRuns(l.greeting, light), empty: nat, line: 1.2, left: INDENT });
      if (en) s.para(blank(1.2));
      for (const p of l.intro)
        s.para({ runs: textRuns(p, light), empty: nat, line: 1, left: INDENT, right: 78 });
      for (let i = 0; i < 3; i++) s.para(blank(1));

      // Description, price per seat, seats, total: the widths of each Doc's table.
      const head: Style = { ...light, f: en ? "italic" : "light" };
      const number = (text: string, i: number): Cell => ({
        paras: [
          en
            ? {
                runs: textRuns(text, light),
                empty: nat,
                line: 1,
                align: "center",
                left: i < 2 ? 36 : 0,
              }
            : {
                runs: textRuns(text, light),
                empty: nat,
                line: i === 0 ? 1.2 : 1,
                align: i === 0 ? "center" : "left",
                left: i === 0 ? 0 : 36,
              },
        ],
      });
      s.table({
        x: MARGIN + (en ? 29.43 : 22.68),
        cols: en ? [297.75, 74.25, 56.25, 66] : [267, 77.25, 54, 117.75],
        pad: 5,
        border: { width: 1, color: BLACK },
        rows: [
          {
            minHeight: 20.5,
            fill: HEAD_FILL,
            cells: l.columns.map((c) => ({
              paras: [{ runs: textRuns(c, head), empty: nat, line: 1 }],
            })),
          },
          ...l.rows.map((r) => ({
            minHeight: 20.5,
            cells: [
              {
                paras: [
                  { runs: textRuns(r.description, bold), empty: nat, line: 1.2 },
                  ...r.bullets.map(
                    (b): Para => ({
                      runs: textRuns(b, light),
                      empty: nat,
                      line: 1.2,
                      left: 36,
                      marker: en
                        ? { at: 18, draw: { ...light, t: "-" } }
                        : { at: 18, draw: { disc: 10.5, c: BLACK } },
                    }),
                  ),
                ],
              },
              ...r.cells.map(number),
            ],
          })),
        ],
      });

      s.para(en ? blank(1) : blank(1.15, 12));
      s.para({ runs: textRuns(l.total, bold), empty: nat, line: 1, align: "right", right: 35.35 });
      if (en) s.para(blank(1));
      for (let i = 0; i < (en ? 4 : 3); i++) s.para(blank(1.15));
      closingLines(s, l, light, 1.15, 2);

      // The acceptance block starts its own page; the English Doc has one empty line above it.
      s.newPage();
      if (en) s.gap(DEFAULT_EMPTY * 1.2);
      s.para({
        runs: [{ t: l.acceptanceTitle, f: "light", s: 15, c: BLACK }],
        empty: 15 * NATURAL,
        line: 1.15,
        before: en ? 18 : 0,
        after: 4,
        left: INDENT,
        right: 78,
      });
      s.para({
        runs: textRuns(l.acceptanceIntro, light),
        empty: nat,
        line: 1.15,
        left: INDENT,
        right: 35.35,
      });
      if (!en) s.para(blank(1.15));
      acceptance(
        s,
        l,
        light,
        en
          ? {
              first: 22.59,
              gaps: { rest: 4.3, organisation: 1.4, date: 4.4, signature: 1.5 },
              signatureLead: 7.3,
            }
          : {
              first: 22.59,
              gaps: { rest: 4.4, organisation: 1.56, address: 1.56, date: 4.5, signature: 1.6 },
              signatureLead: 7.17,
            },
      );
      // The Dutch Doc has an empty line between the signature and the clause.
      if (!en) s.para({ runs: [], empty: nat, line: 1.15, before: 12 });
      s.para({
        runs: textRuns(l.clauseParts.opening, bold),
        empty: nat,
        line: 1.15,
        before: 12,
        after: 12,
        left: INDENT,
      });
      clauseList(s, l, light, hex("1155cc"), { first: 12, between: 0, last: 12, closing: 12 });
    },
  };
}

/** The closing lines: the wish, the regards, then the team's name under `gapLines` empty lines. */
function closingLines(
  s: Sheet,
  l: OfferLayout,
  style: Style,
  line: number,
  gapLines: number,
  spaced = false,
) {
  const nat = style.s * NATURAL;
  const closing = (text: string) =>
    s.para({
      runs: textRuns(text, style),
      empty: nat,
      line,
      left: INDENT,
      right: spaced ? 0 : 35.35,
    });
  const empty = () => s.para({ runs: [], empty: nat, line });
  const [first, ...rest] = l.closing;
  closing(first ?? "");
  rest.forEach((text, i) => {
    if (spaced) empty();
    else if (i === rest.length - 1) for (let k = 0; k < gapLines; k++) empty();
    closing(text);
  });
}

/** The event templates: the role of dembrane above the table, the total under a rule. */
function eventEn(): Script {
  const ink = hex("333333");
  const text: Style = { f: "regular", s: 12, c: ink };
  const strong: Style = { f: "bold", s: 12, c: ink };
  const small: Style = { f: "regular", s: 10.5, c: ink };
  const nat = 12 * NATURAL;
  return {
    frame: { name: "bold", details: "regular", validity: "regular", signOffAt: 172.35 },
    draw(s, l) {
      s.para({
        runs: [{ t: l.title, f: "bold", s: 15, c: BLACK }],
        empty: 15 * NATURAL,
        line: 1.15,
        left: INDENT,
        right: 78,
      });
      s.para({
        runs: textRuns(l.meta, { f: "light", s: 10, c: BLACK }),
        empty: 10.5 * NATURAL,
        natural: 10.5 * NATURAL,
        line: 1.2,
        left: INDENT,
      });
      s.para({ runs: [], empty: 10.5 * NATURAL, line: 1.2 });
      const flow = (t: string, style: Style) =>
        s.para({
          runs: textRuns(t, style),
          empty: nat,
          line: 1.15,
          after: 10,
          left: INDENT,
          align: "both",
        });
      flow(l.greeting, text);
      // The second line of the introduction is the heading "Dembrane's Role:".
      l.intro.forEach((p, i) => {
        flow(p, i === 1 ? strong : text);
      });

      const cell = (t: string, style: Style, over: Partial<Para> = {}): Para => ({
        runs: textRuns(t, style),
        empty: nat,
        line: 1,
        left: INDENT,
        ...over,
      });
      s.table({
        x: MARGIN + 25.5,
        cols: [245.25, 79.5, 103.5, 90],
        pad: 9,
        border: { width: 0.75, color: hex("999999") },
        rows: [
          {
            minHeight: 41.25,
            fill: HEAD_FILL,
            cells: l.columns.map((c, i) => ({
              paras: [cell(c, text, { left: i === 1 ? 7.09 : INDENT })],
            })),
          },
          ...l.rows.map((r) => ({
            minHeight: 57,
            cells: [
              {
                paras: [
                  cell(r.description, strong),
                  ...r.bullets.map((b) =>
                    cell(b, text, {
                      first: 36,
                      marker: { at: INDENT, draw: { disc: 12, c: ink } },
                    }),
                  ),
                ],
              },
              { paras: [cell(r.cells[0], text, { align: "center" })] },
              { paras: [cell(r.cells[1], text, { align: "right" })] },
              { paras: [cell(r.cells[2], text, { align: "right" })] },
            ],
          })),
        ],
      });
      // The Doc draws the rule above the total as a row of underscores.
      s.para({
        runs: [{ ...text, t: "_".repeat(37) }],
        empty: nat,
        line: 1,
        align: "right",
        left: INDENT,
      });
      s.para({ runs: textRuns(l.total, text), empty: nat, line: 1, align: "right", left: INDENT });
      closingLines(s, l, text, 1, 0, true);

      s.newPage();
      s.para({
        runs: [{ t: l.acceptanceTitle, f: "bold", s: 18, c: ink }],
        empty: 18 * NATURAL,
        line: 1.15,
        left: INDENT,
      });
      s.para({
        runs: textRuns(l.acceptanceIntro, { f: "regular", s: 10, c: ink }),
        empty: 10 * NATURAL,
        line: 1.7,
        left: INDENT,
      });
      acceptance(s, l, small, {
        first: 22.59,
        gaps: { rest: 4.25, date: 7.1, signature: 4.4 },
        signatureLead: 4.38,
      });
      s.gap(10.5 * NATURAL * 1.7);
      s.para({
        runs: textRuns(l.clauseParts.opening, { ...small, f: "bold" }),
        empty: 10.5 * NATURAL,
        line: 1.15,
        after: 10,
        left: INDENT,
      });
      clauseList(s, l, small, hex("1976d2"), { first: 0, between: 10, last: 10, closing: 10 });
    },
  };
}

function eventNl(): Script {
  const light: Style = { f: "light", s: 10.5, c: BLACK };
  const strong: Style = { f: "bold", s: 10.5, c: hex("434343") };
  const nat = 10.5 * NATURAL;
  const blank = (line: number): Para => ({ runs: [], empty: nat, line });
  return {
    frame: { name: "bold", details: "regular", validity: "light", signOffAt: null },
    draw(s, l) {
      s.para({
        runs: [{ t: l.title, f: "bold", s: 15, c: BLACK }],
        empty: 15 * NATURAL,
        line: 1.15,
        before: 18,
        after: 4,
        left: INDENT,
        right: 78,
      });
      s.para({
        runs: textRuns(l.meta, { ...light, s: 10 }),
        empty: nat,
        natural: nat,
        line: 1.2,
        left: INDENT,
      });
      s.para(blank(1.2));
      const flow = (t: string, style: Style, first = 0) =>
        s.para({
          runs: textRuns(t, style),
          empty: nat,
          line: 1,
          left: INDENT,
          right: 78,
          first,
          align: "both",
        });
      flow(l.greeting, light);
      // An empty line after the greeting and after the first sentence; the heading
      // "Rol van dembrane:" sits directly on its paragraph, whose first line is indented.
      l.intro.forEach((p, i) => {
        if (i < 2) s.para(blank(1));
        flow(p, i === 1 ? strong : light, i === 2 ? 7.65 : 0);
      });
      for (let i = 0; i < 2; i++) s.para(blank(1));

      const cell = (t: string, over: Partial<Para> = {}): Para => ({
        runs: textRuns(t, light),
        empty: nat,
        line: 1,
        ...over,
      });
      s.table({
        x: MARGIN + 22.68,
        cols: [281.25, 37.5, 71.25, 71.25],
        pad: 5,
        border: { width: 1, color: BLACK },
        rows: [
          { minHeight: 20.5, fill: HEAD_FILL, cells: l.columns.map((c) => ({ paras: [cell(c)] })) },
          ...l.rows.map((r) => ({
            minHeight: 20.5,
            cells: [
              {
                paras: [
                  { runs: textRuns(r.description, strong), empty: nat, line: 1.2 },
                  ...r.bullets.map((b) =>
                    cell(b, {
                      line: 1.2,
                      left: 36,
                      marker: { at: 18, draw: { ...light, t: "-" } },
                    }),
                  ),
                ],
              },
              { paras: [cell(r.cells[0], { align: "center" })] },
              { paras: [cell(r.cells[1], { left: 7.09 })] },
              { paras: [cell(r.cells[2], { left: 14.17 })] },
            ],
          })),
        ],
      });
      // The total sits in a second, borderless table: a rule over its right half.
      s.rule(MARGIN + 275.25, MARGIN + 480.75, 15.25, 0.5, BLACK);
      s.gap(21.84);
      s.para({ runs: textRuns(l.total, light), empty: nat, line: 1, align: "right", right: 73.58 });
      s.gap(5);
      s.para(blank(1.15));
      closingLines(s, l, light, 1.15, 2);

      s.newPage();
      s.para({
        runs: [{ t: l.acceptanceTitle, f: "bold", s: 15, c: hex("434343") }],
        empty: 15 * NATURAL,
        line: 1.15,
        after: 4,
        left: INDENT - 0.3,
        right: 78,
      });
      s.para({
        runs: textRuns(l.acceptanceIntro, light),
        empty: nat,
        line: 1.15,
        left: INDENT,
        right: 35.35,
      });
      acceptance(s, l, light, {
        first: 22.59,
        gaps: { rest: 4.4, organisation: 1.56, address: 1.56, date: 4.5, signature: 1.5 },
        signatureLead: 4.28,
      });
      s.gap(7 * NATURAL * 1.15);
      s.para({
        runs: textRuns(l.clauseParts.opening, strong),
        empty: nat,
        line: 1.15,
        before: 12,
        after: 12,
        left: INDENT,
      });
      clauseList(s, l, light, hex("1155cc"), { first: 12, between: 0, last: 12, closing: 12 });
    },
  };
}

const SCRIPTS: Record<OfferContent["template"], Record<OfferContent["language"], Script>> = {
  subscription: { en: subscription("en"), nl: subscription("nl") },
  event: { en: eventEn(), nl: eventNl() },
};

/** The offer as its Google Doc template lays it out, with the acceptance blanks as fields. */
export async function offerPdf(content: OfferContent): Promise<RenderedPdf> {
  const a = await assets();
  const l = layoutOffer(content);
  const script = SCRIPTS[content.template][content.language];
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // A fixed name keeps the bytes of the same render the same.
  const embed = (key: FontKey, name: string) =>
    doc.embedFont(a.fonts[key], { subset: true, customName: name });
  const fonts = {
    light: await embed("light", "DMSans-Light"),
    italic: await embed("italic", "DMSans-LightItalic"),
    regular: await embed("regular", "DMSans-Regular"),
    bold: await embed("bold", "DMSans-Bold"),
  };
  const shaper = (key: FontKey) => fontkit.create(a.fonts[key]) as unknown as Shaper;
  const sheet = new Sheet(
    doc,
    fonts,
    {
      light: shaper("light"),
      italic: shaper("italic"),
      regular: shaper("regular"),
      bold: shaper("bold"),
    },
    await doc.embedPng(a.logo),
    {
      sparkles: await doc.embedPng(a.emoji.sparkles),
      calendar: await doc.embedPng(a.emoji.calendar),
    },
    script.frame,
    l,
  );
  script.draw(sheet, l);
  doc.setTitle(l.title);
  doc.setAuthor("dembrane B.V.");
  doc.setProducer("dembrane echo");
  doc.setCreator("dembrane echo");
  doc.setCreationDate(EPOCH);
  doc.setModificationDate(EPOCH);
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageCount: doc.getPageCount(), fields: sheet.fields };
}
