import type { GmailPart } from "./gmail";

/**
 * One email as a chat bubble: what this message added, with the quoted history every
 * reply drags along, the signature and the "Sent from my phone" line cut off. Works on
 * the plain-text part when there is one, else on the HTML turned into text.
 */

const MAX_TEXT = 8000;

export const header = (p: GmailPart | undefined, name: string): string | null => {
  const n = name.toLowerCase();
  return p?.headers?.find((h) => h.name.toLowerCase() === n)?.value ?? null;
};

const decode = (data: string | undefined) =>
  data ? Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";

/** The first part of this MIME type, depth first; attachments (with a filename) skipped. */
function find(p: GmailPart | undefined, type: string): string | null {
  if (!p) return null;
  const disposition = header(p, "content-disposition") ?? "";
  if (p.mimeType === type && p.body?.data && !/attachment/i.test(disposition))
    return decode(p.body.data);
  for (const c of p.parts ?? []) {
    const hit = find(c, type);
    if (hit !== null) return hit;
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** HTML mail to text, the quoted history (Gmail, Apple Mail, Outlook) removed first. */
export function htmlToText(html: string): string {
  let h = html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "");
  // Everything from the first quote container on is history.
  const cut = h.search(
    /<div[^>]+class="[^"]*gmail_quote|<blockquote|<div[^>]+id="(appendonsend|divRplyFwdMsg|mail-editor-reference-message-container)"/i,
  );
  if (cut >= 0) h = h.slice(0, cut);
  return h
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

// "On Tue, 3 Nov 2026 at 10:00, Ann <ann@x.nl> wrote:" in the languages our clients write.
const ATTRIBUTION =
  /^(on\b.{0,300}\bwrote|op\b.{0,300}\bschreef\b.{0,200}|op\b.{0,300}\bgeschreven|am\b.{0,300}\bschrieb\b.{0,200}|le\b.{0,300}\ba écrit\b.{0,10}|el\b.{0,300}\bescribió\b.{0,10})\s*:\s*$/i;
const ORIGINAL =
  /^-{2,}\s*(original message|oorspronkelijk bericht|ursprüngliche nachricht|message d'origine)\s*-{2,}/i;
const HEADER_FROM = /^\*?(from|van|von|de)\s*:\*?\s+\S/i;
const HEADER_NEXT =
  /^\*?(sent|verzonden|gesendet|envoyé|date|datum|to|aan|an|à|subject|onderwerp)\s*:/i;
const MOBILE =
  /^(sent from my|verzonden (vanaf|met) mijn|von meinem .* gesendet|envoyé de mon|get outlook for)/i;

/** The text a message added: cut at the first sign of quoted history or the signature. */
export function newText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    const two = `${line} ${(lines[i + 1] ?? "").trim()}`;
    const outlook =
      HEADER_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => HEADER_NEXT.test(l.trim()));
    if (
      line === "--" ||
      (lines[i] ?? "") === "-- " ||
      ATTRIBUTION.test(line) ||
      (/^(on|op|am|le|el)\b/i.test(line) && ATTRIBUTION.test(two)) ||
      ORIGINAL.test(line) ||
      outlook ||
      (/^_{8,}$/.test(line) && HEADER_FROM.test((lines[i + 1] ?? "").trim()))
    ) {
      end = i;
      break;
    }
  }
  const kept = lines
    .slice(0, end)
    .filter((l) => !/^\s*>/.test(l) && !MOBILE.test(l.trim()))
    .join("\n")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return kept.length > MAX_TEXT ? `${kept.slice(0, MAX_TEXT)}…` : kept;
}

/** The new text of one Gmail message; the whole text when cutting would leave nothing. */
export function messageText(payload: GmailPart | undefined): string {
  const plain = find(payload, "text/plain");
  const html = plain === null ? find(payload, "text/html") : null;
  const raw = plain ?? (html !== null ? htmlToText(html) : "");
  const cut = newText(raw);
  if (cut) return cut;
  const whole = raw.replace(/\n{3,}/g, "\n\n").trim();
  return whole.length > MAX_TEXT ? `${whole.slice(0, MAX_TEXT)}…` : whole;
}

/** "Ann de Vries <ann@x.nl>, bob@y.nl" → [{ name, email }]. */
export function addresses(value: string | null): { name: string | null; email: string }[] {
  if (!value) return [];
  const out: { name: string | null; email: string }[] = [];
  // Split on commas outside quotes and angle brackets.
  const parts = value.match(/("[^"]*"|<[^>]*>|[^,])+/g) ?? [];
  for (const p of parts) {
    const s = p.trim();
    const angle = s.match(/^(.*)<([^>]+)>$/);
    const email = (angle ? angle[2] : s)?.trim().toLowerCase() ?? "";
    if (!email.includes("@")) continue;
    const name = angle?.[1]?.trim().replace(/^"|"$/g, "").trim() || null;
    out.push({ name, email });
  }
  return out;
}
