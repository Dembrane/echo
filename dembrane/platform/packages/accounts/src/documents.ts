import { createHash } from "node:crypto";
import { newId } from "@dembrane/core";
import type { AccountsDeps, Conn } from "./deps";
import type { PlacedField, RenderedPdf } from "./pdf";
import { type FieldRow, store } from "./storage";

export const sha256Hex = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/** The unsigned PDF's storage key. One per document: a sent document never changes. */
export const fileKeyOf = (orgId: string, docId: string) =>
  `accounts/${orgId}/documents/${docId}/document.pdf`;

/** Stores a document's PDF and returns what the row records about it. */
export async function storePdf(
  d: AccountsDeps,
  orgId: string,
  docId: string,
  bytes: Uint8Array,
  pageCount: number,
): Promise<{ fileKey: string; sha256: string; pageCount: number }> {
  const fileKey = fileKeyOf(orgId, docId);
  await d.files.put(fileKey, bytes, "application/pdf");
  return { fileKey, sha256: sha256Hex(bytes), pageCount };
}

export async function storeRendered(d: AccountsDeps, orgId: string, docId: string, r: RenderedPdf) {
  return storePdf(d, orgId, docId, r.bytes, r.pageCount);
}

/** The "Next" walk: page by page, top to bottom, then left to right. */
export function walkOrder<T extends Pick<PlacedField, "page" | "x" | "y">>(
  fields: readonly T[],
): T[] {
  return [...fields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}

export async function writeFields(
  tx: Conn,
  documentId: string,
  fields: readonly PlacedField[],
): Promise<void> {
  await store.setFields(
    tx,
    documentId,
    walkOrder(fields).map((f, sort) => ({
      id: newId(),
      documentId,
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      kind: f.kind,
      label: f.label,
      required: f.required,
      signerRole: "signer",
      key: f.key,
      sort,
    })),
  );
}

/** Fields must sit on a page of the document and a signable document needs a signature field. */
export function fieldProblems(
  fields: readonly Pick<FieldRow | PlacedField, "page" | "x" | "y" | "width" | "height" | "kind">[],
  pageCount: number | null,
  requiresSignature: boolean,
): string | null {
  for (const [i, f] of fields.entries()) {
    if (pageCount !== null && f.page > pageCount)
      return `Field ${i + 1} is on page ${f.page}; the document has ${pageCount}`;
    if (f.x + f.width > 1.0001 || f.y + f.height > 1.0001)
      return `Field ${i + 1} runs off the page`;
  }
  if (requiresSignature && !fields.some((f) => f.kind === "signature"))
    return "A document to sign needs a signature field";
  // The signature record names the signer from this field.
  if (requiresSignature && !fields.some((f) => f.kind === "name"))
    return "A document to sign needs a name field";
  return null;
}
