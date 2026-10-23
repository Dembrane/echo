import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@dembrane/db";
import { deliverSamMessage } from "@dembrane/webhooks";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import * as K from "../src/contract";
import type { AccountsDeps } from "../src/deps";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, pngB64, type World, world } from "./helpers";

// Annexes attached to an offer, and offers that ask for a second signature: another
// signatory of the customer, or dembrane's counter-signature.
const run = admin ? describe : describe.skip;
const DB = `accounts_signers_${process.pid}`;

/** A PDF of `pages` pages standing in for a project plan. */
async function plan(pages = 2): Promise<string> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++)
    doc.addPage([595, 842]).drawText(`Plan ${i + 1}`, { x: 50, y: 780 });
  return Buffer.from(await doc.save()).toString("base64");
}

run("annexes and a second signature", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  let n = 0;
  const offer = (over: Record<string, unknown> = {}) => ({
    template: "custom",
    language: "en",
    offer_name: "Gemeente Testdorp",
    person_name: "Anna",
    reference: `OFFER-SIG-${++n}`,
    items: [{ description: "Licence", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 }],
    ...over,
  });
  const draft = async (over: Record<string, unknown> = {}) => {
    const r = await call(w, "POST", `${S()}/offers`, "staff", offer({ send: false, ...over }));
    expect(r.status).toBe(201);
    return K.PushOfferResponse.parse(r.data).document;
  };
  const send = async (id: string) =>
    K.DocumentDetail.parse(
      (await call(w, "POST", `${S()}/documents/${id}/send`, "staff", {})).data,
    );
  const billing = {
    legal_name: "Gemeente Testdorp",
    billing_email: "finance@testdorp.example",
    address_line1: "Dorpsstraat 1",
    postal_code: "1234 AB",
    city: "Testdorp",
    country: "Netherlands",
    vat_id: "NL001234567B01",
  };
  const inbox = (code: string) =>
    w.jobs
      .of(deliverSamMessage.name)
      .filter((m) => m.code === code)
      .map((m) => (JSON.parse(m.body as string) as { json: Record<string, unknown> }).json);
  const requested = (docId: string) =>
    inbox("echo_account_invoice_requested_v1").filter(
      (m) => (m.document as { id: string }).id === docId,
    );

  /** Signs as `as`, filling the fields the page gives them. */
  async function sign(docId: string, as: keyof World["people"], name: string) {
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${docId}`, as)).data,
    );
    const values: Record<string, string | boolean> = {};
    for (const f of detail.fields) {
      if (f.kind === "name") values[f.id] = name;
      else if (f.kind === "role") values[f.id] = "Wethouder";
      else if (f.kind === "date")
        values[f.id] = w.clock.now.toISOString().slice(0, 10).split("-").reverse().join("-");
      else if (f.kind === "checkbox") values[f.id] = true;
      else if (f.kind === "text" && f.key !== "po_number")
        values[f.id] = f.key === "organisation" ? "Testdorp" : "n/a";
    }
    const res = await call(w, "POST", `${C()}/documents/${docId}/sign`, as, {
      sha256: detail.sha256,
      values,
      signature: { png_base64: pngB64(), method: "drawn" },
      initials: null,
      dpa_authorised: true,
      confirmation_text: (detail.confirmation?.dpa_authorised ?? "")
        .replace("{name}", name)
        .replace("{role}", "Wethouder")
        .replace("{organisation}", "Testdorp"),
    });
    return { res, detail };
  }

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    (w.deps as { settings: AccountsDeps["settings"] }).settings = {
      ...w.deps.settings,
      samInbox: true,
    };
    // The staff member signs for dembrane under a dembrane address.
    await w.db
      .update(schema.auth_user)
      .set({ email: "staff@dembrane.com" })
      .where(eq(schema.auth_user.id, w.people.staff.directusUserId));
    expect((await call(w, "PUT", `${C()}/billing`, "admin", billing)).status).toBe(200);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("an annex is listed in the clause, follows the offer's pages and is part of what is sent", async () => {
    const doc = await draft();
    const path = `${S()}/offers/${doc.id}/annexes`;
    const added = K.DocumentDetail.parse(
      (await call(w, "POST", path, "staff", { name: "Project plan", pdf_base64: await plan(2) }))
        .data,
    );
    expect(added.content?.annexes?.map((a) => [a.number, a.name, a.pages])).toEqual([
      [1, "Project plan", 2],
    ]);
    // A custom offer lists the SLA and DPA as annexes A and B; the plan follows as C.
    expect(added.body).toContain("Annex C: Project plan, attached to this offer (2 pages)");
    expect(added.page_count).toBe((doc.page_count ?? 0) + 2);
    const second = K.DocumentDetail.parse(
      (await call(w, "POST", path, "staff", { name: "Partner quote", pdf_base64: await plan(1) }))
        .data,
    );
    expect(second.body).toContain("Annex D: Partner quote, attached to this offer (1 page)");
    // A change of the draft keeps them; removing one moves the next up.
    const changed = K.DocumentDetail.parse(
      (
        await call(
          w,
          "PUT",
          `${S()}/offers/${doc.id}`,
          "staff",
          offer({ reference: doc.reference, person_name: "Bo" }),
        )
      ).data,
    );
    expect(changed.content?.annexes).toHaveLength(2);
    const removed = K.DocumentDetail.parse(
      (await call(w, "POST", `${path}/1/remove`, "staff", {})).data,
    );
    expect(removed.content?.annexes?.map((a) => [a.number, a.name])).toEqual([
      [1, "Partner quote"],
    ]);
    expect(removed.body).toContain("Annex C: Partner quote");
    // Not a PDF, too many, or after sending: refused.
    const bad = await call(w, "POST", path, "staff", {
      name: "Notes",
      pdf_base64: Buffer.from("hello").toString("base64"),
    });
    expect(bad.status).toBe(422);
    const sent = await send(doc.id);
    // The PDF the customer signs carries the annex: its hash is of the merged file.
    const file = await call(w, "GET", `${S()}/documents/${doc.id}/file`, "staff");
    const bytes = file.data as Uint8Array;
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(sent.page_count as number);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sent.sha256 as string);
    const late = await call(w, "POST", path, "staff", { name: "Late", pdf_base64: await plan(1) });
    expect(late.status).toBe(409);
  });

  test("a second signatory of the customer: the offer is accepted, and invoiced, once both have signed", async () => {
    const doc = await draft({ second_signer: { kind: "customer", name: null, email: null } });
    expect(doc.body).toContain("### Second signature");
    expect(doc.fields.filter((f) => f.signer_role === "second").map((f) => f.kind)).toEqual([
      "name",
      "role",
      "date",
      "signature",
    ]);
    await send(doc.id);
    // The first signer sees only their own fields.
    const first = await sign(doc.id, "admin", "Anna de Vries");
    expect(first.detail.fields.every((f) => f.signer_role === "signer")).toBe(true);
    expect(first.res.status).toBe(200);
    let row = await store.document(w.db, w.orgId, doc.id);
    expect(row?.status).not.toBe("signed");
    expect(requested(doc.id)).toEqual([]);
    const waiting = K.DocumentDetail.parse(
      (await call(w, "GET", `${S()}/documents/${doc.id}`, "staff")).data,
    );
    expect(waiting.awaiting_signatures).toEqual(["second"]);
    expect(waiting.signed_pdf_url).toBeNull();
    // The same person cannot sign twice.
    const again = await sign(doc.id, "admin", "Anna de Vries");
    expect(again.res.status).toBe(403);
    // Someone else who may sign: their own fields, then the offer is signed.
    const second = await sign(doc.id, "billing", "Bram Jansen");
    expect(second.detail.fields.every((f) => f.signer_role === "second")).toBe(true);
    expect(second.res.status).toBe(200);
    row = await store.document(w.db, w.orgId, doc.id);
    expect(row?.status).toBe("signed");
    const sigs = await store.signaturesOf(w.db, doc.id);
    expect(sigs.map((s) => [s.slot, s.typedName])).toEqual([
      ["customer", "Anna de Vries"],
      ["second", "Bram Jansen"],
    ]);
    // sam hears of the signature once, with both, and the invoice request follows the DPA.
    const signed = inbox("echo_account_document_signed_v1").filter(
      (m) => (m.document as { id: string }).id === doc.id,
    );
    expect(signed).toHaveLength(1);
    expect(((signed[0]?.signatures ?? []) as { slot: string }[]).map((s) => s.slot)).toEqual([
      "customer",
      "second",
    ]);
    expect((signed[0]?.signature as { name: string } | undefined)?.name).toBe("Anna de Vries");
    for (const dpa of (await store.documents(w.db, w.orgId)).filter(
      (x) => x.kind === "dpa" && x.status !== "signed",
    ))
      expect((await sign(dpa.id, "admin", "Anna de Vries")).res.status).toBe(200);
    expect(requested(doc.id)).toHaveLength(1);
  });

  test("dembrane's counter-signature by the staff member named, before or after the customer", async () => {
    const refused = await call(
      w,
      "POST",
      `${S()}/offers`,
      "staff",
      offer({
        send: false,
        second_signer: { kind: "dembrane", name: "X", email: "x@example.test" },
      }),
    );
    expect(refused.status).toBe(422);
    const doc = await draft({
      second_signer: {
        kind: "dembrane",
        name: "Jordan Staff",
        email: "Staff@dembrane.com",
        role: "Co-founder",
      },
    });
    expect(doc.content?.second_signer).toEqual({
      kind: "dembrane",
      name: "Jordan Staff",
      email: "staff@dembrane.com",
      role: "Co-founder",
    });
    expect(doc.body).toContain("### For dembrane B.V.\nName: Jordan Staff\nRole: Co-founder");
    const path = `${S()}/documents/${doc.id}/countersign`;
    const body = { signature: { png_base64: pngB64(), method: "drawn" } };
    // Not before it is sent; never by a staff key.
    expect((await call(w, "POST", path, "staff", body)).status).toBe(409);
    await send(doc.id);
    expect((await call(w, "POST", path, "key", body)).status).toBe(403);
    // The customer signs first: the offer waits for dembrane.
    const customer = await sign(doc.id, "admin", "Anna de Vries");
    expect(customer.detail.fields.some((f) => f.signer_role === "dembrane")).toBe(false);
    expect(customer.res.status).toBe(200);
    expect((await store.document(w.db, w.orgId, doc.id))?.status).not.toBe("signed");
    // Signed by the customer, it is not revised any more.
    const revision = await call(
      w,
      "POST",
      `${S()}/offers`,
      "staff",
      offer({ send: false, supersedes_id: doc.id }),
    );
    expect(revision.status).toBe(409);
    const card = K.AccountCard.parse((await call(w, "GET", S(), "staff")).data);
    expect(card.documents.find((x) => x.id === doc.id)?.signed_pdf_url).toBeNull();
    const signedNow = K.DocumentDetail.parse((await call(w, "POST", path, "staff", body)).data);
    expect(signedNow.status).toBe("signed");
    expect(signedNow.signatures.map((s) => [s.slot, s.name])).toEqual([
      ["customer", "Anna de Vries"],
      ["dembrane", "Jordan Staff"],
    ]);
    expect(signedNow.awaiting_signatures).toEqual([]);
    expect((await call(w, "POST", path, "staff", body)).status).toBe(409);
    const copy = await call(w, "GET", `${S()}/documents/${doc.id}/signed.pdf`, "staff");
    expect(copy.status).toBe(200);
    // Two record pages: the customer's and dembrane's.
    const pages = (await PDFDocument.load(copy.data as Uint8Array)).getPageCount();
    expect(pages).toBe((doc.page_count ?? 0) + 2);
    // Each signature is its own row, and stays as it was.
    await expect(
      w.db
        .update(schema.account_signature)
        .set({ typedName: "Someone" })
        .where(eq(schema.account_signature.documentId, doc.id))
        .then(() => "updated"),
    ).rejects.toThrow();
  });

  test("an order letter accepts for the customer, and dembrane's signature completes it", async () => {
    const doc = await draft({
      second_signer: { kind: "dembrane", name: "Jordan Staff", email: "staff@dembrane.com" },
    });
    await send(doc.id);
    const letter = await PDFDocument.create();
    letter.addPage([595, 842]).drawText("Opdracht", { x: 50, y: 780 });
    const accepted = await call(w, "POST", `${S()}/documents/${doc.id}/accepted-outside`, "staff", {
      via: "order_letter",
      name: "Marieke Jansen",
      email: "m.jansen@testdorp.example",
      accepted_on: w.clock.now.toISOString().slice(0, 10),
      evidence_name: "letter.pdf",
      evidence_base64: Buffer.from(await letter.save()).toString("base64"),
    });
    expect(accepted.status).toBe(200);
    expect(K.DocumentDetail.parse(accepted.data).awaiting_signatures).toEqual(["dembrane"]);
    // The customer has nothing left to sign.
    expect((await sign(doc.id, "admin", "Anna de Vries")).res.status).toBe(409);
    const done = K.DocumentDetail.parse(
      (
        await call(w, "POST", `${S()}/documents/${doc.id}/countersign`, "staff", {
          signature: { png_base64: pngB64(), method: "drawn" },
        })
      ).data,
    );
    expect(done.status).toBe("signed");
  });

  test("an offer that asks for one signature behaves as before", async () => {
    const doc = await draft();
    expect(doc.fields.every((f) => f.signer_role === "signer")).toBe(true);
    await send(doc.id);
    expect((await sign(doc.id, "admin", "Anna de Vries")).res.status).toBe(200);
    const after = K.DocumentDetail.parse(
      (await call(w, "GET", `${S()}/documents/${doc.id}`, "staff")).data,
    );
    expect([after.status, after.signatures.length, after.awaiting_signatures]).toEqual([
      "signed",
      1,
      [],
    ]);
  });
});
