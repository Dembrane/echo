import { describe, expect, test } from "bun:test";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFRawStream,
} from "pdf-lib";
import { type AuditRecord, signedPdf, textPdf } from "../src/pdf";
import { png } from "./helpers";

/** Decoded bytes of a stream object. */
function streamText(stream: PDFRawStream): string {
  return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
}

/** glyph code to character, from a font's ToUnicode map. */
function toUnicode(doc: PDFDocument, font: PDFDict): Map<string, string> {
  const map = new Map<string, string>();
  const stream = doc.context.lookup(font.get(PDFName.of("ToUnicode"))) as PDFRawStream;
  const cmap = streamText(stream);
  for (const m of cmap.matchAll(/^<([0-9a-f]{4})> <([0-9a-f]{4,})>$/gim)) {
    const [, code, uni] = m;
    // A ligature glyph (fi) maps to more than one character.
    const chars = (uni as string).match(/.{4}/g) ?? [];
    map.set(
      (code as string).toUpperCase(),
      chars.map((c) => String.fromCharCode(Number.parseInt(c, 16))).join(""),
    );
  }
  return map;
}

/** The text of the last page, one string per drawn line, in drawing order. */
function lastPageLines(doc: PDFDocument): string[] {
  const page = doc.getPages().at(-1);
  if (!page) return [];
  const fonts = page.node.Resources()?.lookup(PDFName.of("Font"), PDFDict) as PDFDict;
  const maps = new Map<string, Map<string, string>>();
  for (const [name] of fonts.entries()) {
    maps.set(name.asString(), toUnicode(doc, fonts.lookup(name, PDFDict)));
  }
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((r) => doc.context.lookup(r) as PDFRawStream)
      : [contents as PDFRawStream];
  const lines: string[] = [];
  let current: Map<string, string> | undefined;
  for (const s of streams) {
    for (const m of streamText(s).matchAll(/\/(\S+)\s+[\d.]+\s+Tf|<([0-9a-f]+)>\s*Tj/gi)) {
      if (m[1]) current = maps.get(`/${m[1]}`);
      else if (m[2] && current) {
        let text = "";
        for (let i = 0; i < m[2].length; i += 4) {
          text += current.get(m[2].slice(i, i + 4).toUpperCase()) ?? "";
        }
        lines.push(text);
      }
    }
  }
  return lines;
}

const record = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  documentTitle: "Plan",
  documentId: "doc-id-1",
  reference: "DMB-7",
  version: 2,
  sha256: "a".repeat(64),
  signerName: "Anna",
  signerRole: "Wethouder",
  email: "a@b.example",
  organisation: "Gemeente",
  address: "Dorpsstraat 1",
  vatNumber: "NL123456789B01",
  dpaAuthorised: true,
  signedAt: "2026-09-28T10:00:00.000Z",
  ip: "203.0.113.7",
  userAgent: "ua-string",
  confirmationText: "I, Anna, confirm.",
  signatureId: "sig-id-1",
  method: "drawn",
  imageSha256: "b".repeat(64),
  language: "nl",
  legal: [{ kind: "terms", version: "3.0.1", effectiveOn: "2026-10-01", sha256: "c".repeat(64) }],
  trail: [{ at: "2026-09-28T09:58:00.000Z", what: "First opened by a@b.example" }],
  choices: [{ label: "Extra seats", chosen: true }],
  ...over,
});

async function auditLines(audit: AuditRecord) {
  const r = await textPdf("Plan", "# Plan\n\nText", { signing: true, language: "en" });
  const out = await signedPdf(r.bytes, [], {}, { signature: png(), initials: null }, audit);
  return lastPageLines(await PDFDocument.load(out));
}

describe("signature record", () => {
  test("groups its details under headings, in order", async () => {
    const lines = await auditLines(record());
    const at = (text: string) => lines.indexOf(text);
    const headings = [
      "The document",
      "Who signed",
      "When and where",
      "Verification",
      "Audit trail (UTC)",
      "Confirmation shown and accepted",
    ];
    const positions = headings.map(at);
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("every recorded field is still on the page", async () => {
    const a = record();
    const lines = await auditLines(a);
    const page = lines.join("\n");
    const values = [
      a.documentTitle,
      a.documentId,
      a.reference,
      String(a.version),
      a.sha256,
      a.signerName,
      a.signerRole,
      a.email,
      a.organisation,
      a.address,
      a.vatNumber,
      "yes",
      "Extra seats",
      "chosen",
      "Dutch (nl)",
      a.method,
      a.imageSha256,
      a.signedAt,
      a.ip,
      a.userAgent,
      a.signatureId,
      `version 3.0.1, 2026-10-01, SHA-256 ${"c".repeat(64)}`,
      a.confirmationText,
      "First opened by a@b.example",
    ];
    // Long values wrap between characters, so compare without line breaks or spaces.
    const flat = page.replace(/\s/g, "");
    for (const v of values) expect(flat).toContain((v as string).replace(/\s/g, ""));
  });

  test("the optional rows and their empty groups stay out when there is nothing to say", async () => {
    const lines = await auditLines(
      record({
        reference: null,
        signerRole: null,
        address: null,
        vatNumber: null,
        dpaAuthorised: null,
        choices: [],
        legal: [],
        trail: [],
        ip: null,
        userAgent: null,
      }),
    );
    expect(lines).not.toContain("Reference");
    expect(lines).not.toContain("Audit trail (UTC)");
    expect(lines.filter((l) => l === "not recorded")).toHaveLength(2);
  });
});
