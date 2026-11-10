import { DeliveryError, fetchChecked, type Resolve } from "@dembrane/webhooks";

/**
 * Reading the one page a host links to (an invitation, a project page), on our own server:
 * the model provider never fetches it. The URL is someone else's choice, so this is a
 * server-side request forgery surface, bounded on every side:
 * - http and https only, no credentials in the URL;
 * - every hop resolved once and refused when any address is private, loopback, link-local,
 *   carrier-grade NAT or metadata (webhooks' fetchChecked, which also connects to the
 *   address it checked);
 * - at most three redirects, each checked again;
 * - five seconds for the whole read, at most 1 MB of body;
 * - text/html and text/plain only, reduced to visible text and capped.
 * A failure is a reason code, never the content: nothing read here is logged.
 */

export interface PageLimits {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly maxChars: number;
}

export const PAGE_LIMITS: PageLimits = {
  timeoutMs: 5_000,
  maxBytes: 1_000_000,
  maxRedirects: 3,
  maxChars: 20_000,
};

export type PageFailure =
  | "invalid_url"
  | "blocked_address"
  | "too_many_redirects"
  | "timeout"
  | "wrong_type"
  | "http_status"
  | "unreachable"
  | "empty";

export class PageFetchError extends Error {
  override name = "PageFetchError";
  constructor(readonly reason: PageFailure) {
    super(`the linked page could not be read: ${reason}`);
  }
}

export interface PageFetchOptions {
  /** Local development and tests only (WEBHOOKS_ALLOW_PRIVATE_TARGETS). */
  readonly allowPrivate: boolean;
  readonly resolve?: Resolve;
  /** Which addresses refuse a hop; tests narrow it to reach their own server. */
  readonly blocked?: (ip: string) => boolean;
  readonly limits?: Partial<PageLimits>;
}

const ACCEPTED = /^(text\/html|text\/plain)\b/i;

/** A URL a host may link to, or the reason it may not. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new PageFetchError("invalid_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new PageFetchError("invalid_url");
  if (u.username || u.password) throw new PageFetchError("invalid_url");
  u.hash = "";
  return u;
}

/** At most `max` bytes of a body; stops reading (and cancels) past it. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const room = max - size;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    size += Math.min(value.byteLength, room);
    if (size >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/** Visible text of a page: no scripts, styles, comments or markup, one line per block. */
export function visibleText(body: string, contentType: string): string {
  const html = /html/i.test(contentType);
  const text = html
    ? decodeEntities(
        body
          .replace(/<!--[\s\S]*?-->/g, " ")
          .replace(
            /<(script|style|noscript|svg|template|iframe|object|head)\b[\s\S]*?<\/\1\s*>/gi,
            " ",
          )
          .replace(/<(script|style)\b[\s\S]*$/gi, " ")
          .replace(/<\/(p|div|li|h[1-6]|section|article|tr|td|th|dd|dt|header|footer)>/gi, "\n")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]*>/g, " "),
      )
    : body;
  return text
    .split("\n")
    .map((l) => l.replace(/[\s ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** The visible text of the page at `raw`, within the limits, or a PageFetchError. */
export async function fetchPageText(raw: string, opts: PageFetchOptions): Promise<string> {
  const limits = { ...PAGE_LIMITS, ...opts.limits };
  const signal = AbortSignal.timeout(limits.timeoutMs);
  let url = checkUrl(raw);
  try {
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await fetchChecked(
          url.href,
          {
            signal,
            headers: {
              accept: "text/html, text/plain;q=0.9",
              "user-agent": "dembrane-project-setup/1.0 (+https://dembrane.com)",
            },
          },
          {
            allowPrivate: opts.allowPrivate,
            ...(opts.resolve && { resolve: opts.resolve }),
            ...(opts.blocked && { blocked: opts.blocked }),
          },
        );
      } catch (err) {
        if (err instanceof DeliveryError)
          throw new PageFetchError(
            /private|internal/i.test(err.message) ? "blocked_address" : "unreachable",
          );
        throw err;
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= limits.maxRedirects) throw new PageFetchError("too_many_redirects");
        url = checkUrl(new URL(location, url).href);
        continue;
      }
      if (res.status >= 400) {
        await res.body?.cancel().catch(() => {});
        throw new PageFetchError("http_status");
      }
      const type = res.headers.get("content-type") ?? "";
      if (!ACCEPTED.test(type.trim())) {
        await res.body?.cancel().catch(() => {});
        throw new PageFetchError("wrong_type");
      }
      const bytes = await readCapped(res, limits.maxBytes);
      const text = visibleText(new TextDecoder().decode(bytes), type).slice(0, limits.maxChars);
      if (!text.trim()) throw new PageFetchError("empty");
      return text;
    }
  } catch (err) {
    if (err instanceof PageFetchError) throw err;
    if (signal.aborted) throw new PageFetchError("timeout");
    throw new PageFetchError("unreachable");
  }
}
