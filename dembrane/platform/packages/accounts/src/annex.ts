import { ConflictError, NotFoundError, ValidationError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { staffOrg } from "./access";
import { documentDetail } from "./customer";
import { type AccountsDeps, isUuid } from "./deps";
import { sha256Hex, storeRendered, writeFields } from "./documents";
import { emit } from "./events";
import { annexLabel, type OfferAnnex, type OfferContent, offerText } from "./offer";
import { offerPdf } from "./offer-pdf";
import type { RenderedPdf } from "./pdf";
import { type DocumentRow, store } from "./storage";

/**
 * PDFs staff attach to an offer: a project plan, a quote of a partner, the customer's own
 * terms. Each is named, numbered and lettered on from the standard annexes in the offer's
 * clause, and its pages follow the offer's in the one PDF the customer reads and signs, so
 * the hash fixed when the offer is sent covers them too. Attached and removed while the offer
 * is a draft; sent, they are as fixed as the rest.
 */
export const MAX_ANNEXES = 5;
export const MAX_ANNEX_BYTES = 10 * 1024 * 1024;

/** A PDF's page count, or a refusal when it is not a PDF pdf-lib can read and copy. */
export async function annexPages(bytes: Uint8Array): Promise<number> {
  if (
    bytes.byteLength > MAX_ANNEX_BYTES ||
    Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-"
  )
    throw new ValidationError("document.annex_invalid");
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = pdf.getPageCount();
    if (pages < 1) throw new Error("no pages");
    return pages;
  } catch {
    throw new ValidationError("document.annex_invalid");
  }
}

/**
 * An offer's PDF with its annexes after its pages, each annex page marked at the top with
 * the annex's label and its page. The fields stay where the offer put them: annexes come
 * after the acceptance.
 */
export async function renderOffer(d: AccountsDeps, content: OfferContent): Promise<RenderedPdf> {
  const rendered = await offerPdf(content);
  const annexes = content.annexes ?? [];
  if (!annexes.length) return rendered;
  const out = await PDFDocument.load(rendered.bytes, { updateMetadata: false });
  const font = await out.embedFont(StandardFonts.Helvetica);
  for (const annex of annexes) {
    const file = await d.files.get(annex.key);
    if (!file) throw new Error(`annex ${annex.number} of an offer is missing its file`);
    const source = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()), {
      updateMetadata: false,
    });
    const pages = await out.copyPages(source, source.getPageIndices());
    const label = annexLabel(content, annex).replace(/[^\x20-\x7e -ÿ]/g, "?");
    pages.forEach((page, i) => {
      out.addPage(page);
      const { width, height } = page.getSize();
      const text = `${label} · ${i + 1}/${pages.length}`;
      page.drawText(text, {
        x: Math.max(12, width - 24 - font.widthOfTextAtSize(text, 7)),
        y: height - 16,
        size: 7,
        font,
        color: rgb(0.42, 0.42, 0.42),
      });
    });
  }
  const bytes = await out.save({ useObjectStreams: false });
  return { ...rendered, bytes, pageCount: out.getPageCount() };
}

/** A draft offer a staff member changes; anything else is refused. */
async function draftOffer(d: AccountsDeps, orgId: string, docId: string) {
  const org = await staffOrg(d, orgId);
  const doc = isUuid(docId) ? await store.document(d.db, org.id, docId) : null;
  if (doc?.kind !== "offer") throw new NotFoundError("document.not_found");
  if (doc.status !== "draft") throw new ConflictError("document.already_sent");
  return { org, doc };
}

/** Draws the draft again with these annexes, and keeps its words, totals and fields in step. */
async function redraw(
  d: AccountsDeps,
  who: Signed,
  doc: DocumentRow,
  annexes: readonly OfferAnnex[],
  detail: Record<string, unknown>,
) {
  const before = doc.content as OfferContent;
  const { annexes: _old, ...rest } = before;
  const content: OfferContent = { ...rest, ...(annexes.length && { annexes }) };
  const rendered = await renderOffer(d, content);
  await d.db.transaction(async (tx) => {
    const locked = await store.documentForUpdate(tx, doc.orgId, doc.id);
    if (locked?.status !== "draft") throw new ConflictError("document.already_sent");
    const file = await storeRendered(d, doc.orgId, doc.id, rendered);
    await store.updateDocument(tx, doc.id, {
      content,
      body: offerText(content),
      ...file,
      updatedAt: d.now(),
    });
    await writeFields(tx, doc.id, rendered.fields);
    await emit(d, tx, {
      orgId: doc.orgId,
      actor: { kind: "staff", userId: who.directusUserId },
      type: "document.updated",
      subject: { type: "document", id: doc.id },
      detail: { kind: "offer", ...detail },
    });
  });
  return documentDetail(
    d,
    (await store.document(d.db, doc.orgId, doc.id)) as DocumentRow,
    "staff",
    who,
  );
}

/** Attaches a PDF to a draft offer, as its next annex. */
export async function addAnnex(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  input: { readonly name: string; readonly bytes: Uint8Array },
) {
  const { org, doc } = await draftOffer(d, orgId, docId);
  const annexes = (doc.content as OfferContent).annexes ?? [];
  if (annexes.length >= MAX_ANNEXES)
    throw new ValidationError("document.annex_limit", { params: { max: MAX_ANNEXES } });
  const pages = await annexPages(input.bytes);
  const sha256 = sha256Hex(input.bytes);
  const key = `accounts/${org.id}/documents/${doc.id}/annex-${sha256}.pdf`;
  await d.files.put(key, input.bytes, "application/pdf");
  const annex: OfferAnnex = {
    number: annexes.length + 1,
    name: input.name,
    pages,
    sha256,
    bytes: input.bytes.byteLength,
    key,
  };
  return redraw(d, who, doc, [...annexes, annex], {
    annex_added: { number: annex.number, name: annex.name, sha256 },
  });
}

/** Takes an annex off a draft offer; the ones after it move up one. */
export async function removeAnnex(
  d: AccountsDeps,
  who: Signed,
  orgId: string,
  docId: string,
  number: number,
) {
  const { doc } = await draftOffer(d, orgId, docId);
  const annexes = (doc.content as OfferContent).annexes ?? [];
  const gone = annexes.find((a) => a.number === number);
  if (!gone) throw new NotFoundError("document.annex_not_found", { params: { number } });
  const rest = annexes.filter((a) => a.number !== number).map((a, i) => ({ ...a, number: i + 1 }));
  return redraw(d, who, doc, rest, { annex_removed: { number, name: gone.name } });
}
