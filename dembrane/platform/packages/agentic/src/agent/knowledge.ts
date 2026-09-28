import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { assetPath } from "@dembrane/core";

/**
 * The assistant's read-only knowledge: the product docs corpus and the skill files shipped
 * with this package, both found through assetPath so a compiled worker reads the copies
 * its image carries. Nothing here writes. Paths the model passes are resolved
 * inside their root, so a `../` never leaves it.
 */

const MAX_GREP_RESULTS = 40;
const MAX_READ_LINES = 400;
const SKILL_FRONTMATTER_KEYS = ["name", "description", "when_to_use"] as const;
// Model-supplied patterns run against every line of the corpus. A long pattern, or one
// with a quantified group that is itself quantified, can backtrack for minutes (spec
// L-24), so such patterns are searched as literal text instead, and lines are capped.
const MAX_PATTERN_LENGTH = 200;
const MAX_LINE_SCAN = 2_000;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{?]/;

/**
 * What the worker's boot check requires: every skill the catalog lists. The docs corpus is
 * optional; without it the docs tools answer empty with NO_DOCS and the prompt leaves out
 * the docs guidance.
 */
export const AGENTIC_ASSETS: readonly string[] = [
  "agentic/skills/interviewing.md",
  "agentic/skills/project-onboarding.md",
];

/** What the docs tools tell the model when this environment carries no docs corpus. */
export const NO_DOCS = "No documentation corpus is available in this environment.";

export interface Knowledge {
  hasDocs(): boolean;
  listDocs(): string[];
  readDoc(path: string, offset?: number, limit?: number): string;
  grepDocs(pattern: string): { path: string; line: number; text: string }[];
  readSkill(path: string): string;
  promptSection(docsBaseUrl: string): string;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// \n \v \f \r, the three information separators, NEL, LINE and PARAGRAPH SEPARATOR.
const LINE_BREAKS = new Set([10, 11, 12, 13, 28, 29, 30, 133, 0x2028, 0x2029]);

/** Python's str.splitlines: every line break it knows, no trailing empty line. */
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

/** Sorted like Python sorts Path objects: part by part, not as one string. */
function comparePaths(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i] as string;
    const y = pb[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md"))
        out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort(comparePaths);
}

function resolveInside(root: string, rel: string): string {
  const base = realpathSync(root);
  const target = resolve(base, rel);
  if (target !== base && !target.startsWith(base + sep))
    throw new ValueError("Path escapes the knowledge root");
  return target;
}

/** The ValueError the Python tools raised; its class name reaches the model in error text. */
export class ValueError extends Error {
  override readonly name = "ValueError";
}

function frontmatter(text: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const lines = splitLines(text);
  if (!lines.length || (lines[0] as string).trim() !== "---") return meta;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const at = line.indexOf(":");
    if (at >= 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return meta;
}

/** Python's re.escape, enough for a pattern used as literal text. */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

export function safePattern(pattern: string): RegExp {
  if (pattern.length <= MAX_PATTERN_LENGTH && !NESTED_QUANTIFIER.test(pattern)) {
    try {
      return new RegExp(pattern, "i");
    } catch {}
  }
  return new RegExp(escapeRegex(pattern.slice(0, MAX_PATTERN_LENGTH)), "i");
}

export function createKnowledge(): Knowledge {
  const docsRoot = (): string | null => {
    const dir = assetPath("docs");
    return isDir(dir) ? dir : null;
  };
  const skillsRoot = (): string | null => {
    const dir = assetPath("agentic", "skills");
    return isDir(dir) ? dir : null;
  };

  const catalog = () => {
    const root = skillsRoot();
    if (!root) return [];
    const out: Record<string, string>[] = [];
    for (const rel of markdownFiles(root)) {
      const meta = frontmatter(readFileSync(join(root, rel), "utf8"));
      if (SKILL_FRONTMATTER_KEYS.every((k) => meta[k])) out.push({ ...meta, path: rel });
    }
    return out;
  };

  return {
    hasDocs() {
      return docsRoot() !== null;
    },

    listDocs() {
      const root = docsRoot();
      return root ? markdownFiles(root) : [];
    },

    readDoc(path, offset = 1, limit = MAX_READ_LINES) {
      const root = docsRoot();
      if (!root) return NO_DOCS;
      const target = resolveInside(root, path);
      if (!existsSync(target) || !statSync(target).isFile() || !target.endsWith(".md"))
        return `Not found: ${path}. Use listDocs to see available paths.`;
      const lines = splitLines(readFileSync(target, "utf8"));
      const start = Math.max(offset, 1);
      const end = Math.min(start - 1 + Math.max(1, Math.min(limit, MAX_READ_LINES)), lines.length);
      const numbered: string[] = [];
      for (let i = start; i <= end; i++) numbered.push(`${i}: ${lines[i - 1]}`);
      const suffix =
        end >= lines.length
          ? ""
          : `\n... (${lines.length - end} more lines; call readDoc with offset=${end + 1})`;
      return numbered.join("\n") + suffix;
    },

    grepDocs(pattern) {
      const root = docsRoot();
      if (!root) return [];
      const re = safePattern(pattern);
      const results: { path: string; line: number; text: string }[] = [];
      for (const rel of markdownFiles(root)) {
        const lines = splitLines(readFileSync(join(root, rel), "utf8"));
        for (const [i, line] of lines.entries()) {
          if (re.test(line.slice(0, MAX_LINE_SCAN))) {
            results.push({
              path: rel,
              line: i + 1,
              text: Array.from(line.trim()).slice(0, 300).join(""),
            });
            if (results.length >= MAX_GREP_RESULTS) return results;
          }
        }
      }
      return results;
    },

    readSkill(path) {
      const root = skillsRoot();
      if (!root) return "No skills are available in this environment.";
      const target = resolveInside(root, path);
      if (!existsSync(target) || !statSync(target).isFile() || !target.endsWith(".md"))
        return `Not found: ${path}.`;
      return readFileSync(target, "utf8");
    },

    promptSection(docsBaseUrl) {
      const parts: string[] = [];
      if (docsRoot() !== null) {
        const base = docsBaseUrl.trim().replace(/\/+$/, "");
        const citation = base
          ? "When you cite a doc, link to its published page: drop the .md " +
            `suffix, append .html, and prefix ${base}/ (so users/host/index.md ` +
            `becomes ${base}/users/host/index.html). Use a markdown link with ` +
            "a readable title, never the bare path."
          : "Cite the doc path you used.";
        parts.push(
          "You have a read-only product documentation corpus. Use grepDocs to " +
            "search it and readDoc to read pages before answering questions about " +
            `how dembrane works. Prefer docs over guessing. ${citation}`,
        );
      }
      const skills = catalog();
      if (skills.length) {
        const lines = ["Available skills (read the body with readSkill when one applies):"];
        for (const s of skills)
          lines.push(`- ${s.name} (${s.path}): ${s.description} When to use: ${s.when_to_use}`);
        parts.push(lines.join("\n"));
      }
      return parts.length ? `\n\n${parts.join("\n\n")}` : "";
    },
  };
}
