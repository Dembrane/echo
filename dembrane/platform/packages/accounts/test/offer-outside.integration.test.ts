import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { deliverSamMessage } from "@dembrane/webhooks";
import { eq } from "drizzle-orm";
import { PDFDocument, PDFName } from "pdf-lib";
import * as K from "../src/contract";
import type { AccountsDeps } from "../src/deps";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, pngB64, type World, world } from "./helpers";

// An offer the customer accepted outside dembrane: their order letter or purchase order, an
// email, a signature on paper. Staff record it with the evidence, and it does what a
// signature does: the customer, the tasks, the billing step, the invoice request. A DPA
// signed on paper or as their own document stands in for the one signed here.
const run = admin ? describe : describe.skip;
const DB = `accounts_outside_${process.pid}`;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A one-page PDF standing in for the customer's order letter. */
async function letter(text = "Opdrachtbevestiging 4500012345"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText(text, { x: 50, y: 780, size: 14 });
  return doc.save();
}

const eml = `From: Inkoop <inkoop@testdorp.example>
To: sales@dembrane.com
Subject: Akkoord offerte OFFER-OUT-5
Date: Thu, 1 Oct 2026 10:00:00 +0200
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

Hierbij gaan wij akkoord met de offerte.
`;

run("an offer or DPA accepted outside dembrane", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = (org: string) => `/api/v2/orgs/${org}/account`;
  const S = (org: string) => `/api/v2/admin/accounts/${org}`;

  const offer = (over: Record<string, unknown> = {}) => ({
    template: "subscription",
    language: "nl",
    offer_name: "Gemeente Testdorp",
    person_name: "Anna",
    reference: `OFFER-OUT-${Math.floor(Math.random() * 1e6)}`,
    items: [{ description: "Licentie", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 }],
    ...over,
  });

  const billing = {
    legal_name: "Gemeente Testdorp",
    billing_email: "facturen@testdorp.example",
    address_line1: "Dorpsstraat 1",
    postal_code: "1234 AB",
    city: "Testdorp",
    country: "Netherlands",
    vat_id: "NL001234567B01",
    po_number: "PO-BILLING",
  };

  const freshOrg = async (name: string) => {
    const id = newId();
    await w.db.insert(schema.org).values({ id, name, account_stage: "prospect" });
    await w.db.insert(schema.org_membership).values({
      id: newId(),
      org_id: id,
      user_id: w.people.outsider.appUserId as string,
      role: "admin",
    });
    return id;
  };

  /** Pushes and sends an offer, returning it as staff read it. */
  const sent = async (org: string, over: Record<string, unknown> = {}) => {
    const res = await call(w, "POST", `${S(org)}/offers`, "staff", offer(over));
    expect(res.status).toBe(201);
    return K.PushOfferResponse.parse(res.data).document;
  };

  const accept = async (
    org: string,
    docId: string,
    over: Record<string, unknown> = {},
    bytes?: Uint8Array,
    as: keyof World["people"] = "staff",
  ) =>
    call(w, "POST", `${S(org)}/documents/${docId}/accepted-outside`, as, {
      via: "order_letter",
      name: "Marieke Jansen",
      role: "Teamleider inkoop",
      email: "m.jansen@testdorp.example",
      accepted_on: w.clock.now.toISOString().slice(0, 10),
      customer_reference: "4500012345",
      evidence_name: "opdrachtbevestiging.pdf",
      evidence_base64: Buffer.from(bytes ?? (await letter())).toString("base64"),
      ...over,
    });

  const inbox = (code: string) =>
    w.jobs
      .of(deliverSamMessage.name)
      .filter((m) => m.code === code)
      .map((m) => (JSON.parse(m.body as string) as { json: Record<string, unknown> }).json);
  const requestedFor = (org: string) =>
    inbox("echo_account_invoice_requested_v1").filter((m) => (m.org as { id: string }).id === org);

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    (w.deps as { settings: AccountsDeps["settings"] }).settings = {
      ...w.deps.settings,
      samInbox: true,
    };
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("an order letter accepts the offer: a customer, its tasks closed, the evidence and the sent PDF's hash kept", async () => {
    const org = await freshOrg("Gemeente Brief");
    const doc = await sent(org);
    const pdf = await letter();
    const res = await accept(org, doc.id, {}, pdf);
    expect(res.status).toBe(200);
    const detail = K.DocumentDetail.parse(res.data);
    expect(detail.status).toBe("signed");
    expect(detail.accepted_outside).toEqual({
      via: "order_letter",
      accepted_on: w.clock.now.toISOString().slice(0, 10),
    });
    expect(detail.signature).toMatchObject({
      name: "Marieke Jansen",
      role: "Teamleider inkoop",
      email: "m.jansen@testdorp.example",
      method: "outside",
      image_sha256: null,
      sha256: doc.sha256,
      outside: {
        via: "order_letter",
        customer_reference: "4500012345",
        evidence_name: "opdrachtbevestiging.pdf",
        evidence_sha256: sha(pdf),
        evidence_url: `${S(org)}/documents/${doc.id}/evidence`,
      },
    });

    // The prospect is a customer, the offer's sign and who-signs tasks are done, and the
    // billing details task is open, as after a signature.
    expect((await store.org(w.db, org))?.account_stage).toBe("customer");
    const tasks = await store.tasks(w.db, org);
    const ofOffer = tasks.filter((t) => t.documentId === doc.id);
    expect(ofOffer.length).toBeGreaterThan(0);
    for (const t of ofOffer) expect(t.status).toBe("done");
    expect(tasks.find((t) => t.code === "billing_details")?.status).toBe("open");
    const card = K.AccountCard.parse((await call(w, "GET", S(org), "staff")).data);
    // The deal moves as with a signature: signed now, accepted once billing and DPA follow.
    expect(card.organisation.milestones.signed).not.toBeNull();

    // The row: insert-only, the evidence and the sent PDF's hashes, the staff member who
    // recorded it, and no signer account or signature image.
    const sig = await store.signatureOf(w.db, doc.id);
    expect(sig).toMatchObject({
      method: "outside",
      outsideVia: "order_letter",
      signerUserId: null,
      imageKey: null,
      sha256: doc.sha256,
      evidenceSha256: sha(pdf),
      evidenceType: "application/pdf",
      recordedBy: w.people.staff.directusUserId,
      customerReference: "4500012345",
    });
    const stored = await w.files.get(sig?.evidenceKey as string);
    expect(sha(new Uint8Array(await (stored as Blob).arrayBuffer()))).toBe(sha(pdf));
    await expect(
      w.db
        .update(schema.account_signature)
        .set({ typedName: "x" })
        .where(eq(schema.account_signature.id, sig?.id as string))
        .then(() => "updated"),
    ).rejects.toThrow();

    // The evidence is served to staff as stored.
    const ev = await call(w, "GET", `${S(org)}/documents/${doc.id}/evidence`, "staff");
    expect(ev.status).toBe(200);
    expect(sha(ev.data as Uint8Array)).toBe(sha(pdf));

    // The copy: the sent pages, an acceptance record page, the evidence attached inside.
    const copy = await call(w, "GET", `${S(org)}/documents/${doc.id}/signed.pdf`, "staff");
    expect(copy.status).toBe(200);
    const loaded = await PDFDocument.load(copy.data as Uint8Array);
    expect(loaded.getPageCount()).toBe((doc.page_count as number) + 1);
    expect(loaded.getSubject()).toContain("Accepted by order letter by Marieke Jansen");
    const names = loaded.catalog.lookup(PDFName.of("Names"));
    expect(String(names)).toContain("EmbeddedFiles");
    expect(sig?.confirmationText).toContain("was accepted by order letter on");
    expect(sig?.confirmationText).toContain(sha(pdf));

    // sam hears it as a signature, marked as accepted outside dembrane.
    const signed = inbox("echo_account_document_signed_v1").find(
      (m) => (m.document as { id: string }).id === doc.id,
    ) as Record<string, unknown>;
    expect(signed).toMatchObject({
      event: "account.document.signed",
      org: { id: org, account_stage: "customer" },
      signature: {
        name: "Marieke Jansen",
        email: "m.jansen@testdorp.example",
        outside: {
          via: "order_letter",
          customer_reference: "4500012345",
          evidence_sha256: sha(pdf),
          evidence: `${S(org)}/documents/${doc.id}/evidence`,
        },
      },
    });
    const events = await store.events(w.db, org);
    expect(events.find((e) => e.type === "document.accepted_outside")).toMatchObject({
      actorKind: "staff",
      subjectId: doc.id,
      detail: { via: "order_letter", customer_reference: "4500012345" },
    });
  });

  test("the invoice request follows the offer's plan and carries the reference from their order", async () => {
    // Billing details on file and their own processing terms: nothing else to wait for.
    const org = await freshOrg("Gemeente Order");
    expect((await call(w, "PUT", `${C(org)}/billing`, "outsider", billing)).status).toBe(200);
    const doc = await sent(org, {
      customer_reference: "OFFER-REF",
      processing_terms: "De verwerkersovereenkomst van de gemeente (VNG model)",
      items: [
        { description: "Licentie", quantity: 1, unit_price_cents: 90000, vat_rate_bps: 2100 },
      ],
      invoice_plan: { kind: "monthly", parts: 3 },
    });
    expect(requestedFor(org)).toHaveLength(0);
    expect((await accept(org, doc.id, { customer_reference: "4500099999" })).status).toBe(200);
    const requests = requestedFor(org) as {
      signature: { outside: { via: string } };
      invoice: { po_number: string; part: { number: number; of: number; due_on: string } };
    }[];
    // The first of three monthly parts, on the day they accepted; their PO, not the offer's.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.invoice.po_number).toBe("4500099999");
    expect(requests[0]?.invoice.part).toMatchObject({
      number: 1,
      of: 3,
      due_on: w.clock.now.toISOString().slice(0, 10),
    });
    expect(requests[0]?.signature.outside.via).toBe("order_letter");
  });

  test("an offer accepted by email with the email saved as EML, without a reference of their own", async () => {
    const org = await freshOrg("Gemeente Mail");
    expect((await call(w, "PUT", `${C(org)}/billing`, "outsider", billing)).status).toBe(200);
    const doc = await sent(org, {
      customer_reference: "OFFER-REF-5",
      processing_terms: "De verwerkersovereenkomst van de gemeente",
    });
    const res = await accept(
      org,
      doc.id,
      { via: "email", customer_reference: null, evidence_name: "akkoord.eml" },
      new TextEncoder().encode(eml),
    );
    expect(res.status).toBe(200);
    expect(K.DocumentDetail.parse(res.data).signature?.outside).toMatchObject({
      via: "email",
      evidence_name: "akkoord.eml",
    });
    expect((await store.signatureOf(w.db, doc.id))?.evidenceType).toBe("message/rfc822");
    // Without their own reference, the one the offer carried goes on the invoice.
    const [request] = requestedFor(org) as { invoice: { po_number: string } }[];
    expect(request?.invoice.po_number).toBe("OFFER-REF-5");
  });

  test("an offer is accepted once: a second acceptance, a signed, a withdrawn or a draft offer are refused", async () => {
    const org = await freshOrg("Gemeente Eenmaal");
    const doc = await sent(org);
    expect((await accept(org, doc.id)).status).toBe(200);
    const again = await accept(org, doc.id);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.data)).toContain("already signed");
    expect((await store.signatures(w.db, org)).filter((s) => s.documentId === doc.id)).toHaveLength(
      1,
    );

    // Signed here first.
    const signedHere = await sent(org);
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C(org)}/documents/${signedHere.id}`, "outsider")).data,
    );
    const values: Record<string, string | boolean> = {};
    for (const f of detail.fields) {
      if (f.kind === "name") values[f.id] = "Anna de Vries";
      else if (f.kind === "role") values[f.id] = "Wethouder";
      else if (f.kind === "date")
        values[f.id] = w.clock.now.toISOString().slice(0, 10).split("-").reverse().join("-");
      else if (f.kind === "text" && f.key !== "po_number" && f.key !== "vat_number")
        values[f.id] = f.key === "organisation" ? "Testdorp" : "n/a";
    }
    const signRes = await call(w, "POST", `${C(org)}/documents/${signedHere.id}/sign`, "outsider", {
      sha256: detail.sha256,
      values,
      signature: { png_base64: pngB64(), method: "drawn" },
      initials: null,
      dpa_authorised: true,
      confirmation_text: (detail.confirmation?.dpa_authorised ?? "")
        .replace("{name}", "Anna de Vries")
        .replace("{role}", "Wethouder")
        .replace("{organisation}", "Testdorp"),
    });
    expect(signRes.status).toBe(200);
    expect((await accept(org, signedHere.id)).status).toBe(409);
    // And a signature made here is still final.
    const voidSigned = await call(w, "POST", `${S(org)}/documents/${signedHere.id}/void`, "staff", {
      reason: "wrong",
    });
    expect(voidSigned.status).toBe(409);

    // Withdrawn.
    const withdrawn = await sent(org);
    expect(
      (await call(w, "POST", `${S(org)}/documents/${withdrawn.id}/void`, "staff", { reason: null }))
        .status,
    ).toBe(200);
    const late = await accept(org, withdrawn.id);
    expect(late.status).toBe(409);
    expect(JSON.stringify(late.data)).toContain("withdrawn");

    // A draft was never sent, so nobody could accept it.
    const draft = await sent(org, { send: false });
    expect((await accept(org, draft.id)).status).toBe(409);
  });

  test("the evidence, the day and the way of accepting are checked", async () => {
    const org = await freshOrg("Gemeente Check");
    const doc = await sent(org);
    const notAFile = await accept(org, doc.id, {}, new TextEncoder().encode("just some words"));
    expect(notAFile.status).toBe(422);
    expect(JSON.stringify(notAFile.data)).toContain("PDF or an email");
    const tomorrow = new Date(w.clock.now.getTime() + 3 * 86_400_000).toISOString().slice(0, 10);
    expect((await accept(org, doc.id, { accepted_on: tomorrow })).status).toBe(422);
    expect((await accept(org, doc.id, { accepted_on: "2026-01-01" })).status).toBe(422);
    expect((await accept(org, doc.id, { via: "own_document" })).status).toBe(422);
    // Only staff record it.
    expect((await accept(org, doc.id, {}, undefined, "outsider")).status).toBe(403);
    expect((await store.document(w.db, org, doc.id))?.status).toBe("sent");
  });

  test("a DPA signed outside dembrane stands in for the one signed here, and the invoice waits no longer", async () => {
    const org = await freshOrg("Gemeente Papier");
    expect((await call(w, "PUT", `${C(org)}/billing`, "outsider", billing)).status).toBe(200);
    const doc = await sent(org);
    expect((await accept(org, doc.id)).status).toBe(200);
    // The offer is accepted, but its DPA is a document of its own and not signed yet.
    expect(requestedFor(org)).toHaveLength(0);
    const card = K.AccountCard.parse((await call(w, "GET", S(org), "staff")).data);
    expect(card.invoice_waits).toEqual([{ document_id: doc.id, waits_for: ["dpa"] }]);
    const dpa = (await store.documents(w.db, org)).find((d) => d.kind === "dpa");
    expect(dpa?.status).toBe("sent");
    // An offer's ways do not fit a DPA.
    expect(
      (await accept(org, dpa?.id as string, { via: "order_letter", customer_reference: null }))
        .status,
    ).toBe(422);
    const scan = await letter("Verwerkersovereenkomst, getekend");
    const res = await accept(
      org,
      dpa?.id as string,
      { via: "paper", customer_reference: null, evidence_name: "dpa-getekend.pdf" },
      scan,
    );
    expect(res.status).toBe(200);
    expect((await store.document(w.db, org, dpa?.id as string))?.status).toBe("signed");
    expect((await store.tasks(w.db, org)).find((t) => t.documentId === dpa?.id)?.status).toBe(
      "done",
    );
    const [request] = requestedFor(org) as {
      document: { id: string };
      invoice: { po_number: string };
    }[];
    expect(request?.document.id).toBe(doc.id);
    expect(request?.invoice.po_number).toBe("4500012345");
    const after = K.AccountCard.parse((await call(w, "GET", S(org), "staff")).data);
    expect(after.invoice_waits).toEqual([]);
    expect(after.organisation.deal_stage).toBe("offer_accepted");
  });

  test("staff void an acceptance only with a reason; the record stays and the timeline says why", async () => {
    const org = await freshOrg("Gemeente Vergissing");
    const doc = await sent(org);
    expect((await accept(org, doc.id)).status).toBe(200);
    const bare = await call(w, "POST", `${S(org)}/documents/${doc.id}/void`, "staff", {
      reason: null,
    });
    expect(bare.status).toBe(422);
    expect((await store.document(w.db, org, doc.id))?.status).toBe("signed");
    const res = await call(w, "POST", `${S(org)}/documents/${doc.id}/void`, "staff", {
      reason: "The letter was for another offer",
    });
    expect(res.status).toBe(200);
    const detail = K.DocumentDetail.parse(res.data);
    expect(detail.status).toBe("void");
    // The acceptance and its evidence are still there, as the record.
    expect(detail.signature?.outside?.via).toBe("order_letter");
    expect(await store.signatureOf(w.db, doc.id)).not.toBeNull();
    const voided = (await store.events(w.db, org)).find(
      (e) => e.type === "document.acceptance_voided",
    );
    expect(voided).toMatchObject({
      actorKind: "staff",
      detail: { reason: "The letter was for another offer", via: "order_letter" },
    });
    const message = inbox("echo_account_document_voided_v1").find(
      (m) => (m.document as { id: string }).id === doc.id,
    );
    expect(message).toMatchObject({
      was: "signed",
      reason: "The letter was for another offer",
      accepted_outside: { via: "order_letter" },
    });
    // Voided, it cannot be accepted again.
    expect((await accept(org, doc.id)).status).toBe(409);
  });
});
