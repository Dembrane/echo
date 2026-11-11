import { escapeHtml } from "@dembrane/mail";
import type { LegalRow } from "../storage";

const LABELS = {
  en: {
    version: "Version",
    effective: "In force from",
    fingerprint: "SHA-256 of the text",
    for: "As pinned on",
  },
  nl: {
    version: "Versie",
    effective: "Van kracht vanaf",
    fingerprint: "SHA-256 van de tekst",
    for: "Zoals vastgelegd in",
  },
} as const;

/**
 * One legal text as a page to read: the text of the version a document pinned, with that
 * version, its date and its fingerprint above it, so what the signer reads is what the
 * signed record names. Self-contained (no scripts, no outside resources) and in the
 * document's language for its labels; the text itself is as published.
 */
export function legalTextPage(row: LegalRow, forDocument: string, language: string): string {
  const l = LABELS[language === "nl" ? "nl" : "en"];
  const lines = row.body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line).replaceAll("\t", " &middot; ")}</p>`)
    .join("\n");
  const facts = [
    `${l.version} ${escapeHtml(row.version)}`,
    row.effectiveOn ? `${l.effective} ${escapeHtml(row.effectiveOn)}` : null,
    `${l.for} ${escapeHtml(forDocument)}`,
  ]
    .filter(Boolean)
    .join(" &middot; ");
  return `<!doctype html>
<html lang="${language === "nl" ? "nl" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(row.title)} ${escapeHtml(row.version)}</title>
<style>
body { margin: 0; padding: 24px 16px 64px; background: #fff; color: #1a1a1a; font: 16px/1.55 system-ui, sans-serif; }
main { max-width: 720px; margin: 0 auto; }
h1 { font-size: 24px; line-height: 1.25; margin: 0 0 8px; }
.facts { color: #5c5c5c; font-size: 14px; margin: 0 0 4px; }
.hash { color: #5c5c5c; font-size: 12px; margin: 0 0 24px; overflow-wrap: anywhere; }
p { margin: 0 0 12px; overflow-wrap: anywhere; }
@media (prefers-color-scheme: dark) { body { background: #151515; color: #ececec; } .facts, .hash { color: #a8a8a8; } }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(row.title)}</h1>
<p class="facts">${facts}</p>
<p class="hash">${l.fingerprint}: ${escapeHtml(row.sha256)}</p>
${lines}
</main>
</body>
</html>
`;
}
