import { fetchChecked } from "@dembrane/webhooks";
import { decodeEntities } from "../legal/parse";

/**
 * Reading an organisation's public website for the research step. Everything fetched is
 * evidence for the model, never instructions to it: the prompt fences it as quoted data.
 * Bounded on every side: http(s) only, public addresses only (every redirect checked
 * again), same site as the start page, a few pages, a byte cap per page and in total.
 */

export interface FetchedPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly retrieved_at: string;
}

export interface FetchLimits {
  readonly maxPages: number;
  readonly maxBytesPerPage: number;
  readonly maxTotalBytes: number;
  readonly maxTextChars: number;
  readonly timeoutMs: number;
}

export const DEFAULT_LIMITS: FetchLimits = {
  maxPages: 6,
  maxBytesPerPage: 400_000,
  maxTotalBytes: 1_500_000,
  maxTextChars: 12_000,
  timeoutMs: 10_000,
};

/** One GET: status, final URL, content type and at most `maxBytes` of the body. */
export type HttpGet = (
  url: string,
  opts: { maxBytes: number; timeoutMs: number },
) => Promise<{ status: number; url: string; contentType: string; body: string }>;

/** The real GET: follows up to three redirects itself, checking each target is public. */
export function httpGet(allowPrivate: boolean): HttpGet {
  return async (start, opts) => {
    let url = start;
    for (let hop = 0; hop < 4; hop++) {
      if (!/^https?:\/\//i.test(url)) throw new Error(`not a web address: ${url}`);
      const res = await fetchChecked(
        url,
        {
          signal: AbortSignal.timeout(opts.timeoutMs),
          headers: { "user-agent": "dembrane-demo-research/1.0 (+https://dembrane.com)" },
        },
        { allowPrivate },
      );
      const next = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && next) {
        url = new URL(next, url).toString();
        continue;
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        chunks.push(value);
        size += value.byteLength;
        if (size >= opts.maxBytes) {
          await reader.cancel();
          break;
        }
      }
      const bytes = new Uint8Array(Math.min(size, opts.maxBytes));
      let o = 0;
      for (const c of chunks) {
        const part = c.subarray(0, Math.max(0, bytes.length - o));
        bytes.set(part, o);
        o += part.length;
      }
      return {
        status: res.status,
        url,
        contentType: res.headers.get("content-type") ?? "",
        body: new TextDecoder().decode(bytes),
      };
    }
    throw new Error("too many redirects");
  };
}

/** Visible text of an HTML page: no scripts, styles, navigation chrome or markup. */
export function pageText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const text = decodeEntities(
    html
      .replace(/<(head|script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|section|article|tr|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title, text };
}

const USEFUL =
  /(over|about|wie-we-zijn|organisatie|organisation|missie|mission|visie|vision|strategie|strategy|nieuws|news|projecten|projects|participatie|participation|beleid|policy|jaarverslag|annual)/i;
const SKIP = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|pptx?|mp4|mp3)(\?|$)/i;

/** Same-site links of a page, the ones that look like they describe the organisation first. */
export function siteLinks(html: string, base: string): string[] {
  const origin = new URL(base);
  const seen = new Set<string>();
  const links: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(decodeEntities(m[1] as string), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || u.hostname !== origin.hostname || SKIP.test(u.pathname))
      continue;
    u.hash = "";
    const key = u.toString();
    if (seen.has(key) || key === origin.toString()) continue;
    seen.add(key);
    links.push(key);
  }
  return [...links.filter((l) => USEFUL.test(l)), ...links.filter((l) => !USEFUL.test(l))];
}

/**
 * The start page and the most telling same-site pages after it, within the limits. A page
 * that fails is left out; the start page failing fails the step, since the research has
 * nothing to stand on.
 */
export async function fetchSite(
  start: string,
  get: HttpGet,
  now: () => Date,
  limits: FetchLimits = DEFAULT_LIMITS,
): Promise<FetchedPage[]> {
  const pages: FetchedPage[] = [];
  let total = 0;
  const first = await get(start, { maxBytes: limits.maxBytesPerPage, timeoutMs: limits.timeoutMs });
  if (first.status >= 400) throw new Error(`the website answered ${first.status}`);
  if (!/html|text\/plain/i.test(first.contentType))
    throw new Error("the website is not a web page");
  total += first.body.length;
  const read = (url: string, body: string) => {
    const { title, text } = pageText(body);
    if (text.length < 40) return;
    pages.push({
      url,
      title: title || url,
      text: text.slice(0, limits.maxTextChars),
      retrieved_at: now().toISOString(),
    });
  };
  read(first.url, first.body);
  for (const link of siteLinks(first.body, first.url)) {
    if (pages.length >= limits.maxPages || total >= limits.maxTotalBytes) break;
    try {
      const r = await get(link, {
        maxBytes: Math.min(limits.maxBytesPerPage, limits.maxTotalBytes - total),
        timeoutMs: limits.timeoutMs,
      });
      total += r.body.length;
      if (r.status < 400 && /html/i.test(r.contentType)) read(r.url, r.body);
    } catch {
      // One unreachable page does not stop the research.
    }
  }
  if (!pages.length) throw new Error("the website has no readable text");
  return pages;
}
