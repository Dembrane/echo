import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { emailHandler, sendEmail } from "@dembrane/account";
import { schema } from "@dembrane/db";
import { MemoryMailer } from "@dembrane/mail";
import { deliverSamMessage } from "@dembrane/webhooks";
import { eq } from "drizzle-orm";
import * as K from "../src/contract";
import type { AccountsDeps } from "../src/deps";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, pngB64, silent, type World, world } from "./helpers";

// An offer as a draft: staff make it, read it, change it and send it; the customer's
// account shows nothing of it until it is sent, and then the people who run the account
// get one email. Then the invoice request: one message when a signed offer and complete
// billing details both exist.
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

  const send = async (docId: string, org = w.orgId) =>
    K.DocumentDetail.parse(
      (await call(w, "POST", `${S(org)}/documents/${docId}/send`, "staff", {})).data,
    );

  /** Signs as the organisation's admin, filling every field. */
  async function sign(docId: string, as: keyof World["people"] = "admin", org = w.orgId) {
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C(org)}/documents/${docId}`, as)).data,
    );
    const values: Record<string, string | boolean> = {};
    for (const f of detail.fields) {
      if (f.kind === "name") values[f.id] = "Anna de Vries";
      else if (f.kind === "role") values[f.id] = "Wethouder";
      else if (f.kind === "date") values[f.id] = "28-09-2026";
      else if (f.kind === "checkbox") values[f.id] = true;
      else if (f.kind === "text") values[f.id] = f.key === "organisation" ? "Testdorp" : "n/a";
    }
    const confirmation_text = (detail.confirmation?.dpa_authorised ?? "")
      .replace("{name}", "Anna de Vries")
      .replace("{role}", "Wethouder")
      .replace("{organisation}", "Testdorp");
    return call(w, "POST", `${C(org)}/documents/${docId}/sign`, as, {
      sha256: detail.sha256,
      values,
      signature: { png_base64: pngB64(), method: "drawn" },
      initials: null,
      dpa_authorised: true,
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
    // The person who runs the account is told by email, with the link sam is given.
    expect(offerEmails(doc.id, org)).toMatchObject([
      { to: "outsider@example.test", data: { org_name: "Elders BV" } },
    ]);

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

  test("the invoice is requested once, when the signed offer and the billing details both exist", async () => {
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
        no_vat_number: null,
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
      invoice: { vat_treatment: "standard", po_number: "PO-77" },
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

  test("sending an offer queues one email to each person who runs the account, with the link where it is signed", async () => {
    w.clock.now = new Date("2026-10-02T09:00:00.000Z");
    const pushed = K.PushOfferResponse.parse(
      (await call(w, "POST", `${S()}/offers`, "staff", offer({ reference: "OFFER-910" }))).data,
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
            offer({ reference: "OFFER-911", language: "nl" }),
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

  test("a draft queues no email; sending it later queues one for each person, once", async () => {
    const before = w.jobs.of(sendEmail.name).length;
    const doc = await draft(w.orgId, { reference: "OFFER-912" });
    expect(w.jobs.of(sendEmail.name)).toHaveLength(before);

    await send(doc.id);
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
});
