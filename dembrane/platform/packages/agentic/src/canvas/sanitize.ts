import { CanvasValueError } from "./ledgers";

/**
 * Generated or edited canvas HTML before it is stored. The iframe and its CSP are the
 * real boundary; this pass removes network-bearing references and enforces the size cap
 * so a broken generation is refused instead of stored silently.
 */

/** CANVAS_MAX_HTML_BYTES default of the Python settings. */
export const MAX_CANVAS_HTML_BYTES = 240_000;

const LEADING_FENCE = /^\s*```(?:html)?\s*/i;
const ATTR_URL = /(\b(?:src|href)\s*=\s*)(["'])((?:https?:)?\/\/[^"']+)\2/gi;
const CSS_URL = /url\(\s*(["']?)((?:https?:)?\/\/[^"')]+)\1\s*\)/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const BODY = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;
const HEAD = /<head\b[^>]*>[\s\S]*?<\/head\s*>/gi;
const DOC_CHROME = /<!DOCTYPE[^>]*>|<\/?(?:html|head|body)\b[^>]*>/gi;

/** Was `.replace(/^\s*```(?:html)?\s*|\s*```\s*$/gi, "")`; the closing fence is a scan, not a quadratic regex. */
export function stripMarkdownFences(text: string): string {
  const t = text.trim();
  const from = LEADING_FENCE.exec(t)?.[0].length ?? 0;
  let to = t.length;
  if (to - 3 >= from && t.endsWith("```")) {
    to -= 3;
    while (to > from && /\s/.test(t[to - 1] as string)) to--;
  }
  return t.slice(from, to).trim();
}

/** The stored generation is a body fragment; a full document is unwrapped and its head dropped. */
export function extractBodyFragment(html: string): string {
  const m = BODY.exec(html);
  if (m) return (m[1] ?? "").trim();
  return html.replace(HEAD, "").replace(DOC_CHROME, "").trim();
}

export interface Sanitized {
  readonly html: string;
  readonly strippedReferences: number;
}

export function sanitizeCanvasHtml(html: string, maxBytes = MAX_CANVAS_HTML_BYTES): Sanitized {
  if (typeof html !== "string" || !html.trim()) throw new CanvasValueError("Empty canvas HTML");
  let cleaned = extractBodyFragment(stripMarkdownFences(html));
  // Comments are model self-talk, not content.
  cleaned = cleaned.replace(COMMENT, "").trim();
  let stripped = 0;
  cleaned = cleaned.replace(ATTR_URL, (_m, attr: string, quote: string) => {
    stripped++;
    return `${attr}${quote}#${quote}`;
  });
  cleaned = cleaned.replace(CSS_URL, () => {
    stripped++;
    return "url('')";
  });
  if (!cleaned?.includes("<"))
    throw new CanvasValueError("Canvas output has no renderable content");
  const size = Buffer.byteLength(cleaned, "utf8");
  if (size > maxBytes) throw new CanvasValueError(`Canvas HTML is too large (${size} bytes)`);
  return { html: cleaned, strippedReferences: stripped };
}
