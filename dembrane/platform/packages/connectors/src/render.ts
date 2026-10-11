import type { MiroItem } from "./miro";

/**
 * A frame as text. Every input keeps a plain-text rendering so chat, reports, analysis and
 * the MCP tools read it like any transcript; one segment per item, in reading order.
 */
export interface Segment {
  readonly itemId: string;
  readonly text: string;
}

/** Item types that carry no words of their own (connectors, plain images without titles). */
const SKIP = new Set(["connector", "frame"]);

/**
 * Reading order on a canvas: rows from top to bottom, left to right within a row. An item
 * joins the current row when its top edge is above the middle of the row's first item, so
 * a row of stickies at slightly different heights still reads left to right.
 */
export function readingOrder(items: readonly MiroItem[]): MiroItem[] {
  const top = (i: MiroItem) => i.y - i.height / 2;
  const left = (i: MiroItem) => i.x - i.width / 2;
  const sorted = [...items].sort((a, b) => top(a) - top(b) || left(a) - left(b));
  const rows: MiroItem[][] = [];
  let limit = Number.NEGATIVE_INFINITY;
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    if (row && top(item) < limit) row.push(item);
    else {
      rows.push([item]);
      limit = top(item) + Math.max(item.height, 1) / 2;
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => left(a) - left(b) || a.id.localeCompare(b.id)));
}

export function segments(items: readonly MiroItem[]): Segment[] {
  const out: Segment[] = [];
  for (const item of readingOrder(items.filter((i) => !SKIP.has(i.type)))) {
    const text = htmlToText(item.text);
    if (text) out.push({ itemId: item.id, text });
  }
  return out;
}

/** Miro's rich text is a small HTML subset; keep the line breaks, drop the markup. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]*>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1]?.toLowerCase() === "x" ? Number.parseInt(ent.slice(2), 16) : Number(ent.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[ent.toLowerCase()] ?? whole;
  });
}

/** Changes when the frame's words or their order change; a sync skips frames that did not. */
export function contentHash(title: string, segs: readonly Segment[]): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([title, segs.map((s) => [s.itemId, s.text])]))
    .digest("hex")
    .slice(0, 32);
}
