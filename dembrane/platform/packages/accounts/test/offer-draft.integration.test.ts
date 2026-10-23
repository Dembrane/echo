import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { emailHandler, sendEmail } from "@dembrane/account";
import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { MemoryMailer } from "@dembrane/mail";
import { deliverSamMessage } from "@dembrane/webhooks";
import { eq, sql } from "drizzle-orm";
import * as K from "../src/contract";
import type { AccountsDeps } from "../src/deps";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, pngB64, silent, type World, world } from "./helpers";

// An offer as a draft: staff make it, read it, change it and send it; the customer's
// account shows nothing of it until it is sent, and then the people who run the account
// get one email. Then the invoice request: one message when the signed offer, complete
// billing details and, where it is a document of its own, the signed DPA all exist.
const run = admin ? describe : describe.skip;
const DB = `accounts_draft_${process.pid}`;

run("an offer draft, and the invoice request after the signature", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = (org = w.orgId) => `/api/v2/orgs/${org}/account`;
  const S = (org = w.orgId) => `/api/v2/admin/accounts/${org}`;

  const offer = (over: Record<string, unknown> = {}) => ({
    template: "subscription",
    language: "en",
    offer_name: "Gemeente Testdorp",
    person_name: "Anna",
    reference: "OFFER-900",
    external_ref: "deal-900",
    items: [{ description: "Licence", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 }],
    ...over,
  });

  const billing = {
    legal_name: "Gemeente Testdorp",
    billing_email: "Finance@Testdorp.example",
    address_line1: "Dorpsstraat 1",
    postal_code: "1234 AB",
    city: "Testdorp",
    country: "Netherlands",
    vat_id: "NL001234567B01",
    po_number: "PO-77",
  };

  const draft = async (org = w.orgId, over: Record<string, unknown> = {}) =>
    K.PushOfferResponse.parse(
      (await call(w, "POST", `${S(org)}/offers`, "staff", offer({ send: false, ...over }))).data,
    ).document;

  const send = async (docId: string, org = w.orgId, body: Record<string, unknown> = {}) =>
    K.DocumentDetail.parse(
      (await call(w, "POST", `${S(org)}/documents/${docId}/send`, "staff", body)).data,
    );

  /** Signs as the organisation's admin, filling every field but the optional reference. */
  async function sign(
    docId: string,
    as: keyof World["people"] = "admin",
    org = w.orgId,
    dpaAuthorised = true,
    reference?: string,
  ) {
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C(org)}/documents/${docId}`, as)).data,
    );
    const values: Record<string, string | boolean> = {};
    for (const f of detail.fields) {
      if (f.kind === "name") values[f.id] = "Anna de Vries";
      else if (f.kind === "role") values[f.id] = "Wethouder";
      else if (f.kind === "date")
        values[f.id] = w.clock.now.toISOString().slice(0, 10).split("-").reverse().join("-");
      else if (f.kind === "checkbox") values[f.id] = true;
      else if (f.kind === "text" && f.key === "po_number") {
        if (reference !== undefined) values[f.id] = reference;
      } else if (f.kind === "text") values[f.id] = f.key === "organisation" ? "Testdorp" : "n/a";
    }
    const confirmation_text = (
      (dpaAuthorised
        ? detail.confirmation?.dpa_authorised
        : detail.confirmation?.dpa_not_authorised) ?? ""
    )
      .replace("{name}", "Anna de Vries")
      .replace("{role}", "Wethouder")
      .replace("{organisation}", "Testdorp");
    return call(w, "POST", `${C(org)}/documents/${docId}/sign`, as, {
      sha256: detail.sha256,
      values,
      signature: { png_base64: pngB64(), method: "drawn" },
      initials: null,
      dpa_authorised: dpaAuthorised,
      confirmation_text,
    });
  }

  /** The messages for sam's inbox with `code`, newest last; needs the inbox switched on. */
  const inbox = (code: string) =>
    w.jobs
      .of(deliverSamMessage.name)
      .filter((m) => m.code === code)
      .map((m) => (JSON.parse(m.body as string) as { json: Record<string, unknown> }).json);

  type OfferEmail = {
    to: string;
    subject: string;
    language: string;
    template: string;
    data: { org_name: string; document_title: string; sign_url: string };
  };
  /** The emails queued about one offer, by the address they go to. */
  const offerEmails = (docId: string, org = w.orgId) =>
    (w.jobs.of(sendEmail.name) as OfferEmail[])
      .filter(
        (m) =>
          m.template === "account_offer_sent" &&
          m.data.sign_url === `https://dash.test/o/${org}/account/documents/${docId}/sign`,
      )
      .sort((x, y) => x.to.localeCompare(y.to));

  const setLanguage = (who: keyof World["people"], language: string | null) =>
    w.db
      .update(schema.directus_users)
      .set({ language })
      .where(eq(schema.directus_users.id, w.people[who].directusUserId));

  const withInbox = () => {
    (w.deps as { settings: AccountsDeps["settings"] }).settings = {
      ...w.deps.settings,
      samInbox: true,
    };
  };

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    withInbox();
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("a reverse-charged offer takes only 0% lines, and its text says why there is no VAT", async () => {
    const zero = [
      { description: "Licence", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 0 },
    ];
    const refused = await call(
      w,
      "POST",
      `${S()}/offers`,
      "staff",
      offer({ send: false, vat_treatment: "reverse_charge", reference: "OFFER-RC1" }),
    );
    expect(refused.status).toBe(422);
    const doc = await draft(w.orgId, {
      vat_treatment: "reverse_charge",
      items: zero,
      reference: "OFFER-RC2",
      language: "nl",
    });
    const [row] = await w.db
      .select({ body: schema.account_document.body })
      .from(schema.account_document)
      .where(eq(schema.account_document.id, doc.id));
    expect(row?.body).toContain("Btw verlegd");
  });

  test("a draft adds nothing to the customer's account", async () => {
    const doc = await draft();
    expect(doc.status).toBe("draft");
    const page = K.AccountPage.parse((await call(w, "GET", C(), "admin")).data);
    expect(page.documents).toEqual([]);
    expect(page.tasks).toEqual([]);
    expect(await store.tasks(w.db, w.orgId)).toEqual([]);
    // No email, and nothing for sam: a draft is staff's own.
    expect(w.jobs.of(sendEmail.name)).toEqual([]);
    expect(inbox("echo_account_document_sent_v1")).toEqual([]);
  });

  test("only staff open a draft: the customer's admin, a member, another organisation and a visitor are refused", async () => {
    const doc = await draft();
    const staffPaths = [
      `${S()}/documents/${doc.id}`,
      `${S()}/documents/${doc.id}/file`,
      `${S()}/documents/${doc.id}/fields`,
    ];
    for (const path of staffPaths) {
      expect((await call(w, "GET", path, "staff")).status).toBe(200);
      for (const who of ["admin", "billing", "member", "outsider", "signer"] as const)
        expect((await call(w, "GET", path, who)).status).toBe(403);
      expect((await call(w, "GET", path, null)).status).toBe(401);
    }
    // Through the customer's own routes the draft does not exist.
    for (const path of [`${C()}/documents/${doc.id}`, `${C()}/documents/${doc.id}/file`]) {
      for (const who of ["admin", "billing"] as const)
        expect((await call(w, "GET", path, who)).status).toBe(404);
      expect((await call(w, "GET", path, "member")).status).toBe(403);
      expect((await call(w, "GET", path, "outsider")).status).toBe(404);
    }
    expect((await call(w, "POST", `${C()}/documents/${doc.id}/view`, "admin")).status).toBe(404);
    // The staff reader names the page staff open; the customer's reader never does.
    const read = K.DocumentDetail.parse(
      (await call(w, "GET", `${S()}/documents/${doc.id}`, "staff")).data,
    );
    expect(read.staff_url).toBe(`https://dash.test/admin/accounts/${w.orgId}/documents/${doc.id}`);
    expect(read.access).toBe("staff");
  });

  test("staff change a draft in place: same document, reference and page, new content", async () => {
    const doc = await draft();
    const path = `${S()}/offers/${doc.id}`;
    const changed = offer({
      language: "nl",
      offer_name: "Testdorp",
      person_name: "Bram",
      reference: null,
      external_ref: null,
      items: [
        { description: "Licentie", quantity: 6, unit_price_cents: 8600, vat_rate_bps: 2100 },
        { description: "Workshop", quantity: 1, unit_price_cents: 125000, vat_rate_bps: 2100 },
      ],
    });
    for (const who of ["admin", "billing", "member", "outsider"] as const)
      expect((await call(w, "PUT", path, who, changed)).status).toBe(403);
    expect((await call(w, "PUT", path, null, changed)).status).toBe(401);
    expect((await call(w, "PUT", path, "staff", { ...changed, items: [] })).status).toBe(422);

    const r = await call(w, "PUT", path, "staff", changed);
    expect(r.status).toBe(200);
    const after = K.DocumentDetail.parse(r.data);
    expect(after.id).toBe(doc.id);
    expect(after.status).toBe("draft");
    expect(after.staff_url).toBe(doc.staff_url);
    // What was not given stays: the reference and the deal it belongs to.
    expect(after.reference).toBe("OFFER-900");
    expect((await store.document(w.db, w.orgId, doc.id))?.externalRef).toBe("deal-900");
    expect(after.title).toBe("Offerte jaarlicentie OFFER-900");
    expect(after.language).toBe("nl");
    expect(after.content?.person_name).toBe("Bram");
    expect(after.subtotal_cents).toBe(6 * 8600 + 125000);
    expect(after.total_cents).toBe(Math.round((6 * 8600 + 125000) * 1.21));
    expect(after.sha256).not.toBe(doc.sha256);
    // The stored PDF is the new one.
    const file = await call(w, "GET", `${S()}/documents/${doc.id}/file`, "staff");
    const { createHash } = await import("node:crypto");
    expect(
      createHash("sha256")
        .update(file.data as Uint8Array)
        .digest("hex"),
    ).toBe(after.sha256 as string);
    // Still nothing on the customer's side.
    expect(K.AccountPage.parse((await call(w, "GET", C(), "admin")).data).documents).toEqual([]);
    const types = (await store.events(w.db, w.orgId)).map((e) => e.type);
    expect(types).toContain("document.updated");

    // Another organisation's id does not reach it, and a sent offer is fixed.
    expect(
      (await call(w, "PUT", `${S(w.otherOrgId)}/offers/${doc.id}`, "staff", changed)).status,
    ).toBe(404);
    await send(doc.id);
    expect((await call(w, "PUT", path, "staff", changed)).status).toBe(409);
  });

  test("sending a draft: the customer gets the offer and its tasks, the offer carries the day it is sent, and sam is told", async () => {
    const org = w.otherOrgId;
    const doc = await draft(org, { reference: "OFFER-901", external_ref: "deal-901" });
    expect(doc.content?.date).toBe("2026-09-28");
    expect(await store.tasks(w.db, org)).toEqual([]);

    // Reviewed for three days, then sent.
    w.clock.now = new Date("2026-10-01T10:00:00.000Z");
    const sent = await send(doc.id, org);
    expect(sent.status).toBe("sent");
    expect(sent.content?.date).toBe("2026-10-01");
    expect(sent.valid_until).toBe("2026-10-15");
    expect(sent.reference).toBe("OFFER-901");
    expect(sent.sha256).not.toBe(doc.sha256);

    const page = K.AccountPage.parse((await call(w, "GET", C(org), "outsider")).data);
    // The DPA goes out with the offer, as its own document to sign.
    expect(page.documents.map((d) => [d.kind, d.status]).sort()).toEqual([
      ["dpa", "sent"],
      ["offer", "sent"],
    ]);
    expect(page.documents.find((d) => d.kind === "offer")?.id).toBe(doc.id);
    expect(page.tasks.map((t) => `${t.code}:${t.status}`).sort()).toEqual([
      "billing_details:locked",
      "sign_dpa:open",
      "sign_offer:open",
      "who_signs:open",
    ]);

    const [message] = inbox("echo_account_document_sent_v1").filter(
      (m) => (m.document as { id: string }).id === doc.id,
    );
    expect(message).toMatchObject({
      event: "account.document.sent",
      org: { id: org, name: "Elders BV" },
      document: { id: doc.id, kind: "offer", reference: "OFFER-901", external_ref: "deal-901" },
      sent_by: "staff@example.test",
      links: {
        document: `https://dash.test/admin/accounts/${org}/documents/${doc.id}`,
        customer: `https://dash.test/o/${org}/account/documents/${doc.id}/sign`,
      },
    });
    // No email leaves: the answer carries the two links the deal owner sends themselves.
    expect(offerEmails(doc.id, org)).toEqual([]);
    expect(doc.customer_links).toBeNull();
    expect(sent.customer_links).toEqual({
      sign_in: `https://dash.test/login?next=${encodeURIComponent(`/o/${org}/account`)}`,
      document: `https://dash.test/o/${org}/account/documents/${doc.id}/sign`,
    });
    // The customer's own read of it carries neither staff link.
    const mine = K.DocumentDetail.parse(
      (await call(w, "GET", `${C(org)}/documents/${doc.id}`, "outsider")).data,
    );
    expect(mine.customer_links).toBeNull();

    // A date set in the future stays.
    const later = await draft(org, { reference: "OFFER-902", date: "2026-11-01" });
    expect((await send(later.id, org)).content?.date).toBe("2026-11-01");
  });

  test("withdrawing a draft or a sent offer tells sam which it was", async () => {
    const org = w.otherOrgId;
    const doc = await draft(org, { reference: "OFFER-903", external_ref: "deal-903" });
    const path = `${S(org)}/documents/${doc.id}/void`;
    expect((await call(w, "POST", path, "outsider", {})).status).toBe(403);
    expect((await call(w, "POST", path, "staff", { reason: "wrong price" })).status).toBe(200);
    const [message] = inbox("echo_account_document_voided_v1").filter(
      (m) => (m.document as { id: string }).id === doc.id,
    );
    expect(message).toMatchObject({
      event: "account.document.voided",
      document: { reference: "OFFER-903", external_ref: "deal-903" },
      was: "draft",
      reason: "wrong price",
      voided_by: "staff@example.test",
    });
  });

  test("the invoice is requested once, when the signed offer, its DPA and the billing details all exist", async () => {
    const org = w.otherOrgId;
    const requested = () => inbox("echo_account_invoice_requested_v1");
    const before = requested().length;
    // The offer of the test above (OFFER-901) is sent and waits for a signature.
    const [open] = (await store.documents(w.db, org)).filter(
      (d) => d.reference === "OFFER-901" && d.status === "sent",
    );
    const docId = open?.id as string;
    expect((await sign(docId, "outsider", org)).status).toBe(200);
    // Signed, but nobody knows yet who to invoice.
    expect(requested()).toHaveLength(before);

    expect((await call(w, "PUT", `${C(org)}/billing`, "outsider", billing)).status).toBe(200);
    // The DPA went out with the offer as a document of its own, and is not signed yet.
    expect(requested()).toHaveLength(before);
    const dpa = (await store.documents(w.db, org)).find((d) => d.kind === "dpa");
    expect((await sign(dpa?.id as string, "outsider", org)).status).toBe(200);
    expect(requested()).toHaveLength(before + 1);
    const message = requested().at(-1) as Record<string, unknown>;
    expect(message).toMatchObject({
      event: "account.invoice.requested",
      org: { id: org, name: "Elders BV", account_stage: "customer" },
      document: {
        id: docId,
        reference: "OFFER-901",
        external_ref: "deal-901",
        currency: "EUR",
        subtotal_cents: 12 * 8600,
        total_cents: Math.round(12 * 8600 * 1.21),
      },
      signature: {
        name: "Anna de Vries",
        role: "Wethouder",
        email: "outsider@example.test",
        signed_pdf: `/api/v2/admin/accounts/${org}/documents/${docId}/signed.pdf`,
      },
      billing: {
        legal_name: "Gemeente Testdorp",
        billing_email: "finance@testdorp.example",
        vat_id: "NL001234567B01",
        po_number: "PO-77",
        // What the invoice's tax and delivery are decided from, beside the fields sam knew.
        no_vat_number: false,
        invoice_delivery: "email",
        invoice_portal: null,
        address: {
          line1: "Dorpsstraat 1",
          postal_code: "1234 AB",
          city: "Testdorp",
          country: "Netherlands",
          country_code: "NL",
        },
      },
      invoice: { vat_treatment: "standard", po_number: "PO-77", bill_to: false },
      links: {
        account: `https://dash.test/admin/accounts/${org}`,
        document: `https://dash.test/admin/accounts/${org}/documents/${docId}`,
        mirror: `/api/v2/admin/accounts/${org}/invoices/:exactId`,
      },
      account_manager: null,
    });
    const invoice = message.invoice as { items: { description: string; quantity: number }[] };
    expect(invoice.items.map((x) => x.quantity)).toEqual([12]);
    expect((message.document as { lines: unknown[] }).lines).toHaveLength(1);

    // Saving the details again asks nothing new.
    expect(
      (await call(w, "PUT", `${C(org)}/billing`, "outsider", { ...billing, po_number: "PO-78" }))
        .status,
    ).toBe(200);
    expect(requested()).toHaveLength(before + 1);
    expect(
      (await store.events(w.db, org)).filter((e) => e.type === "invoice.requested"),
    ).toHaveLength(1);
  });

  test("a returning customer with details on file: the request goes out with the signature; an offer of zero asks nothing", async () => {
    const org = w.otherOrgId;
    const requested = () => inbox("echo_account_invoice_requested_v1");
    const before = requested().length;
    const second = await draft(org, { reference: "OFFER-904" });
    await send(second.id, org);
    expect((await sign(second.id, "outsider", org)).status).toBe(200);
    expect(requested()).toHaveLength(before + 1);
    expect(requested().at(-1)).toMatchObject({ document: { reference: "OFFER-904" } });

    // An offer without amounts is never drafted, so there is nothing to sign or invoice.
    const free = await call(
      w,
      "POST",
      `${S(org)}/offers`,
      "staff",
      offer({
        send: false,
        reference: "OFFER-905",
        items: [{ description: "Pilot", quantity: 1, unit_price_cents: 0, vat_rate_bps: 2100 }],
      }),
    );
    expect(free.status).toBe(422);
    expect(JSON.stringify(free.data)).toContain("give a price");
    expect(requested()).toHaveLength(before + 1);
  });

  test("only a custom offer carries amendments", async () => {
    const amendments = [{ title: "Liability cap", body: "dembrane is liable up to €30,000." }];
    const refused = await call(
      w,
      "POST",
      `${S()}/offers`,
      "staff",
      offer({ send: false, reference: "OFFER-AM1", amendments }),
    );
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.data)).toContain("Only a custom offer");
    const doc = await draft(w.orgId, { template: "custom", reference: "OFFER-AM2", amendments });
    expect(doc.content?.amendments).toEqual(amendments);
    expect(doc.body).toContain("Amendment 1: Liability cap, as set out in this offer.");
  });

  test("an offer is not drafted or changed without amounts", async () => {
    const lines = (...prices: number[]) =>
      prices.map((p, i) => ({
        description: `Line ${i + 1}`,
        quantity: 1,
        unit_price_cents: p,
        vat_rate_bps: 2100,
      }));
    const push = (items: unknown, reference: string) =>
      call(w, "POST", `${S()}/offers`, "staff", offer({ send: true, reference, items }));
    const unpriced = await push(lines(10000, 0), "OFFER-A1");
    expect(unpriced.status).toBe(422);
    expect(JSON.stringify(unpriced.data)).toContain("give a price");
    const zero = await push(lines(10000, -10000), "OFFER-A2");
    expect(zero.status).toBe(422);
    expect(JSON.stringify(zero.data)).toContain("more than zero");
    // A discount is still an amount.
    expect((await push(lines(10000, -2500), "OFFER-A3")).status).toBe(201);
    // A draft cannot be changed into one without amounts either.
    const doc = await draft(w.orgId, { reference: "OFFER-A4" });
    const changed = offer({ reference: null, external_ref: null, items: lines(0) });
    const r = await call(w, "PUT", `${S()}/offers/${doc.id}`, "staff", changed);
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.data)).toContain("give a price");
  });

  test("where sam does not take the offer flow's messages yet, none is made and no request is recorded", async () => {
    const org = w.otherOrgId;
    const settings = w.deps.settings;
    (w.deps as { settings: AccountsDeps["settings"] }).settings = {
      ...settings,
      offerMessages: false,
    };
    try {
      const count = () => w.jobs.of(deliverSamMessage.name).length;
      const before = count();
      const doc = await draft(org, { reference: "OFFER-907" });
      await send(doc.id, org);
      expect((await sign(doc.id, "outsider", org)).status).toBe(200);
      // The signature is told as before; the sent notice and the invoice request are not.
      const made = w.jobs.of(deliverSamMessage.name).slice(before);
      expect(made.map((m) => m.code)).toEqual(["echo_account_document_signed_v1"]);
      expect(
        (await store.events(w.db, org)).filter(
          (e) => e.type === "invoice.requested" && e.subjectId === doc.id,
        ),
      ).toEqual([]);
      // The timeline still says it was sent.
      expect((await store.events(w.db, org)).map((e) => e.type)).toContain("document.sent");
    } finally {
      (w.deps as { settings: AccountsDeps["settings"] }).settings = settings;
    }
    // Switched on, the next billing save asks for the offer that was waiting.
    const requested = () => inbox("echo_account_invoice_requested_v1");
    const before = requested().length;
    expect(
      (await call(w, "PUT", `${C(org)}/billing`, "outsider", { ...billing, po_number: "PO-79" }))
        .status,
    ).toBe(200);
    expect(requested()).toHaveLength(before + 1);
    expect(requested().at(-1)).toMatchObject({ document: { reference: "OFFER-907" } });
  });

  test("an organisation whose only document is a draft is not listed as an account for its people", async () => {
    const { newId } = await import("@dembrane/core");
    const fresh = newId();
    await w.db.insert(schema.org).values({ id: fresh, name: "Nieuw BV" });
    await w.db.insert(schema.org_membership).values({
      id: newId(),
      org_id: fresh,
      user_id: w.people.signer.appUserId as string,
      role: "owner",
    });
    const doc = await draft(fresh, { reference: "OFFER-906" });
    const summary = async () =>
      K.TasksSummary.parse((await call(w, "GET", "/api/v2/account/tasks-summary", "signer")).data);
    expect(await summary()).toEqual([]);
    await send(doc.id, fresh);
    expect((await summary()).map((s) => s.name)).toEqual(["Nieuw BV"]);
    const [row] = await w.db.select().from(schema.org).where(eq(schema.org.id, fresh));
    expect(row?.account_stage ?? null).toBeNull();
  });

  test("sending an offer with notify queues one email to each person who runs the account, with the link where it is signed", async () => {
    w.clock.now = new Date("2026-10-02T09:00:00.000Z");
    const pushed = K.PushOfferResponse.parse(
      (
        await call(
          w,
          "POST",
          `${S()}/offers`,
          "staff",
          offer({ reference: "OFFER-910", notify: true }),
        )
      ).data,
    ).document;
    expect(pushed.status).toBe("sent");
    const link = `https://dash.test/o/${w.orgId}/account/documents/${pushed.id}/sign`;
    // The admin and the billing member; a plain member does not run the account.
    expect(offerEmails(pushed.id)).toEqual([
      {
        to: "admin@example.test",
        subject: "Your offer from dembrane is ready to sign",
        language: "en-US",
        template: "account_offer_sent",
        data: {
          org_name: "Gemeente Testdorp",
          document_title: "Yearly license offer OFFER-910",
          sign_url: link,
          reference: "OFFER-910",
          total_cents: "124872",
          currency: "EUR",
          valid_until: "2026-10-16",
        },
        context: `account offer sent ${pushed.id}`,
      },
      expect.objectContaining({ to: "billing@example.test", language: "en-US" }),
    ] as unknown as OfferEmail[]);

    // The worker's handler turns the job into the message the mailer sends.
    const mailer = new MemoryMailer();
    for (const job of offerEmails(pushed.id)) await emailHandler(mailer, silent)(job as never);
    expect(mailer.sent.map((m) => m.to)).toEqual(["admin@example.test", "billing@example.test"]);
    expect(mailer.sent[0]).toMatchObject({
      subject: "Your offer from dembrane is ready to sign",
      tags: ["account_offer_sent"],
    });
    expect(mailer.sent[0]?.text).toContain("We've prepared an offer for Gemeente Testdorp.");
    expect(mailer.sent[0]?.text).toContain("Total incl. VAT: €1,248.72");
    expect(mailer.sent[0]?.text).toContain(link);
    expect(mailer.sent[0]?.html).toContain(`href="${link}"`);
  });

  test("the offer email is worded in each person's language, else in the organisation's", async () => {
    // The admin reads German; the billing member has no setting and gets the language of
    // the organisation's newest document, this Dutch offer.
    await setLanguage("admin", "de-DE");
    try {
      const pushed = K.PushOfferResponse.parse(
        (
          await call(
            w,
            "POST",
            `${S()}/offers`,
            "staff",
            offer({ reference: "OFFER-911", language: "nl", notify: true }),
          )
        ).data,
      ).document;
      // The job names the language; the words come from the worker, which has the catalogs.
      expect(offerEmails(pushed.id).map((m) => [m.to, m.language, m.subject])).toEqual([
        ["admin@example.test", "de-DE", "Your offer from dembrane is ready to sign"],
        ["billing@example.test", "nl-NL", "Your offer from dembrane is ready to sign"],
      ]);
      const mailer = new MemoryMailer();
      for (const job of offerEmails(pushed.id)) await emailHandler(mailer, silent)(job as never);
      expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
        ["admin@example.test", "Ihr Angebot von dembrane liegt zur Unterzeichnung bereit"],
        ["billing@example.test", "Je offerte van dembrane staat klaar om te ondertekenen"],
      ]);
      expect(mailer.sent[1]?.text).toContain(
        "We hebben een offerte voor Gemeente Testdorp klaargezet.",
      );
      expect(mailer.sent[1]?.text).toContain("Geldig tot: 16 oktober 2026");
    } finally {
      await setLanguage("admin", null);
    }
  });

  test("a draft queues no email, nor does sending it; with notify the send queues one for each person, once", async () => {
    const before = w.jobs.of(sendEmail.name).length;
    const doc = await draft(w.orgId, { reference: "OFFER-912" });
    expect(w.jobs.of(sendEmail.name)).toHaveLength(before);

    const quiet = await draft(w.orgId, { reference: "OFFER-913" });
    await send(quiet.id);
    expect(w.jobs.of(sendEmail.name)).toHaveLength(before);

    await send(doc.id, w.orgId, { notify: true });
    expect(offerEmails(doc.id).map((m) => m.to)).toEqual([
      "admin@example.test",
      "billing@example.test",
    ]);
    expect(w.jobs.of(sendEmail.name)).toHaveLength(before + 2);
    // One run for the offer and the person, so the queue takes it once.
    expect(
      w.jobs.jobs
        .filter((j) => j.workflowId?.startsWith(`accounts.offer-sent:${doc.id}:`))
        .map((j) => j.workflowId)
        .sort(),
    ).toEqual(
      [w.people.admin.appUserId, w.people.billing.appUserId]
        .map((id) => `accounts.offer-sent:${doc.id}:${id}`)
        .sort(),
    );

    // A sent offer is not sent again.
    expect((await call(w, "POST", `${S()}/documents/${doc.id}/send`, "staff", {})).status).toBe(
      409,
    );
    expect(w.jobs.of(sendEmail.name)).toHaveLength(before + 2);
  });

  test("a document that is not an offer queues no email, sent at once or later", async () => {
    const before = w.jobs.of(sendEmail.name).length;
    const plan = K.PushDocumentResponse.parse(
      (
        await call(w, "POST", `${S()}/documents`, "staff", {
          kind: "other",
          title: "Werkplan workshop",
          body: "# Werkplan\n\nWe beginnen om 9 uur.",
          requires_signature: true,
          task: { title: "Teken het werkplan" },
        })
      ).data,
    ).document;
    expect(plan.status).toBe("sent");

    const note = K.PushDocumentResponse.parse(
      (
        await call(w, "POST", `${S()}/documents`, "staff", {
          kind: "other",
          title: "Agenda",
          body: "# Agenda\n\nWelkom.",
          send: false,
        })
      ).data,
    ).document;
    expect(note.status).toBe("draft");
    expect((await send(note.id)).status).toBe("sent");

    expect(w.jobs.of(sendEmail.name)).toHaveLength(before);
  });

  test("an account nobody runs yet gets the offer and no email", async () => {
    const { newId } = await import("@dembrane/core");
    const empty = newId();
    await w.db.insert(schema.org).values({ id: empty, name: "Leeg BV" });
    const before = w.jobs.of(sendEmail.name).length;
    const doc = await draft(empty, { reference: "OFFER-913" });
    expect((await send(doc.id, empty)).status).toBe("sent");
    expect(w.jobs.of(sendEmail.name)).toHaveLength(before);
  });

  /** A new organisation that the outsider runs, with nothing on it yet. */
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
  const requestedFor = (org: string) =>
    inbox("echo_account_invoice_requested_v1").filter((m) => (m.org as { id: string }).id === org);
  /** What the timeline said the offer waited for, oldest first. */
  const waited = async (org: string) =>
    (await store.events(w.db, org))
      .filter((e) => e.type === "invoice.waiting")
      .reverse()
      .map((e) => (e.detail as { waits_for: string[] }).waits_for.join(" and "));
  const cardWaits = async (org: string) =>
    K.AccountCard.parse((await call(w, "GET", S(org), "staff")).data).invoice_waits;

  test("the offer's signature, the DPA's and the billing details in every order: the request goes with the last, once", async () => {
    // O the offer is signed, D its DPA is signed, B the billing details are saved.
    const said: Record<string, string[]> = {
      OBD: ["billing_details and dpa", "dpa"],
      ODB: ["billing_details and dpa", "billing_details"],
      BOD: ["dpa"],
      DOB: ["billing_details"],
      BDO: [],
      DBO: [],
    };
    for (const [order, timeline] of Object.entries(said)) {
      const org = await freshOrg(`Voorbeeld ${order} BV`);
      const doc = await draft(org, { reference: `OFFER-${order}`, external_ref: null });
      await send(doc.id, org);
      const dpa = (await store.documents(w.db, org)).find((d) => d.kind === "dpa");
      const step = {
        O: () => sign(doc.id, "outsider", org),
        D: () => sign(dpa?.id as string, "outsider", org),
        B: () => call(w, "PUT", `${C(org)}/billing`, "outsider", billing),
      };
      for (const [i, s] of [...order].entries()) {
        expect((await step[s as "O" | "D" | "B"]()).status).toBe(200);
        expect(requestedFor(org)).toHaveLength(i === 2 ? 1 : 0);
        // The staff card names what a signed offer still waits for, and nothing else.
        const done = order.slice(0, i + 1);
        const waits: K.AccountCardT["invoice_waits"][number]["waits_for"] = [
          ...(done.includes("B") ? [] : (["billing_details"] as const)),
          ...(done.includes("D") ? [] : (["dpa"] as const)),
        ];
        expect(await cardWaits(org)).toEqual(
          done.includes("O") && waits.length ? [{ document_id: doc.id, waits_for: waits }] : [],
        );
      }
      expect(requestedFor(org)[0]).toMatchObject({ document: { reference: `OFFER-${order}` } });
      expect(await waited(org)).toEqual(timeline);
      // Nothing asks a second time: not the details saved again, not another look.
      expect((await step.B()).status).toBe(200);
      expect(requestedFor(org)).toHaveLength(1);
      expect(await waited(org)).toEqual(timeline);
    }
  });

  test("an offer signed together with its DPA waits for the billing details only; a signer who may not agree to it makes the DPA its own document", async () => {
    /**
     * An offer from before the DPA was its own document: none went out with it. Such
     * offers exist only as sent, so this one is written past the freeze on sent documents.
     */
    const withDpa = async (org: string, reference: string) => {
      const doc = await draft(org, { reference, external_ref: null });
      await send(doc.id, org);
      const [row] = await w.db
        .select({ content: schema.account_document.content })
        .from(schema.account_document)
        .where(eq(schema.account_document.id, doc.id));
      const content = Object.fromEntries(
        Object.entries((row as { content: Record<string, unknown> }).content).filter(
          ([key]) => key !== "dpa_separate",
        ),
      );
      await w.db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx
          .update(schema.account_document)
          .set({ content })
          .where(eq(schema.account_document.id, doc.id));
      });
      for (const d of (await store.documents(w.db, org)).filter((x) => x.kind === "dpa")) {
        await w.db.delete(schema.account_task).where(eq(schema.account_task.documentId, d.id));
        await w.db.delete(schema.account_document).where(eq(schema.account_document.id, d.id));
      }
      return doc.id;
    };

    // The signer agrees to the DPA with the offer: two things, as before.
    const together = await freshOrg("Voorbeeld Samen BV");
    const first = await withDpa(together, "OFFER-SAMEN");
    expect((await sign(first, "outsider", together)).status).toBe(200);
    expect(await cardWaits(together)).toEqual([
      { document_id: first, waits_for: ["billing_details"] },
    ]);
    expect((await call(w, "PUT", `${C(together)}/billing`, "outsider", billing)).status).toBe(200);
    expect(requestedFor(together)).toHaveLength(1);
    expect((await store.documents(w.db, together)).filter((d) => d.kind === "dpa")).toEqual([]);
    expect(await waited(together)).toEqual(["billing_details"]);

    // The signer may not agree to it: the DPA goes out on its own, and the invoice waits for it.
    const apart = await freshOrg("Voorbeeld Apart BV");
    const second = await withDpa(apart, "OFFER-APART");
    expect((await call(w, "PUT", `${C(apart)}/billing`, "outsider", billing)).status).toBe(200);
    expect((await sign(second, "outsider", apart, false)).status).toBe(200);
    expect(requestedFor(apart)).toHaveLength(0);
    expect(await cardWaits(apart)).toEqual([{ document_id: second, waits_for: ["dpa"] }]);
    const dpa = (await store.documents(w.db, apart)).find((d) => d.kind === "dpa");
    expect((await sign(dpa?.id as string, "outsider", apart)).status).toBe(200);
    expect(requestedFor(apart)).toHaveLength(1);
    expect(await cardWaits(apart)).toEqual([]);
    expect(await waited(apart)).toEqual(["dpa"]);
  });

  test("a DPA written for the customer stands in for ours once it is signed", async () => {
    const org = await freshOrg("Voorbeeld Eigen BV");
    const doc = await draft(org, { reference: "OFFER-EIGEN", external_ref: null });
    await send(doc.id, org);
    expect((await call(w, "PUT", `${C(org)}/billing`, "outsider", billing)).status).toBe(200);
    expect((await sign(doc.id, "outsider", org)).status).toBe(200);
    expect(await cardWaits(org)).toEqual([{ document_id: doc.id, waits_for: ["dpa"] }]);
    // Ours is withdrawn and their own text is sent in its place.
    const ours = (await store.documents(w.db, org)).find((d) => d.kind === "dpa");
    expect(
      (await call(w, "POST", `${S(org)}/documents/${ours?.id}/void`, "staff", {})).status,
    ).toBe(200);
    const own = await call(w, "POST", `${S(org)}/documents`, "staff", {
      kind: "dpa",
      title: "Verwerkersovereenkomst Voorbeeld Eigen BV",
      language: "nl",
      body: "Artikel 1. Deze tekst is van de klant zelf.",
      requires_signature: true,
    });
    expect(own.status).toBe(201);
    expect(requestedFor(org)).toHaveLength(0);
    const theirs = (await store.documents(w.db, org)).find(
      (d) => d.kind === "dpa" && d.status === "sent",
    );
    expect((await sign(theirs?.id as string, "outsider", org)).status).toBe(200);
    expect(requestedFor(org)).toHaveLength(1);
    expect(await cardWaits(org)).toEqual([]);
  });

  test("with the customer's own processing terms the offer is all they sign: no DPA, no who-signs question, and the invoice waits for the billing details only", async () => {
    const org = await freshOrg("Gemeente Eigen BV");
    const own = "'GIBIT 2025 standaard' voor verwerking";
    const doc = await draft(org, {
      reference: "OFFER-OWN",
      external_ref: null,
      processing_terms: own,
    });
    expect(doc.content?.processing_terms).toBe(own);
    // A change that leaves the line out keeps it; null drops it.
    const S1 = `${S(org)}/offers/${doc.id}`;
    const kept = K.DocumentDetail.parse(
      (await call(w, "PUT", S1, "staff", offer({ reference: "OFFER-OWN", person_name: "Bo" })))
        .data,
    );
    expect(kept.content?.processing_terms).toBe(own);
    expect(kept.body).toContain(own);
    await send(doc.id, org);
    const docs = await store.documents(w.db, org);
    expect(docs.filter((d) => d.kind === "dpa")).toHaveLength(0);
    const codes = (await store.tasks(w.db, org)).map((t) => t.code);
    expect(codes).toContain("sign_offer");
    expect(codes).not.toContain("who_signs");
    expect((await sign(doc.id, "outsider", org)).status).toBe(200);
    expect(await cardWaits(org)).toEqual([{ document_id: doc.id, waits_for: ["billing_details"] }]);
    expect((await call(w, "PUT", `${C(org)}/billing`, "outsider", billing)).status).toBe(200);
    expect(requestedFor(org)).toHaveLength(1);

    const other = await freshOrg("Gemeente Zonder BV");
    const dropped = await draft(other, { reference: "OFFER-OWN2", processing_terms: own });
    const cleared = K.DocumentDetail.parse(
      (
        await call(w, "PUT", `${S(other)}/offers/${dropped.id}`, "staff", {
          ...offer({ reference: "OFFER-OWN2" }),
          processing_terms: null,
        })
      ).data,
    );
    expect(cleared.content?.processing_terms).toBeUndefined();
  });

  test("a staff change keeps a title of its own and the currency when they are not given", async () => {
    const doc = await draft(w.orgId, {
      reference: "OFFER-KEEP",
      title: "Pilot for Testdorp",
      currency: "USD",
    });
    expect(doc.title).toBe("Pilot for Testdorp");
    const path = `${S()}/offers/${doc.id}`;
    // offer() names no currency, so the change leaves it out.
    const noCurrency = offer({ reference: null, person_name: "Bo" });
    const kept = K.DocumentDetail.parse((await call(w, "PUT", path, "staff", noCurrency)).data);
    expect(kept.title).toBe("Pilot for Testdorp");
    expect(kept.currency).toBe("USD");
    expect(kept.content?.currency).toBe("USD");
    expect(kept.content?.person_name).toBe("Bo");
    // Given, they change; a generated title follows the new words.
    const plain = await draft(w.orgId, { reference: "OFFER-GEN" });
    expect(plain.title).toBe("Yearly license offer OFFER-GEN");
    const moved = K.DocumentDetail.parse(
      (
        await call(w, "PUT", `${S()}/offers/${plain.id}`, "staff", {
          ...offer({ reference: null, language: "nl" }),
          currency: "GBP",
        })
      ).data,
    );
    expect(moved.title).toBe("Offerte jaarlicentie OFFER-GEN");
    expect(moved.currency).toBe("GBP");
  });

  test("revising a sent offer: the new version replaces it under the same reference and title", async () => {
    const first = await draft(w.orgId, {
      template: "custom",
      reference: "OFFER-REV",
      title: "Pilot for Testdorp",
      vat_treatment: "reverse_charge",
      items: [
        {
          description: "Licence",
          quantity: 3,
          unit: "months",
          unit_price_cents: 40000,
          vat_rate_bps: 0,
        },
      ],
      amendments: [{ title: "Start", body: "The pilot starts on the first of the month." }],
    });
    await send(first.id);
    const revised = K.PushOfferResponse.parse(
      (
        await call(w, "POST", `${S()}/offers`, "staff", {
          ...offer({ template: "custom", reference: "OFFER-REV", external_ref: null, send: false }),
          supersedes_id: first.id,
          vat_treatment: "reverse_charge",
          items: [
            {
              description: "Licence",
              quantity: 3,
              unit: "months",
              unit_price_cents: 30000,
              vat_rate_bps: 0,
            },
          ],
          amendments: [{ title: "Start", body: "The pilot starts on the first of the month." }],
        })
      ).data,
    ).document;
    expect(revised.version).toBe(2);
    expect(revised.reference).toBe("OFFER-REV");
    expect(revised.title).toBe("Pilot for Testdorp");
    expect(revised.content?.vat_treatment).toBe("reverse_charge");
    const row = await store.document(w.db, w.orgId, revised.id);
    expect(row?.supersedesId).toBe(first.id);
    expect(row?.externalRef).toBe("deal-900");
    // While the revision is a draft the customer keeps the sent offer and its task.
    const openFor = async (docId: string) =>
      (await store.tasks(w.db, w.orgId)).filter(
        (t) => t.documentId === docId && !["done", "withdrawn"].includes(t.status),
      );
    expect((await store.document(w.db, w.orgId, first.id))?.status).toBe("sent");
    expect((await openFor(first.id)).map((t) => t.code)).toContain("sign_offer");
    // The deal still reads as sent: the draft waits beside the offer, not in its place.
    const card = K.AccountCard.parse((await call(w, "GET", S(), "staff")).data);
    expect(card.organisation.deal_stage).toBe("offer_sent");
    expect(card.organisation.milestones.offer_sent).not.toBeNull();
    // A second revision of the same offer may be drafted, but only one of them is sent.
    const other = K.PushOfferResponse.parse(
      (
        await call(w, "POST", `${S()}/offers`, "staff", {
          ...offer({ template: "custom", reference: "OFFER-REV", send: false }),
          supersedes_id: first.id,
          vat_treatment: "reverse_charge",
          items: [
            { description: "Licence", quantity: 3, unit_price_cents: 20000, vat_rate_bps: 0 },
          ],
        })
      ).data,
    ).document;
    // Sending the revision replaces it.
    expect((await send(revised.id)).status).toBe("sent");
    expect((await store.document(w.db, w.orgId, first.id))?.status).toBe("void");
    expect(await openFor(first.id)).toEqual([]);
    // The other revision of that offer is refused now, and nothing changes.
    const twice = await call(w, "POST", `${S()}/documents/${other.id}/send`, "staff", {});
    expect(twice.status).toBe(409);
    expect(JSON.stringify(twice.data)).toContain("already replaced");
    expect((await store.document(w.db, w.orgId, other.id))?.status).toBe("draft");
    expect((await store.document(w.db, w.orgId, revised.id))?.status).toBe("sent");
    // Pushed and sent in one go, the old offer is replaced at once, as before.
    const third = K.PushOfferResponse.parse(
      (
        await call(w, "POST", `${S()}/offers`, "staff", {
          ...offer({ reference: "OFFER-REV" }),
          supersedes_id: revised.id,
        })
      ).data,
    ).document;
    expect(third.status).toBe("sent");
    expect(third.version).toBe(3);
    expect((await store.document(w.db, w.orgId, revised.id))?.status).toBe("void");
  });

  test("a revision is not sent when the offer it replaces was signed meanwhile", async () => {
    const first = await draft(w.orgId, { reference: "OFFER-SIGNED" });
    await send(first.id);
    const revision = await draft(w.orgId, { reference: "OFFER-SIGNED", supersedes_id: first.id });
    expect((await sign(first.id)).status).toBe(200);
    const refused = await call(w, "POST", `${S()}/documents/${revision.id}/send`, "staff", {});
    expect(refused.status).toBe(409);
    expect((await store.document(w.db, w.orgId, revision.id))?.status).toBe("draft");
    expect((await store.document(w.db, w.orgId, first.id))?.status).toBe("signed");
    // Nor can a signed offer get a new draft revision.
    const late = await call(w, "POST", `${S()}/offers`, "staff", {
      ...offer({ reference: "OFFER-SIGNED", send: false }),
      supersedes_id: first.id,
    });
    expect(late.status).toBe(409);
  });

  test("staff make a new organisation with its contact, and it takes an offer", async () => {
    const body = {
      organisation_name: "Voorbeeld Holding (sample)",
      contact_email: "Jan@Voorbeeld.example",
      contact_name: "Jan Jansen",
      language: "en",
    };
    for (const who of ["admin", "member", "outsider"] as const)
      expect((await call(w, "POST", "/api/v2/admin/accounts", who, body)).status).toBe(403);
    expect(
      (await call(w, "POST", "/api/v2/admin/accounts", "staff", { ...body, contact_email: "x" }))
        .status,
    ).toBe(422);
    const r = await call(w, "POST", "/api/v2/admin/accounts", "staff", body);
    expect(r.status).toBe(201);
    const made = K.CreateAccountResponse.parse(r.data);
    expect(made.created).toBe(true);
    const card = K.AccountCard.parse((await call(w, "GET", S(made.org_id), "staff")).data);
    expect(card.organisation.name).toBe("Voorbeeld Holding (sample)");
    expect(card.organisation.account_stage).toBe("prospect");
    expect(card.members.map((m) => [m.email, m.role])).toEqual([
      ["jan@voorbeeld.example", "admin"],
    ]);
    const doc = await draft(made.org_id, { reference: "OFFER-NEW" });
    expect(doc.status).toBe("draft");
  });

  test("an offer carries the customer's reference: printed, offered to the signer, and on its invoice before the billing PO", async () => {
    const org = w.otherOrgId;
    const requested = () => inbox("echo_account_invoice_requested_v1");
    const lastInvoice = () =>
      (requested().at(-1) as { invoice: { po_number: string | null } }).invoice;
    const signedValue = async (docId: string) => {
      const fields = await store.fields(w.db, docId);
      const sig = await store.signatureOf(w.db, docId);
      const id = fields.find((f) => f.key === "po_number")?.id as string;
      return (sig?.fieldValues as Record<string, unknown> | undefined)?.[id];
    };

    // Set by staff, printed on the offer, and offered to the signer to confirm.
    const a = await draft(org, { reference: "OFFER-PO1", customer_reference: "PO-4500-01" });
    expect(a.content?.customer_reference).toBe("PO-4500-01");
    expect(a.body).toContain("Your reference: PO-4500-01");
    expect(a.fields.find((f) => f.key === "po_number")?.required).toBe(false);
    // A change that leaves it out keeps it; null drops it; a value sets it again.
    const path = `${S(org)}/offers/${a.id}`;
    const kept = K.DocumentDetail.parse(
      (await call(w, "PUT", path, "staff", offer({ reference: null, person_name: "Bo" }))).data,
    );
    expect(kept.content?.customer_reference).toBe("PO-4500-01");
    const dropped = K.DocumentDetail.parse(
      (await call(w, "PUT", path, "staff", offer({ reference: null, customer_reference: null })))
        .data,
    );
    expect(dropped.content?.customer_reference).toBeUndefined();
    expect(dropped.body).not.toContain("Your reference: ");
    await call(
      w,
      "PUT",
      path,
      "staff",
      offer({ reference: null, customer_reference: "PO-4500-01" }),
    );
    await send(a.id, org);
    const seen = K.DocumentDetail.parse(
      (await call(w, "GET", `${C(org)}/documents/${a.id}`, "outsider")).data,
    );
    expect(seen.prefill.po_number).toBe("PO-4500-01");

    // Confirmed at signing: frozen with the signature and on the invoice request.
    const before = requested().length;
    expect((await sign(a.id, "outsider", org, true, "PO-4500-01")).status).toBe(200);
    expect(requested()).toHaveLength(before + 1);
    expect(lastInvoice().po_number).toBe("PO-4500-01");
    expect(await signedValue(a.id)).toBe("PO-4500-01");

    // A second offer for the same organisation keeps its own reference, and the signer's
    // change wins over the one staff typed.
    const b = await draft(org, { reference: "OFFER-PO2", customer_reference: "PO-4500-02" });
    await send(b.id, org);
    expect((await sign(b.id, "outsider", org, true, "PO-4500-02/1")).status).toBe(200);
    expect(lastInvoice().po_number).toBe("PO-4500-02/1");
    expect(await signedValue(b.id)).toBe("PO-4500-02/1");
    const docs = await store.documents(w.db, org);
    const refOf = (r: string) =>
      (docs.find((d) => d.reference === r)?.content as { customer_reference?: string } | undefined)
        ?.customer_reference;
    expect([refOf("OFFER-PO1"), refOf("OFFER-PO2")]).toEqual(["PO-4500-01", "PO-4500-02"]);

    // A signer who fills one in where staff gave none: theirs goes on the invoice.
    const c = await draft(org, { reference: "OFFER-PO3" });
    await send(c.id, org);
    const blank = K.DocumentDetail.parse(
      (await call(w, "GET", `${C(org)}/documents/${c.id}`, "outsider")).data,
    );
    expect(blank.prefill.po_number).toBeNull();
    expect((await sign(c.id, "outsider", org, true, "ORDER-77")).status).toBe(200);
    expect(lastInvoice().po_number).toBe("ORDER-77");

    // With none on the offer and none at signing, the organisation's billing PO stands in.
    const onFile = (await store.billing(w.db, org))?.po_number;
    expect(onFile).toBeTruthy();
    const e = await draft(org, { reference: "OFFER-PO4" });
    await send(e.id, org);
    expect((await sign(e.id, "outsider", org)).status).toBe(200);
    expect(lastInvoice().po_number).toBe(onFile as string);
  });

  test("optional and included lines are shown but neither stored totals nor the invoice count them", async () => {
    const org = w.otherOrgId;
    const requested = () => inbox("echo_account_invoice_requested_v1");
    const items = [
      { description: "Licence", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 },
      {
        description: "Onboarding",
        quantity: 1,
        unit_price_cents: 0,
        vat_rate_bps: 2100,
        kind: "included",
      },
      {
        description: "Extra workshop",
        quantity: 1,
        unit_price_cents: 95000,
        vat_rate_bps: 2100,
        kind: "optional",
      },
    ];
    const doc = await draft(org, { reference: "OFFER-OPT1", template: "custom", items });
    expect([doc.subtotal_cents, doc.vat_cents, doc.total_cents]).toEqual([103200, 21672, 124872]);
    expect(doc.content?.items.map((i) => i.kind ?? "charged")).toEqual([
      "charged",
      "included",
      "optional",
    ]);
    expect(doc.body).toContain("| Onboarding | 1 |  | Included |");
    expect(doc.body).toContain("## Optional");
    const row = await store.document(w.db, org, doc.id);
    expect([row?.subtotalCents, row?.totalCents]).toEqual([103200, 124872]);

    // Signed, the invoice asks for the charged line only.
    await send(doc.id, org);
    const before = requested().length;
    expect((await sign(doc.id, "outsider", org)).status).toBe(200);
    expect(requested()).toHaveLength(before + 1);
    const message = requested().at(-1) as {
      document: { total_cents: number };
      invoice: { items: { description: string }[] };
    };
    expect(message.document.total_cents).toBe(124872);
    expect(message.invoice.items.map((i) => i.description)).toEqual(["Licence"]);

    // Options alone ask for nothing, and an included line carries no price.
    const onlyOptions = await call(
      w,
      "POST",
      `${S(org)}/offers`,
      "staff",
      offer({ send: false, reference: "OFFER-OPT2", items: [items[2]] }),
    );
    expect(onlyOptions.status).toBe(422);
    expect(JSON.stringify(onlyOptions.data)).toContain("more than zero");
    const pricedIncluded = await call(
      w,
      "POST",
      `${S(org)}/offers`,
      "staff",
      offer({
        send: false,
        reference: "OFFER-OPT3",
        items: [items[0], { ...items[1], unit_price_cents: 5000 }],
      }),
    );
    expect(pricedIncluded.status).toBe(422);
    expect(JSON.stringify(pricedIncluded.data)).toContain("included at no charge");
  });

  test("an offer invoiced to another party: printed, carried by the request in place of the customer's details, which it does not wait for", async () => {
    const org = await freshOrg("Gemeente Derde BV");
    const party = {
      name: "Voorbeeld Evenementen BV",
      address: "Kade 4",
      postal_code: "3011 AA",
      city: "Rotterdam",
      country_code: "nl",
      vat_id: "nl 1234.56789.b01",
      email: "facturen@voorbeeld.example",
      reference: "PRJ-2026-14",
    };
    const doc = await draft(org, { reference: "OFFER-BT1", bill_to: party });
    expect(doc.content?.bill_to).toEqual({
      ...party,
      country_code: "NL",
      vat_id: "NL123456789B01",
    });
    expect(doc.body).toContain(
      "## Invoiced to\nVoorbeeld Evenementen BV\nKade 4\n3011 AA Rotterdam",
    );
    expect(doc.body).toContain("VAT NL123456789B01");
    expect(doc.body).toContain("Reference: PRJ-2026-14");

    // A change that leaves it out keeps it; null drops it and a value sets it again.
    const path = `${S(org)}/offers/${doc.id}`;
    const kept = K.DocumentDetail.parse(
      (await call(w, "PUT", path, "staff", offer({ reference: "OFFER-BT1", person_name: "Bo" })))
        .data,
    );
    expect(kept.content?.bill_to?.name).toBe("Voorbeeld Evenementen BV");
    const dropped = K.DocumentDetail.parse(
      (await call(w, "PUT", path, "staff", offer({ reference: "OFFER-BT1", bill_to: null }))).data,
    );
    expect(dropped.content?.bill_to).toBeUndefined();
    expect(dropped.body).not.toContain("Invoiced to");
    await call(w, "PUT", path, "staff", offer({ reference: "OFFER-BT1", bill_to: party }));

    // Signed with its DPA, and the customer never saved billing details: the request goes.
    await send(doc.id, org);
    expect((await sign(doc.id, "outsider", org)).status).toBe(200);
    expect(await cardWaits(org)).toEqual([{ document_id: doc.id, waits_for: ["dpa"] }]);
    const dpa = (await store.documents(w.db, org)).find((d) => d.kind === "dpa");
    expect((await sign(dpa?.id as string, "outsider", org)).status).toBe(200);
    expect(await store.billing(w.db, org).then((b) => b?.billing_legal_name ?? null)).toBeNull();
    expect(requestedFor(org)).toHaveLength(1);
    expect(requestedFor(org)[0]).toMatchObject({
      org: { id: org, name: "Gemeente Derde BV" },
      document: { id: doc.id, reference: "OFFER-BT1" },
      billing: {
        legal_name: "Voorbeeld Evenementen BV",
        vat_id: "NL123456789B01",
        no_vat_number: false,
        billing_email: "facturen@voorbeeld.example",
        po_number: "PRJ-2026-14",
        invoice_delivery: "email",
        address: {
          line1: "Kade 4",
          postal_code: "3011 AA",
          city: "Rotterdam",
          country: "Netherlands",
          country_code: "NL",
        },
      },
      invoice: { po_number: "PRJ-2026-14", bill_to: true },
    });
    const card = K.AccountCard.parse((await call(w, "GET", S(org), "staff")).data);
    expect(card.invoice_waits).toEqual([]);
    expect(card.organisation.deal_stage).toBe("offer_accepted");
  });

  test("the VAT choice is judged on the party invoiced, and one that contradicts its country is refused", async () => {
    const org = await freshOrg("Gemeente Btw BV");
    const zero = [
      { description: "Licence", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 0 },
    ];
    const party = (over: Record<string, unknown>) => ({
      name: "Voorbeeld Partner",
      address: "Rue 1",
      postal_code: "1000",
      city: "Brussel",
      country_code: "BE",
      vat_id: "BE0123456789",
      email: "factuur@partner.example",
      ...over,
    });
    const attempt = async (n: number, vat_treatment: string, over: Record<string, unknown>) => {
      const r = await call(
        w,
        "POST",
        `${S(org)}/offers`,
        "staff",
        offer({
          send: false,
          reference: `OFFER-BTV${n}`,
          vat_treatment,
          ...(vat_treatment === "standard" ? {} : { items: zero }),
          bill_to: party(over),
        }),
      );
      return r.status === 201 ? "ok" : `${r.status} ${(r.data as { detail: string }).detail}`;
    };
    expect(await attempt(1, "standard", { country_code: "NL", vat_id: null })).toBe("ok");
    expect(await attempt(2, "reverse_charge", { country_code: "NL", vat_id: null })).toBe(
      "422 Voorbeeld Partner is in the Netherlands: choose Dutch VAT",
    );
    expect(await attempt(3, "standard", {})).toBe(
      "422 Voorbeeld Partner is a business elsewhere in the EU: choose reverse charge",
    );
    expect(await attempt(4, "reverse_charge", {})).toBe("ok");
    expect(await attempt(5, "reverse_charge", { vat_id: null })).toBe(
      "422 Reverse charge needs the VAT number of Voorbeeld Partner",
    );
    expect(await attempt(6, "standard", { vat_id: null })).toBe("ok");
    expect(await attempt(7, "outside_eu", { country_code: "DE", vat_id: null })).toBe(
      "422 Voorbeeld Partner is in the EU: outside the EU does not apply",
    );
    expect(await attempt(8, "reverse_charge", { country_code: "US", vat_id: "12-3456789" })).toBe(
      "422 Voorbeeld Partner is outside the EU: reverse charge does not apply",
    );
    expect(await attempt(9, "outside_eu", { country_code: "US", vat_id: null })).toBe("ok");
    expect(await attempt(10, "reverse_charge", { vat_id: "BE12" })).toBe(
      "422 BE12 does not look like a VAT number from Belgium",
    );
    expect(await attempt(11, "standard", { country_code: "XX" })).toBe(
      "422 Choose the country of the organisation that is invoiced",
    );

    // A change of the VAT choice alone is judged again on the party the draft keeps.
    const ok = await draft(org, { reference: "OFFER-BTV12", bill_to: party({ vat_id: null }) });
    const changed = await call(
      w,
      "PUT",
      `${S(org)}/offers/${ok.id}`,
      "staff",
      offer({ reference: "OFFER-BTV12", vat_treatment: "reverse_charge", items: zero }),
    );
    expect(changed.status).toBe(422);
    expect((changed.data as { detail: string }).detail).toBe(
      "Reverse charge needs the VAT number of Voorbeeld Partner",
    );
  });

  test("on a subscription only the seat line counts seats: other lines print their quantity alone", async () => {
    const org = await freshOrg("Gemeente Stoel BV");
    const doc = await draft(org, {
      reference: "OFFER-SEAT",
      items: [
        {
          description: "Changemaker seat",
          quantity: 3,
          unit_price_cents: 8600,
          vat_rate_bps: 2100,
        },
        {
          description: "Onboarding",
          quantity: 1,
          unit_price_cents: 0,
          vat_rate_bps: 2100,
          kind: "included",
        },
        { description: "Training", quantity: 1, unit_price_cents: 67500, vat_rate_bps: 2100 },
        {
          description: "Extra hours",
          quantity: 8,
          unit: "hours",
          unit_price_cents: 12500,
          vat_rate_bps: 2100,
        },
      ],
    });
    expect(doc.content?.items.map((i) => i.unit ?? null)).toEqual(["seats", null, null, "hours"]);
    expect(doc.body).toContain("| Changemaker seat | 3 seats |");
    expect(doc.body).toContain("| Onboarding | 1 |  | Included |");
    expect(doc.body).toContain("| Training | 1 |");
    expect(doc.body).not.toContain("1 seats");
    // One seat reads as one.
    const one = await draft(org, {
      reference: "OFFER-SEAT1",
      items: [
        {
          description: "Changemaker seat",
          quantity: 1,
          unit_price_cents: 8600,
          vat_rate_bps: 2100,
        },
      ],
    });
    expect(one.body).toContain("| Changemaker seat | 1 seat |");
  });
});
