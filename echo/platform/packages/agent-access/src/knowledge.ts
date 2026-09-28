import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { assetPath } from "@dembrane/core";
import type { Logger } from "@dembrane/observability";

/**
 * The product documentation as a small read-only file system for agents: list, a
 * line-numbered read and a regex grep. Deployed environments on dembrane.com read the
 * published site (docs.dembrane.com lists every page in llms.txt and serves a markdown twin
 * per page); others read the docs shipped with the build. The corpus is kept for an hour per
 * instance; the Python API also shared it through Redis, which only saved cold fetches.
 */

/** What the API's boot check requires: the docs tree read when no published site applies. */
export const AGENT_ACCESS_ASSETS: readonly string[] = ["docs/README.md"];

const MAX_READ_LINES = 400;
const MAX_GREP_RESULTS = 50;
const CORPUS_TTL_MS = 3600_000;
const FETCH_CONCURRENCY = 8;
// A pattern agents send runs against every line of the corpus. A long one, or one with a
// quantified group that is itself quantified, can backtrack for minutes (spec L-24: the
// Python API compiled any pattern), so such patterns are searched as literal text.
const MAX_PATTERN_LENGTH = 200;
const MAX_LINE_SCAN = 2_000;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{?]/;

// \n \v \f \r, the three information separators, NEL, LINE and PARAGRAPH SEPARATOR.
const LINE_BREAKS = new Set([10, 11, 12, 13, 28, 29, 30, 133, 0x2028, 0x2029]);

/** Python's str.splitlines. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!LINE_BREAKS.has(code)) {
      current += text[i];
      continue;
    }
    if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
    lines.push(current);
    current = "";
  }
  if (current) lines.push(current);
  return lines;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

function safePattern(pattern: string): RegExp {
  if (pattern.length <= MAX_PATTERN_LENGTH && !NESTED_QUANTIFIER.test(pattern)) {
    try {
      return new RegExp(pattern, "i");
    } catch {}
  }
  return new RegExp(escapeRegex(pattern.slice(0, MAX_PATTERN_LENGTH)), "i");
}

/** The published set only: no authoring notes, no translation twins. */
function diskCorpus(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = relative(root, full).split(sep).join("/");
        if (rel.startsWith("_authoring/") || /\.[a-z]{2}-[A-Z]{2}\.md$/.test(rel)) continue;
        out.set(rel, readFileSync(full, "utf8"));
      }
    }
  };
  walk(root);
  return out;
}

async function publishedCorpus(base: string, fetchFn: typeof fetch): Promise<Map<string, string>> {
  const index = await (
    await fetchFn(`${base}/llms.txt`, { signal: AbortSignal.timeout(20_000) })
  ).text();
  const re = new RegExp(`\\(${escapeRegex(base)}/([^)\\s]+\\.md)\\)`, "g");
  const paths = [...new Set([...index.matchAll(re)].map((m) => m[1] as string))];
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i += FETCH_CONCURRENCY) {
    const batch = paths.slice(i, i + FETCH_CONCURRENCY);
    const pages = await Promise.all(
      batch.map(async (p) => {
        const r = await fetchFn(`${base}/${p}`, { signal: AbortSignal.timeout(20_000) });
        return [p, r.status === 200 ? await r.text() : ""] as const;
      }),
    );
    for (const [p, t] of pages) if (t) out.set(p, t);
  }
  return out;
}

function titleOf(text: string, path: string): string {
  for (const line of splitLines(text)) if (line.startsWith("# ")) return line.slice(2).trim();
  return path;
}

const byPath = (a: [string, string], b: [string, string]) =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

export interface DocsCorpus {
  list(): Promise<{ path: string; title: string }[]>;
  read(path: string, offset: number, limit: number): Promise<string>;
  grep(
    pattern: string,
    maxResults: number,
  ): Promise<{ path: string; line: number; text: string }[]>;
}

/**
 * The docs agents read. `docsBaseUrl` empty reads the docs shipped with the build (the
 * repository's docs/ from source, `docs/` under the assets root in an image); set, it reads
 * the published site. A failed fetch degrades to an empty corpus and is retried after the
 * hour, never raised to the agent.
 */
export function docsCorpus(opts: {
  docsBaseUrl: string;
  logger: Logger;
  fetchFn?: typeof fetch;
}): DocsCorpus {
  let cached: { at: number; data: Map<string, string> } | null = null;
  let loading: Promise<Map<string, string>> | null = null;
  const base = opts.docsBaseUrl.replace(/\/+$/, "");

  async function load(): Promise<Map<string, string>> {
    if (!base) {
      const root = assetPath("docs");
      return existsSync(root) && statSync(root).isDirectory() ? diskCorpus(root) : new Map();
    }
    try {
      return await publishedCorpus(base, opts.fetchFn ?? fetch);
    } catch (err) {
      opts.logger.warn({ err, base }, "knowledge corpus fetch failed");
      return new Map();
    }
  }

  async function corpus(): Promise<[string, string][]> {
    if (!cached || Date.now() - cached.at >= CORPUS_TTL_MS) {
      loading ??= load().finally(() => {
        loading = null;
      });
      cached = { at: Date.now(), data: await loading };
    }
    return [...cached.data.entries()].sort(byPath);
  }

  return {
    async list() {
      return (await corpus()).map(([p, t]) => ({ path: p, title: titleOf(t, p) }));
    },

    async read(path, offset, limit) {
      const text = new Map(await corpus()).get(path.trim().replace(/^\/+/, ""));
      if (text === undefined)
        return `Not found: ${path}. Call dembrane_search_docs without a pattern to see every available path.`;
      const lines = splitLines(text);
      const start = Math.max(offset, 1);
      const end = Math.min(start - 1 + Math.max(1, Math.min(limit, MAX_READ_LINES)), lines.length);
      const numbered: string[] = [];
      for (let i = start; i <= end; i++) numbered.push(`${i}: ${lines[i - 1]}`);
      const suffix =
        end >= lines.length
          ? ""
          : `\n... (${lines.length - end} more lines; call dembrane_read_doc with offset=${end + 1})`;
      return numbered.join("\n") + suffix;
    },

    async grep(pattern, maxResults) {
      const re = safePattern(pattern);
      const cap = Math.max(1, Math.min(maxResults, MAX_GREP_RESULTS));
      const results: { path: string; line: number; text: string }[] = [];
      for (const [path, text] of await corpus()) {
        for (const [i, line] of splitLines(text).entries()) {
          if (!re.test(line.slice(0, MAX_LINE_SCAN))) continue;
          results.push({ path, line: i + 1, text: Array.from(line.trim()).slice(0, 300).join("") });
          if (results.length >= cap) return results;
        }
      }
      return results;
    },
  };
}

/** The published docs site for dembrane.com dashboards; empty (the local folder) elsewhere. */
export function docsBaseUrlFor(dashboardUrl: string): string {
  try {
    return new URL(dashboardUrl).hostname.endsWith("dembrane.com")
      ? "https://docs.dembrane.com"
      : "";
  } catch {
    return "";
  }
}
