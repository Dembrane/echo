import { readFileSync } from "node:fs";
import { assetPath } from "@dembrane/core";

/**
 * The popcorn presentation as one self-contained HTML document: the upstream page
 * (static/SOURCE.md lists its embed patches) with the stylesheet and scripts inlined, so
 * the page needs nothing but its data endpoint. Pages carry no data; the host, room and
 * public variants differ only in the embed config injected ahead of the app script.
 */

const staticPath = (...parts: string[]) => assetPath("popcorn", "static", ...parts);

const read = (name: string) => readFileSync(staticPath(name), "utf8");

let template: string | null = null;

function pageTemplate(): string {
  if (template !== null) return template;
  let html = read("index.html");
  const css = read("styles.css");
  html = html.replace(
    /<link rel="stylesheet" href="assets\/styles\.css[^"]*">/,
    () => `<style>\n${css}\n</style>`,
  );
  html = html.replace(/<script src="(assets\/[^"?]+)[^"]*"><\/script>/g, (_m, src: string) => {
    const name = (src.split("?")[0] ?? src).replace(/^assets\//, "");
    return `<script>\n${read(name)}\n</script>`;
  });
  template = html;
  return html;
}

/** json.dumps(embed, ensure_ascii=False) with "</" escaped so it cannot close the script. */
function embedJson(embed: Record<string, unknown>): string {
  const parts = Object.entries(embed).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{${parts.join(", ")}}`.replaceAll("</", "<\\/");
}

/** The page with its embed config injected ahead of the app script. */
/**
 * "Continue in dembrane" on a prospect's demo: a link to the dashboard sign-in, fixed in
 * the page's corner and opened in a new tab so the room keeps the deck. Added only to a
 * page whose demo carries the link, so every other page stays byte for byte the same.
 */
export function continueSnippet(url: string, language: string): string {
  const label = language === "nl" ? "Verder in dembrane" : "Continue in dembrane";
  const href = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<style>.popcorn-continue{position:fixed;right:clamp(12px,2vw,28px);bottom:clamp(12px,2vw,28px);z-index:50;padding:.6em 1.1em;border-radius:9999px;background:#4169E1;color:#fff;font:500 .9em "DM Sans",system-ui,sans-serif;text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.15)}</style>
<a class="popcorn-continue" href="${href}" target="_blank" rel="noopener">${label}</a>
`;
}

export function renderPopcornPage(embed: Record<string, unknown>, continueHtml = ""): string {
  const script = `<script>window.POPCORN_EMBED = ${embedJson(embed)};</script>\n`;
  const html = pageTemplate();
  const marker = "<script>\n/* popcorn";
  const page = html.includes(marker)
    ? html.replace(marker, () => script + marker)
    : html.replace("</head>", () => `${script}</head>`);
  return continueHtml ? page.replace("</body>", () => `${continueHtml}</body>`) : page;
}

const LOGO = "dembrane-logomark-cropped.png";
export const logoPath = () => staticPath(LOGO);

/** The data screen's drawings, each with a twin for the dark screen. */
export const ILLUSTRATIONS: readonly string[] = [
  "scan",
  "talk-anon",
  "talk-public",
  "understand",
].flatMap((name) => ["", "-dark"].map((twin) => `${name}${twin}`));

/** The file of one drawing, or null for a name that is not one. */
export const illustrationPath = (name: string): string | null =>
  ILLUSTRATIONS.includes(name) ? staticPath("illustrations", `${name}.webp`) : null;

/** The scripts index.html loads, inlined into the page. */
const PAGE_SCRIPTS = ["planar.js", "audience-i18n.js", "app.js"];

/** Everything above reads, for the boot check of an app that serves popcorn pages. */
export const POPCORN_PAGE_ASSETS: readonly string[] = [
  ...["index.html", "styles.css", ...PAGE_SCRIPTS, "flow.html", LOGO, "sample"],
  ...ILLUSTRATIONS.map((name) => `illustrations/${name}.webp`),
].map((file) => `popcorn/static/${file}`);

export const NOT_LIVE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>popcorn</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,200..700&display=swap" rel="stylesheet">
<style>
:root{--parchment:#F6F4F1;--graphite:#2D2D2C;--blue:#4169E1;--hairline:#E6E3DF}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%}
body{font-family:"DM Sans",system-ui,sans-serif;font-weight:300;background:var(--parchment);color:var(--graphite);display:flex;flex-direction:column;font-size:clamp(16px,1.35vw,21px);line-height:1.42}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:2em}
h1{font-weight:400;font-size:2.2em;line-height:1.15;max-width:18em}
p{margin-top:1em;color:rgba(45,45,44,.62);max-width:30em}
footer{padding:.55em clamp(24px,4vw,72px);border-top:1px solid var(--hairline);font-size:.8em;text-align:right}
.wordmark{font-weight:500;color:var(--graphite)}
</style></head>
<body><main><h1>This popcorn is not live.</h1><p>The host has not published it, or the session has ended. Ask the room's host for a fresh link.</p></main>
<footer>made with <span class="wordmark">dembrane</span></footer></body></html>
`;

let flow: string | null = null;

/** What the tick does to a session's words, for hosts iterating locally. */
export function renderFlowPage(): string {
  flow ??= read("flow.html");
  return flow;
}

/** The fictional sample deck's files, keyed by path under static/sample, sorted. */
export function sampleFiles(): Record<string, unknown> {
  const root = staticPath("sample");
  const glob = new Bun.Glob("**/*.json");
  const paths = [...glob.scanSync({ cwd: root })].map((p) => p.replaceAll("\\", "/")).sort();
  return Object.fromEntries(
    paths.map((p) => [p, JSON.parse(readFileSync(staticPath("sample", p), "utf8"))]),
  );
}
