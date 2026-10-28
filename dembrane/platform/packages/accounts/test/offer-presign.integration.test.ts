import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { schema } from "@dembrane/db";
import { deliverSamMessage } from "@dembrane/webhooks";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import * as K from "../src/contract";
import type { AccountsDeps, Signatory } from "../src/deps";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, pngB64, type World, world } from "./helpers";

// dembrane signs what it sends: with a signatory configured, an offer and its DPA carry
// dembrane's signature from the moment they are sent, and the customer's completes them.
const run = admin ? describe : describe.skip;
const DB = `accounts_presign_${process.pid}`;

run("dembrane's signature on what it sends", () => {
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
    reference: `OFFER-PRE-${++n}`,
    items: [{ description: "Licence", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 }],
    ...over,
  });
  const draft = async (over: Record<string, unknown> = {}) => {
    const r = await call(w, "POST", `${S()}/offers`, "staff", offer({ send: false, ...over }));
    expect(r.status).toBe(201);
    return K.PushOfferResponse.parse(r.data).document;
  };
  const send = async (id: string) => {
    const r = await call(w, "POST", `${S()}/documents/${id}/send`, "staff", {});
    expect(r.status).toBe(200);
    return K.DocumentDetail.parse(r.data);
  };
  const staffView = async (id: string) =>
    K.DocumentDetail.parse((await call(w, "GET", `${S()}/documents/${id}`, "staff")).data);
  const signatory = (s: Signatory | null) => {
    (w.deps as { settings: AccountsDeps["settings"] }).settings = {
      ...w.deps.settings,
      signatory: s,
    };
  };
  const configured: Signatory = {
    email: "staff@dembrane.com",
    name: "Robin Signatory",
    role: "Director",
  };
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

  test("a sent offer and its DPA carry dembrane's signature; the customer's completes the offer", async () => {
    signatory(configured);
    // A draft carries none: nothing is signed before it is sent.
    const doc = await draft();
    expect(doc.content?.dembrane_signature).toBeUndefined();
    expect(doc.body).not.toContain("Signed electronically");
    expect(await store.signaturesOf(w.db, doc.id)).toEqual([]);

    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    const sentAt = w.clock.now.toISOString();
    const sent = await send(doc.id);
    expect(sent.content?.dembrane_signature).toEqual({
      name: "Robin Signatory",
      role: "Director",
      email: "staff@dembrane.com",
      signed_at: sentAt,
    });
    const day = sentAt.slice(0, 10).split("-").reverse().join("-");
    expect(sent.body).toContain(
      `### For dembrane B.V.\nName: Robin Signatory\nRole: Director\nDate: ${day}\nSignature: Signed electronically`,
    );
    // Nothing in it is for anyone to fill in.
    expect(sent.fields.every((f) => f.signer_role === "signer")).toBe(true);
    const [ours] = await store.signaturesOf(w.db, doc.id);
    expect(ours).toMatchObject({
      slot: "dembrane",
      method: "presigned",
      typedName: "Robin Signatory",
      typedRole: "Director",
      email: "staff@dembrane.com",
      organisation: "dembrane B.V.",
      signerUserId: w.people.staff.directusUserId,
      sha256: sent.sha256,
      signedPdfSha256: sent.sha256,
      imageKey: null,
    });
    expect(ours?.signedAt.toISOString()).toBe(sentAt);
    expect(sent.signatures.map((s) => [s.slot, s.name])).toEqual([["dembrane", "Robin Signatory"]]);
    expect(sent.awaiting_signatures).toEqual(["customer"]);
    expect(sent.signed_pdf_url).toBeNull();
    expect((await call(w, "GET", `${S()}/documents/${doc.id}/signed.pdf`, "staff")).status).toBe(
      404,
    );

    // The DPA sent with it carries the same signature, as its own row.
    const dpa = (await store.documents(w.db, w.orgId)).find((x) => x.kind === "dpa");
    expect(dpa?.status).toBe("sent");
    const dpaSigs = await store.signaturesOf(w.db, dpa?.id as string);
    expect(dpaSigs.map((s) => [s.slot, s.method, s.typedName, s.sha256])).toEqual([
      ["dembrane", "presigned", "Robin Signatory", dpa?.sha256 as string],
    ]);
    expect(
      (await store.fields(w.db, dpa?.id as string)).every(
        (f) => (f.signerRole ?? "signer") === "signer",
      ),
    ).toBe(true);

    // The customer signs once: the offer is signed, its tasks and invoice follow as always.
    const signed = await sign(doc.id, "admin", "Anna de Vries");
    expect(signed.res.status).toBe(200);
    const after = await staffView(doc.id);
    expect(after.status).toBe("signed");
    expect(after.signatures.map((s) => [s.slot, s.name])).toEqual([
      ["dembrane", "Robin Signatory"],
      ["customer", "Anna de Vries"],
    ]);
    expect(after.awaiting_signatures).toEqual([]);
    const tasks = await store.tasks(w.db, w.orgId);
    expect(tasks.find((t) => t.code === "sign_offer" && t.documentId === doc.id)?.status).toBe(
      "done",
    );
    const message = inbox("echo_account_document_signed_v1").filter(
      (m) => (m.document as { id: string }).id === doc.id,
    );
    expect(message).toHaveLength(1);
    expect(((message[0]?.signatures ?? []) as { slot: string }[]).map((s) => s.slot)).toEqual([
      "dembrane",
      "customer",
    ]);
    expect((message[0]?.signature as { name: string } | undefined)?.name).toBe("Anna de Vries");
    // The signed copy is the PDF as sent, which prints dembrane's signature, with the
    // customer's stamped on it and its record page.
    const copy = await call(w, "GET", `${S()}/documents/${doc.id}/signed.pdf`, "staff");
    expect(copy.status).toBe(200);
    expect((await PDFDocument.load(copy.data as Uint8Array)).getPageCount()).toBe(
      (sent.page_count ?? 0) + 1,
    );
    // The DPA the same: the customer's signature completes it, then the invoice is asked.
    expect(requested(doc.id)).toEqual([]);
    expect((await sign(dpa?.id as string, "admin", "Anna de Vries")).res.status).toBe(200);
    expect((await store.document(w.db, w.orgId, dpa?.id as string))?.status).toBe("signed");
    expect(requested(doc.id)).toHaveLength(1);
  });

  test("staff choose who signs for dembrane: the draft keeps them and the offer and its DPA carry them", async () => {
    signatory(configured);
    // The card offers the configured signatory as the default for a new offer.
    const card = K.AccountCard.parse((await call(w, "GET", S(), "staff")).data);
    expect(card.dembrane_signer).toEqual({
      name: "Robin Signatory",
      role: "Director",
      email: "staff@dembrane.com",
    });
    // Only a staff member signs for dembrane.
    const outsider = await call(
      w,
      "POST",
      `${S()}/offers`,
      "staff",
      offer({ send: false, dembrane_signer: { name: "Kim Buiten", email: "kim@example.org" } }),
    );
    expect(outsider.status).toBe(422);

    // An account of its own, so its DPA (one per account and text) opens with this offer.
    const created = await call(w, "POST", "/api/v2/admin/accounts", "staff", {
      organisation_name: "Stichting Voorbeeld",
      contact_email: "contact@voorbeeld.example",
      stage: "customer",
    });
    expect(created.status).toBe(201);
    const orgId = K.CreateAccountResponse.parse(created.data).org_id;
    const O = `/api/v2/admin/accounts/${orgId}`;
    const chosen = { name: "Jamie Voorbeeld", role: "Sales", email: "Jamie@dembrane.com" };
    const pushed = await call(
      w,
      "POST",
      `${O}/offers`,
      "staff",
      offer({ send: false, dembrane_signer: chosen }),
    );
    expect(pushed.status).toBe(201);
    const doc = K.PushOfferResponse.parse(pushed.data).document;
    expect(doc.content?.dembrane_signer).toEqual({ ...chosen, email: "jamie@dembrane.com" });
    expect(doc.content?.dembrane_signature).toBeUndefined();
    // A change that leaves the signer out keeps the draft's.
    const changed = await call(w, "PUT", `${O}/offers/${doc.id}`, "staff", {
      ...offer({ reference: doc.reference }),
      person_name: "Anna de Vries",
    });
    expect(changed.status).toBe(200);
    expect(K.DocumentDetail.parse(changed.data).content?.dembrane_signer?.name).toBe(
      "Jamie Voorbeeld",
    );

    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    const sentAt = w.clock.now.toISOString();
    const sending = await call(w, "POST", `${O}/documents/${doc.id}/send`, "staff", {});
    expect(sending.status).toBe(200);
    const sent = K.DocumentDetail.parse(sending.data);
    expect(sent.content?.dembrane_signature).toEqual({
      name: "Jamie Voorbeeld",
      role: "Sales",
      email: "jamie@dembrane.com",
      signed_at: sentAt,
    });
    expect(sent.body).toContain("### For dembrane B.V.\nName: Jamie Voorbeeld\nRole: Sales\n");
    const [ours] = await store.signaturesOf(w.db, doc.id);
    expect(ours).toMatchObject({
      slot: "dembrane",
      method: "presigned",
      typedName: "Jamie Voorbeeld",
      email: "jamie@dembrane.com",
      signerUserId: null,
    });
    const dpa = (await store.documents(w.db, orgId)).find((x) => x.kind === "dpa");
    const dpaSigs = await store.signaturesOf(w.db, dpa?.id as string);
    expect(dpaSigs.map((s) => [s.typedName, s.typedRole, s.email])).toEqual([
      ["Jamie Voorbeeld", "Sales", "jamie@dembrane.com"],
    ]);
    expect(dpaSigs[0]?.signedAt.toISOString()).toBe(sentAt);
  });

  test("an offer signed only by dembrane can still be revised or withdrawn", async () => {
    signatory(configured);
    const doc = await draft();
    await send(doc.id);
    const revision = await call(
      w,
      "POST",
      `${S()}/offers`,
      "staff",
      offer({ supersedes_id: doc.id }),
    );
    expect(revision.status).toBe(201);
    const next = K.PushOfferResponse.parse(revision.data).document;
    expect(next.content?.dembrane_signature?.name).toBe("Robin Signatory");
    expect((await store.document(w.db, w.orgId, doc.id))?.status).toBe("void");
    const voided = await call(w, "POST", `${S()}/documents/${next.id}/void`, "staff", {
      reason: null,
    });
    expect(voided.status).toBe(200);
    expect(K.DocumentDetail.parse(voided.data).status).toBe("void");
  });

  test("an offer that asked for dembrane's counter-signature has it at sending; nobody counter-signs", async () => {
    signatory(configured);
    const doc = await draft({
      second_signer: {
        kind: "dembrane",
        name: "Jordan Staff",
        email: "staff@dembrane.com",
        role: "Co-founder",
      },
    });
    // The draft still shows the blanks a counter-signature would fill.
    expect(doc.fields.some((f) => f.signer_role === "dembrane")).toBe(true);
    const sent = await send(doc.id);
    expect(sent.fields.some((f) => f.signer_role === "dembrane")).toBe(false);
    expect(sent.body).toContain("### For dembrane B.V.\nName: Robin Signatory");
    expect(sent.body?.match(/### For dembrane B\.V\./g)).toHaveLength(1);
    expect(sent.awaiting_signatures).toEqual(["customer"]);
    const countersign = await call(w, "POST", `${S()}/documents/${doc.id}/countersign`, "staff", {
      signature: { png_base64: pngB64(), method: "drawn" },
    });
    expect(countersign.status).toBe(409);
    expect((await sign(doc.id, "admin", "Anna de Vries")).res.status).toBe(200);
    const after = await staffView(doc.id);
    expect(after.status).toBe("signed");
    expect(after.signatures.map((s) => s.slot)).toEqual(["dembrane", "customer"]);
  });

  test("an offer accepted outside dembrane and an offer of no charge are completed by the customer alone", async () => {
    signatory(configured);
    const outside = await draft();
    await send(outside.id);
    const letter = await PDFDocument.create();
    letter.addPage([595, 842]).drawText("Opdracht", { x: 50, y: 780 });
    const accepted = await call(
      w,
      "POST",
      `${S()}/documents/${outside.id}/accepted-outside`,
      "staff",
      {
        via: "order_letter",
        name: "Marieke Jansen",
        email: "m.jansen@testdorp.example",
        accepted_on: w.clock.now.toISOString().slice(0, 10),
        evidence_name: "letter.pdf",
        evidence_base64: Buffer.from(await letter.save()).toString("base64"),
      },
    );
    expect(accepted.status).toBe(200);
    const done = K.DocumentDetail.parse(accepted.data);
    expect(done.status).toBe("signed");
    expect(done.signatures.map((s) => s.slot)).toEqual(["dembrane", "customer"]);

    const free = await call(
      w,
      "POST",
      `${S()}/offers`,
      "staff",
      offer({
        no_charge: true,
        items: [{ description: "Pilot", quantity: 1, unit_price_cents: 0, vat_rate_bps: 2100 }],
      }),
    );
    expect(free.status).toBe(201);
    const freeDoc = K.PushOfferResponse.parse(free.data).document;
    expect(freeDoc.content?.dembrane_signature?.name).toBe("Robin Signatory");
    expect((await sign(freeDoc.id, "admin", "Anna de Vries")).res.status).toBe(200);
    expect((await store.document(w.db, w.orgId, freeDoc.id))?.status).toBe("signed");
    expect(requested(freeDoc.id)).toEqual([]);
  });

  test("without a name configured, the name is read from the signatory's account", async () => {
    await w.db
      .update(schema.app_user)
      .set({ display_name: "Robin From Account" })
      .where(eq(schema.app_user.id, w.people.staff.appUserId as string));
    signatory({ email: "Staff@dembrane.com", name: null, role: null });
    const r = await call(w, "POST", `${S()}/offers`, "staff", offer());
    expect(r.status).toBe(201);
    const doc = K.PushOfferResponse.parse(r.data).document;
    expect(doc.content?.dembrane_signature).toMatchObject({
      name: "Robin From Account",
      role: null,
      email: "staff@dembrane.com",
    });
    // With no account to read it from either, nothing is signed.
    signatory({ email: "nobody@dembrane.com", name: null, role: null });
    const none = K.PushOfferResponse.parse(
      (await call(w, "POST", `${S()}/offers`, "staff", offer())).data,
    ).document;
    expect(none.content?.dembrane_signature).toBeUndefined();
    expect(await store.signaturesOf(w.db, none.id)).toEqual([]);
  });

  test("without a signatory, an offer goes out and is signed as before", async () => {
    signatory(null);
    const doc = await draft();
    const sent = await send(doc.id);
    expect(sent.content?.dembrane_signature).toBeUndefined();
    expect(sent.body).not.toContain("Signed electronically");
    expect(sent.signatures).toEqual([]);
    expect(sent.awaiting_signatures).toEqual(["customer"]);
    expect((await sign(doc.id, "admin", "Anna de Vries")).res.status).toBe(200);
    const after = await staffView(doc.id);
    expect([after.status, after.signatures.map((s) => s.slot)]).toEqual(["signed", ["customer"]]);
  });
});
