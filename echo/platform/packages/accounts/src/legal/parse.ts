import { createHash } from "node:crypto";

/**
 * Reading dembrane.com/legal pages into legal_text rows. A page states its version and
 * effective date in its header (`<span aria-label="Version">`, `<time datetime>`); its text
 * is the `prose` block. Two captures of the same text (the page's HTML, or a copied text
 * dump) differ in line breaks only, so a text's identity is the SHA-256 of its characters
 * with all whitespace removed. A layout change is therefore never a new version, and any
 * change to a word is.
 */

export const LEGAL_KINDS = ["terms", "sla", "dpa"] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];

export const LEGAL_URLS: Record<LegalKind, string> = {
  terms: "https://www.dembrane.com/legal/terms",
  sla: "https://www.dembrane.com/legal/sla",
  dpa: "https://www.dembrane.com/legal/dpa",
};

export interface ParsedLegal {
  readonly title: string;
  readonly version: string;
  /** ISO date, or null when the page states none. */
  readonly effectiveOn: string | null;
  readonly body: string;
  readonly sha256: string;
}

export function legalSha256(body: string): string {
  return createHash("sha256").update(body.replace(/\s+/g, ""), "utf8").digest("hex");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The inner HTML of the first `<div class="prose"...>`, nesting counted. */
function proseBlock(html: string): string | null {
  const start = html.search(/<div class="prose"/);
  if (start < 0) return null;
  const open = html.indexOf(">", start) + 1;
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = open;
  let depth = 1;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index);
  }
  return null;
}

const BLOCK = /<\/?(p|h[1-6]|li|ul|ol|tr|table|thead|tbody|div|section|blockquote|br)\b[^>]*>/gi;

/**
 * HTML to readable text: one line per block and per list item, cells tab-separated. No
 * bullet characters are added, so the text's fingerprint matches a plain text capture.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, "\t")
    .replace(BLOCK, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, "").replace(/^[ ]+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A live legal page. Throws when the page lacks what an offer must name. */
export function parseLegalPage(html: string): ParsedLegal {
  const title = decodeEntities(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .trim();
  const version = /aria-label="Version"[^>]*>\s*([^<\s][^<]*?)\s*</i.exec(html)?.[1];
  const effectiveOn = /<time\b[^>]*datetime="(\d{4}-\d{2}-\d{2})"/i.exec(html)?.[1] ?? null;
  const prose = proseBlock(html);
  if (!title || !version || prose === null)
    throw new Error("legal page is missing its title, version or text");
  const body = htmlToText(prose);
  if (body.length < 200) throw new Error("legal page text is implausibly short");
  return { title, version, effectiveOn, body, sha256: legalSha256(body) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A text dump of a legal page (docs/accounts-reference): the header lines after "Download
 * as PDF" carry the date ("Jun 21, 2026") and version; the text runs to the page's
 * "Previous" link. Inline elements were split onto their own lines in the dump; they are
 * joined back so the stored body reads as prose.
 */
export function parseLegalDump(dump: string): ParsedLegal {
  const lines = dump.replace(/^﻿/, "").split("\n");
  const at = lines.findIndex((l) => l.trim() === "Download as PDF");
  if (at < 1) throw new Error("legal dump has no header");
  const title = decodeEntities((lines[at - 1] ?? "").trim());
  const dateLine = (lines[at + 1] ?? "").trim();
  const version = (lines[at + 2] ?? "").trim();
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(dateLine);
  const effectiveOn = m
    ? `${m[3]}-${String(MONTHS.indexOf(m[1] as string) + 1).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`
    : null;
  const rest = lines.slice(at + 3);
  const end = rest.lastIndexOf("Previous");
  const raw = (end >= 0 ? rest.slice(0, end) : rest).map((l) => decodeEntities(l));
  const joined: string[] = [];
  for (const line of raw) {
    const prev = joined[joined.length - 1];
    const glue =
      prev !== undefined &&
      (/[\s("]$/.test(prev) || /^[\s,.;:)"]/.test(line) || /^[a-z]/.test(line));
    if (glue) joined[joined.length - 1] = `${prev}${line}`;
    else joined.push(line);
  }
  const body = joined
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (!version || !body) throw new Error("legal dump is missing its version or text");
  return { title, version, effectiveOn, body, sha256: legalSha256(body) };
}

/** "2026-07-17" as "17-07-2026", the way the offer templates write dates. */
export function dutchDate(iso: string | null): string {
  if (!iso) return "";
  const [y, mo, d] = iso.split("-");
  return `${d}-${mo}-${y}`;
}
