/**
 * Sanitisation of canvas HTML before it is stored. The iframe and its CSP are the real
 * boundary; this pass strips network-bearing references and enforces the size cap, so a
 * broken or oversized generation fails loudly instead of being stored.
 */

/** CANVAS_MAX_HTML_BYTES in the Python settings; never overridden in any environment. */
export const MAX_HTML_BYTES = 240_000;

export class CanvasSanitizationError extends Error {}

export interface Sanitized {
  readonly html: string;
  readonly strippedReferences: number;
}

const FENCE = /^\s*```(?:html)?\s*|\s*```\s*$/gi;
const ATTR_URL = /(\b(?:src|href)\s*=\s*)(["'])((?:https?:)?\/\/[^"']+)\2/gi;
const CSS_URL = /url\(\s*(["']?)((?:https?:)?\/\/[^"')]+)\1\s*\)/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const BODY = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;
const HEAD = /<head\b[^>]*>[\s\S]*?<\/head\s*>/gi;
const DOC_CHROME = /<!DOCTYPE[^>]*>|<\/?(?:html|head|body)\b[^>]*>/gi;

export function stripMarkdownFences(text: string): string {
  return text.trim().replace(FENCE, "").trim();
}

/** The client owns the document (kit CSS, CSP); a stored generation is only the body. */
export function extractBodyFragment(html: string): string {
  const m = BODY.exec(html);
  if (m) return (m[1] ?? "").trim();
  return html.replace(HEAD, "").replace(DOC_CHROME, "").trim();
}

export function sanitizeCanvasHtml(html: unknown, maxBytes = MAX_HTML_BYTES): Sanitized {
  if (typeof html !== "string" || !html.trim())
    throw new CanvasSanitizationError("Empty canvas HTML");
  let cleaned = extractBodyFragment(stripMarkdownFences(html));
  // Comments are model self-talk; the skill forbids them but enforcement lives here.
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
    throw new CanvasSanitizationError("Canvas output has no renderable content");
  const size = Buffer.byteLength(cleaned, "utf8");
  if (size > maxBytes)
    throw new CanvasSanitizationError(`Canvas HTML is too large (${size} bytes)`);
  return { html: cleaned, strippedReferences: stripped };
}
