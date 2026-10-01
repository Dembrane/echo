import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { schema } from "@dembrane/db";
import { MemoryMailer } from "@dembrane/mail";
import { and, eq, sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import postgres from "postgres";
import * as K from "../src/contract";
import { runRemindersTick, runTaskReminder } from "../src/jobs";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, png, pngB64, type World, world } from "./helpers";

// Every route against Postgres: success, the refusal of each role that must not pass, and
// validation; the sign flow end to end with its refusals and the immutability of what it
// writes; the named signer; the events for sam; reminders. Needs a scratch Postgres:
//   TEST_DATABASE_ADMIN_URL=postgres://dembrane:dembrane@localhost:5440/postgres
const run = admin ? describe : describe.skip;
const DB = `accounts_it_${process.pid}`;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

run("accounts routes against Postgres", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  let offerId = "";
  let signTaskId = "";

  const offerBody = (over: Record<string, unknown> = {}) => ({
    template: "subscription",
    language: "nl",
    offer_name: "Gemeente Testdorp",
    person_name: "Anna",
    external_ref: "attio-deal-1",
    items: [
      {
        description: "dembrane changemaker, jaarlicentie",
        bullets: ["5 seats, 12 maanden", "Onbeperkt aantal uren opnames"],
        quantity: 60,
        unit_price_cents: 8600,
        vat_rate_bps: 2100,
      },
      {
        description: "Onboarding workshop",
        quantity: 1,
        unit_price_cents: 125000,
        vat_rate_bps: 2100,
      },
    ],
    ...over,
  });

  /** Fills every field of a document and builds the matching confirmation. */
  async function signPayload(
    docId: string,
    as: keyof World["people"],
    over: Record<string, unknown> = {},
  ) {
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${docId}`, as)).data,
    );
    const values: Record<string, string | boolean> = {};
    for (const f of detail.fields) {
      if (f.kind === "name") values[f.id] = "Anna de Vries";
      else if (f.kind === "role") values[f.id] = "Wethouder";
      else if (f.kind === "date") values[f.id] = "28-09-2026";
      else if (f.kind === "checkbox") values[f.id] = true;
      else if (f.kind === "text")
        values[f.id] =
          f.key === "organisation"
            ? "Gemeente Testdorp"
            : f.key === "address"
              ? "Dorpsstraat 1, Testdorp"
              : "NL001234567B01";
    }
    const dpa = (over.dpa_authorised as boolean | undefined) ?? true;
    const template = dpa
      ? detail.confirmation?.dpa_authorised
      : detail.confirmation?.dpa_not_authorised;
    const confirmation_text = (template ?? "")
      .replace("{name}", "Anna de Vries")
      .replace("{role}", "Wethouder")
      .replace("{organisation}", "Gemeente Testdorp");
    return {
      detail,
      body: {
        sha256: detail.sha256,
        values,
        signature: { png_base64: pngB64(), method: "drawn" },
        initials: null,
        dpa_authorised: dpa,
        confirmation_text,
        ...over,
      },
    };
  }

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  // ── staff: accounts ─────────────────────────────────────────────────
  test("creating an account: staff only, validated, idempotent on the needs form", async () => {
    const body = { organisation_name: "Provincie Proef", contact_email: "Contact@Proef.example" };
    expect((await call(w, "POST", "/api/v2/admin/accounts", null, body)).status).toBe(401);
    expect((await call(w, "POST", "/api/v2/admin/accounts", "admin", body)).status).toBe(403);
    expect(
      (
        await call(w, "POST", "/api/v2/admin/accounts", "staff", {
          organisation_name: "x",
          contact_email: "nope",
        })
      ).status,
    ).toBe(422);
    const r = await call(w, "POST", "/api/v2/admin/accounts", "staff", body);
    expect(r.status).toBe(201);
    const created = K.CreateAccountResponse.parse(r.data);
    expect(created.created).toBe(true);
    expect(created.continue_url).toContain(
      `/login?next=${encodeURIComponent(`/o/${created.org_id}/account`)}`,
    );
    const [m] = await w.db
      .select({ role: schema.org_membership.role })
      .from(schema.org_membership)
      .innerJoin(schema.app_user, eq(schema.app_user.id, schema.org_membership.user_id))
      .where(
        and(
          eq(schema.org_membership.org_id, created.org_id),
          eq(schema.app_user.email, "contact@proef.example"),
        ),
      );
    expect(m?.role).toBe("admin");
    // A prospect: no billing details task until an offer exists, and no onboarding tasks
    // unless the demo builder or staff add them.
    expect(await store.tasks(w.db, created.org_id)).toEqual([]);
    // Every staff call is on the audit trail.
    const audit = await w.db.select().from(schema.staff_audit_event);
    expect(
      audit.some((a) => a.action === "accounts.create" && a.permission === "staff:accounts"),
    ).toBe(true);
  });

  test("list and card: staff only, and they match the contract", async () => {
    expect((await call(w, "GET", "/api/v2/admin/accounts", "admin")).status).toBe(403);
    const list = await call(w, "GET", "/api/v2/admin/accounts?stage=prospect", "staff");
    expect(list.status).toBe(200);
    expect(K.AccountList.parse(list.data).accounts.length).toBeGreaterThanOrEqual(2);
    expect((await call(w, "GET", "/api/v2/admin/accounts?limit=0", "staff")).status).toBe(422);
    const card = await call(w, "GET", S(), "staff");
    expect(card.status).toBe(200);
    expect(K.AccountCard.parse(card.data).members.length).toBe(3);
    expect((await call(w, "GET", S(), "member")).status).toBe(403);
    expect((await call(w, "GET", "/api/v2/admin/accounts/not-a-uuid", "staff")).status).toBe(404);
  });

  test("stage and account manager: staff only, manager must be dembrane staff", async () => {
    expect((await call(w, "PATCH", S(), "billing", { account_stage: "customer" })).status).toBe(
      403,
    );
    expect((await call(w, "PATCH", S(), "staff", { account_stage: "gone" })).status).toBe(422);
    const bad = await call(w, "PATCH", S(), "staff", {
      account_manager_id: w.people.admin.appUserId,
    });
    expect(bad.status).toBe(400);
    const ok = await call(w, "PATCH", S(), "staff", { account_stage: "prospect" });
    expect(ok.status).toBe(200);
  });

  // ── offers ──────────────────────────────────────────────────────────
  test("pushing an offer pins the legal texts, renders the PDF with fields, and creates the tasks", async () => {
    expect((await call(w, "POST", `${S()}/offers`, "admin", offerBody())).status).toBe(403);
    expect((await call(w, "POST", `${S()}/offers`, "staff", offerBody({ items: [] }))).status).toBe(
      422,
    );
    expect(
      (
        await call(
          w,
          "POST",
          `${S()}/offers`,
          "staff",
          offerBody({
            items: [{ description: "x", quantity: 1, unit_price_cents: 100, vat_rate_bps: 1234 }],
          }),
        )
      ).status,
    ).toBe(422);
    const r = await call(w, "POST", `${S()}/offers`, "staff", offerBody());
    expect(r.status).toBe(201);
    const pushed = K.PushOfferResponse.parse(r.data);
    offerId = pushed.document.id;
    signTaskId = pushed.task?.id as string;
    expect(pushed.document.status).toBe("sent");
    expect(pushed.document.subtotal_cents).toBe(641000);
    expect(pushed.document.vat_cents).toBe(134610);
    expect(pushed.document.total_cents).toBe(775610);
    expect(pushed.document.legal.map((l) => `${l.kind} ${l.version} ${l.effective_on}`)).toEqual([
      "terms 2.0 2026-06-21",
      "sla 1.1 2026-06-21",
      "dpa 3.0.1 2026-07-17",
    ]);
    expect(pushed.document.content?.legal.dpa.version).toBe("3.0.1");
    expect(pushed.document.body).toContain("versie 3.0.1, 17-07-2026");
    expect(pushed.document.fields.map((f) => f.kind)).toEqual([
      "name",
      "text",
      "text",
      "text",
      "role",
      "date",
      "signature",
    ]);
    expect(pushed.task?.code).toBe("sign_offer");
    expect(pushed.task?.params).toEqual({ document_title: pushed.document.title });
    expect([pushed.task?.title, pushed.task?.body]).toEqual([null, null]);
    expect(pushed.task?.status).toBe("open");
    expect(pushed.task?.next_reminder_at).toBe("2026-10-05T09:00:00.000Z");
    const tasks = await store.tasks(w.db, w.orgId);
    expect(tasks.filter((t) => t.kind === "billing_details").map((t) => t.status)).toEqual([
      "locked",
    ]);
  });

  test("the one-page read: admins and billing see it, a plain member is refused, others do not see it exists", async () => {
    for (const as of ["admin", "billing"] as const) {
      const r = await call(w, "GET", C(), as);
      expect(r.status).toBe(200);
      const page = K.AccountPage.parse(r.data);
      expect(page.tasks[0]?.code).toBe("sign_offer");
      expect(page.tasks.find((t) => t.kind === "billing_details")?.locked).toBe(true);
      expect(page.documents.find((d) => d.id === offerId)?.file_url).toBe(
        `${C()}/documents/${offerId}/file`,
      );
    }
    expect((await call(w, "GET", C(), "member")).status).toBe(403);
    expect((await call(w, "GET", C(), "outsider")).status).toBe(404);
    expect((await call(w, "GET", C(), "staff")).status).toBe(404);
    expect((await call(w, "GET", C(), null)).status).toBe(401);
  });

  test("the document PDF is what the sha256 names, and the first open marks it viewed", async () => {
    const file = await call(w, "GET", `${C()}/documents/${offerId}/file`, "admin");
    expect(file.status).toBe(200);
    const bytes = file.data as unknown as Uint8Array;
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${offerId}`, "admin")).data,
    );
    expect(sha(bytes)).toBe(detail.sha256 as string);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(detail.page_count as number);
    expect((await call(w, "GET", `${C()}/documents/${offerId}/signed.pdf`, "admin")).status).toBe(
      404,
    );
    expect((await call(w, "POST", `${C()}/documents/${offerId}/view`, "billing")).data).toEqual({
      status: "viewed",
    });
    expect((await call(w, "POST", `${C()}/documents/${offerId}/view`, "admin")).data).toEqual({
      status: "viewed",
    });
    expect((await call(w, "GET", `${C()}/documents/${offerId}`, "outsider")).status).toBe(404);
  });

  // ── signing ─────────────────────────────────────────────────────────
  test("signing refuses a changed document, a wrong confirmation, a missing field, a bad image and the wrong people", async () => {
    const { body } = await signPayload(offerId, "admin");
    const url = `${C()}/documents/${offerId}/sign`;
    expect((await call(w, "POST", url, "admin", { ...body, sha256: "0".repeat(64) })).status).toBe(
      409,
    );
    const wrong = await call(w, "POST", url, "admin", { ...body, confirmation_text: "I agree." });
    expect(wrong.status).toBe(422);
    const values = { ...(body.values as Record<string, string>) };
    delete values[Object.keys(values)[0] as string];
    expect((await call(w, "POST", url, "admin", { ...body, values })).status).toBe(422);
    expect(
      (
        await call(w, "POST", url, "admin", {
          ...body,
          values: { ...body.values, "not-a-field": "x" },
        })
      ).status,
    ).toBe(422);
    const jpeg = Buffer.from(new Uint8Array(300).fill(0xff)).toString("base64");
    expect(
      (
        await call(w, "POST", url, "admin", {
          ...body,
          signature: { png_base64: jpeg, method: "uploaded" },
        })
      ).status,
    ).toBe(422);
    const huge = Buffer.concat([Buffer.from(png()), Buffer.alloc(600 * 1024)]).toString("base64");
    expect(
      (
        await call(w, "POST", url, "admin", {
          ...body,
          signature: { png_base64: huge, method: "uploaded" },
        })
      ).status,
    ).toBe(422);
    expect((await call(w, "POST", url, "member", body)).status).toBe(403);
    expect((await call(w, "POST", url, "outsider", body)).status).toBe(404);
    expect((await call(w, "POST", url, null, body)).status).toBe(401);
    expect(await store.signatureOf(w.db, offerId)).toBeNull();
  });

  test("signing: the row, the stamped PDF, the tasks, the stage, and the event for sam", async () => {
    w.jobs.jobs.length = 0;
    const { body } = await signPayload(offerId, "billing");
    const r = await call(w, "POST", `${C()}/documents/${offerId}/sign`, "billing", body);
    expect(r.status).toBe(200);
    const signed = K.SignResponse.parse(r.data);
    const sig = await store.signatureOf(w.db, offerId);
    expect(sig?.email).toBe("billing@example.test");
    expect(sig?.typedName).toBe("Anna de Vries");
    expect(sig?.typedRole).toBe("Wethouder");
    expect(sig?.organisation).toBe("Gemeente Testdorp");
    expect(sig?.address).toBe("Dorpsstraat 1, Testdorp");
    expect(sig?.vatNumber).toBe("NL001234567B01");
    expect(sig?.ip).toBe("203.0.113.7");
    expect(sig?.userAgent).toBe("accounts-test");
    expect(sig?.method).toBe("drawn");
    expect(sig?.imageSha256).toBe(sha(png()));
    expect(sig?.confirmationText).toBe(signed.confirmation_text);
    const doc = await store.document(w.db, w.orgId, offerId);
    expect(sig?.sha256).toBe(doc?.sha256 as string);
    // The signed PDF: the document's pages plus the audit page, stored under its hash.
    const pdf = await call(w, "GET", `${C()}/documents/${offerId}/signed.pdf`, "admin");
    const bytes = pdf.data as unknown as Uint8Array;
    expect(sha(bytes)).toBe(sig?.signedPdfSha256 as string);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe((doc?.pageCount as number) + 1);
    const image = await w.files.get(sig?.imageKey as string);
    expect(sha(new Uint8Array(await (image as Blob).arrayBuffer()))).toBe(
      sig?.imageSha256 as string,
    );
    // Tasks: signing done, billing details open and reminding; the prospect is a customer.
    const tasks = await store.tasks(w.db, w.orgId);
    expect(tasks.find((t) => t.id === signTaskId)?.status).toBe("done");
    const billing = tasks.find((t) => t.kind === "billing_details");
    expect(billing?.status).toBe("open");
    expect(billing?.nextReminderAt?.toISOString()).toBe("2026-10-05T09:00:00.000Z");
    expect((await store.org(w.db, w.orgId))?.account_stage).toBe("customer");
    // What sam's invoice_request receives.
    const [event] = w.jobs.of("accounts.deliver-event");
    const payload = (event as { payload: Record<string, unknown> }).payload;
    expect(payload.event).toBe("account.document.signed");
    expect((payload.org as { id: string }).id).toBe(w.orgId);
    expect(payload.document).toMatchObject({
      id: offerId,
      kind: "offer",
      external_ref: "attio-deal-1",
      total_cents: 775610,
      currency: "EUR",
    });
    expect(payload.signature).toMatchObject({
      email: "billing@example.test",
      organisation: "Gemeente Testdorp",
      signed_pdf: `/api/v2/admin/accounts/${w.orgId}/documents/${offerId}/signed.pdf`,
    });
    expect(payload.billing).toHaveProperty("po_number");
    expect(w.jobs.of("accounts.notify-slack")[0]?.text).toContain("signed");
    expect(
      (
        await call(
          w,
          "GET",
          `/api/v2/admin/accounts/${w.orgId}/documents/${offerId}/signed.pdf`,
          "staff",
        )
      ).status,
    ).toBe(200);
  });

  test("a signature, a sent document, its fields and a legal text cannot be changed afterwards", async () => {
    const raw = postgres(w.url, { max: 1, onnotice: () => {} });
    // postgres.js queries run when awaited; a plain await gives the database's refusal.
    const failure = async (q: PromiseLike<unknown>) => {
      try {
        await q;
        return "no error";
      } catch (err) {
        return (err as Error).message;
      }
    };
    try {
      expect(await failure(raw`update account_signature set typed_name = 'someone else'`)).toMatch(
        /insert-only/,
      );
      expect(await failure(raw`delete from account_signature`)).toMatch(/insert-only/);
      expect(await failure(raw`truncate account_signature cascade`)).toMatch(/insert-only/);
      expect(
        await failure(raw`update account_document set body = 'changed' where id = ${offerId}`),
      ).toMatch(/cannot change/);
      expect(
        await failure(raw`update account_document set status = 'sent' where id = ${offerId}`),
      ).toMatch(/is signed/);
      expect(
        await failure(raw`delete from account_document_field where document_id = ${offerId}`),
      ).toMatch(/cannot change/);
      expect(await failure(raw`update legal_text set body = 'x'`)).toMatch(/insert-only/);
      expect(await failure(raw`delete from legal_text`)).toMatch(/insert-only/);
    } finally {
      await raw.end();
    }
    const again = await signPayload(offerId, "admin");
    expect(
      (await call(w, "POST", `${C()}/documents/${offerId}/sign`, "admin", again.body)).status,
    ).toBe(409);
    expect((await call(w, "POST", `${S()}/documents/${offerId}/void`, "staff", {})).status).toBe(
      409,
    );
  });

  test("a signer who may not agree to data processing leaves a DPA to sign separately", async () => {
    const pushed = K.PushOfferResponse.parse(
      (
        await call(
          w,
          "POST",
          `${S()}/offers`,
          "staff",
          offerBody({ template: "event", language: "en", attention: "Anna" }),
        )
      ).data,
    );
    expect(pushed.document.body).toContain(
      "Appendix B: Data Processing Agreement (version 3.0.1, 17-07-2026",
    );
    const { body } = await signPayload(pushed.document.id, "admin", { dpa_authorised: false });
    expect(
      (await call(w, "POST", `${C()}/documents/${pushed.document.id}/sign`, "admin", body)).status,
    ).toBe(200);
    const docs = await store.documents(w.db, w.orgId);
    const dpa = docs.find((d) => d.kind === "dpa");
    expect(dpa?.status).toBe("sent");
    expect(dpa?.title).toBe("Data Processing Agreement (DPA) 3.0.1");
    expect((await store.fields(w.db, dpa?.id as string)).some((f) => f.kind === "signature")).toBe(
      true,
    );
    const task = (await store.tasks(w.db, w.orgId)).find((t) => t.documentId === dpa?.id);
    expect(task?.kind).toBe("sign");
    expect(task?.status).toBe("open");
    // The DPA itself is signed only by someone who may agree to data processing.
    const dpaSign = await signPayload(dpa?.id as string, "admin", { dpa_authorised: false });
    expect(
      (await call(w, "POST", `${C()}/documents/${dpa?.id}/sign`, "admin", dpaSign.body)).status,
    ).toBe(422);
    const ok = await signPayload(dpa?.id as string, "admin");
    expect(
      (await call(w, "POST", `${C()}/documents/${dpa?.id}/sign`, "admin", ok.body)).status,
    ).toBe(200);
  });

  test("naming another signer: they get an invitation and reach that one document, and only they can sign it", async () => {
    const pushed = K.PushOfferResponse.parse(
      (await call(w, "POST", `${S()}/offers`, "staff", offerBody())).data,
    );
    const id = pushed.document.id;
    w.jobs.jobs.length = 0;
    const named = { name: "Signer Person", email: "Signer@Example.test", role: "Burgemeester" };
    expect((await call(w, "POST", `${C()}/documents/${id}/signer`, "member", named)).status).toBe(
      403,
    );
    expect(
      (await call(w, "POST", `${C()}/documents/${id}/signer`, "admin", { ...named, email: "x" }))
        .status,
    ).toBe(422);
    const r = await call(w, "POST", `${C()}/documents/${id}/signer`, "admin", named);
    expect(K.NameSignerResponse.parse(r.data).signer.email).toBe("signer@example.test");
    const [mail] = w.jobs.of("account.send-email");
    expect(mail).toMatchObject({ to: "signer@example.test", template: "account_signer_invite" });
    expect((mail as { data: { sign_url: string } }).data.sign_url).toBe(
      `https://dash.test/o/${w.orgId}/account/documents/${id}/sign`,
    );
    expect(await store.mayReceiveCode(w.db, "signer@example.test", w.clock.now)).toBe(true);
    expect(await store.mayReceiveCode(w.db, "stranger@example.test", w.clock.now)).toBe(false);
    // The signer sees that document, and nothing else of the organisation.
    const seen = await call(w, "GET", `${C()}/documents/${id}`, "signer");
    expect(seen.status).toBe(200);
    expect(K.DocumentDetail.parse(seen.data).access).toBe("signer");
    expect((await call(w, "GET", C(), "signer")).status).toBe(404);
    expect((await call(w, "GET", `${C()}/documents/${offerId}`, "signer")).status).toBe(404);
    const requests = K.SigningRequests.parse(
      (await call(w, "GET", "/api/v2/account/signing-requests", "signer")).data,
    );
    expect(requests.map((x) => x.document.id)).toEqual([id]);
    // Once named, the admin can no longer sign it; the signer can.
    const asAdmin = await signPayload(id, "admin");
    expect(
      (await call(w, "POST", `${C()}/documents/${id}/sign`, "admin", asAdmin.body)).status,
    ).toBe(403);
    const asSigner = await signPayload(id, "signer");
    expect(
      (await call(w, "POST", `${C()}/documents/${id}/sign`, "signer", asSigner.body)).status,
    ).toBe(200);
    expect((await store.signatureOf(w.db, id))?.email).toBe("signer@example.test");
    expect((await call(w, "GET", `${C()}/documents/${id}/signed.pdf`, "signer")).status).toBe(200);
  });

  test("naming a different signer is recorded as a replacement, and namings are limited per organisation", async () => {
    const pushed = K.PushOfferResponse.parse(
      (await call(w, "POST", `${S()}/offers`, "staff", offerBody())).data,
    );
    const id = pushed.document.id;
    const path = `${C()}/documents/${id}/signer`;
    const first = { name: "First Person", email: "first@example.test", role: null };
    const second = { name: "Second Person", email: "Second@Example.test", role: "Griffier" };
    const mine = async () =>
      (await store.events(w.db, w.orgId)).filter(
        (e) => e.subjectId === id && e.type.startsWith("document.signer_"),
      );
    expect((await call(w, "POST", path, "admin", first)).status).toBe(200);
    // The same person again is a new invitation, not a replacement.
    expect((await call(w, "POST", path, "admin", first)).status).toBe(200);
    expect((await mine()).map((e) => e.type)).toEqual([
      "document.signer_named",
      "document.signer_named",
    ]);
    const r = await call(w, "POST", path, "billing", second);
    expect(K.NameSignerResponse.parse(r.data).signer.email).toBe("second@example.test");
    const replaced = (await mine()).find((e) => e.type === "document.signer_replaced");
    expect(replaced).toMatchObject({
      actorKind: "customer",
      actorUserId: w.people.billing.directusUserId,
      createdAt: w.clock.now,
      detail: {
        email: "second@example.test",
        name: "Second Person",
        previous_email: "first@example.test",
        previous_name: "First Person",
      },
    });
    const card = K.AccountCard.parse((await call(w, "GET", S(), "staff")).data);
    expect(card.timeline.some((e) => e.type === "document.signer_replaced")).toBe(true);

    // Ten an hour for the organisation, whoever asks.
    const named = async () =>
      (await store.events(w.db, w.orgId)).filter((e) => e.type.startsWith("document.signer_"))
        .length;
    let status = 200;
    for (let i = 0; i < 10 && status === 200; i++)
      status = (await call(w, "POST", path, i % 2 ? "admin" : "billing", first)).status;
    expect(status).toBe(429);
    expect(await named()).toBe(10);
    const signer = (await store.document(w.db, w.orgId, id))?.signerEmail;
    expect((await call(w, "POST", path, "admin", second)).status).toBe(429);
    expect((await store.document(w.db, w.orgId, id))?.signerEmail).toBe(signer as string);
  });

  test("declining: refused for members, recorded and sent to sam", async () => {
    const pushed = K.PushOfferResponse.parse(
      (await call(w, "POST", `${S()}/offers`, "staff", offerBody())).data,
    );
    const id = pushed.document.id;
    expect((await call(w, "POST", `${C()}/documents/${id}/decline`, "member", {})).status).toBe(
      403,
    );
    w.jobs.jobs.length = 0;
    const r = await call(w, "POST", `${C()}/documents/${id}/decline`, "admin", {
      reason: "Te duur",
    });
    expect(K.DeclineResponse.parse(r.data).status).toBe("declined");
    expect(w.jobs.of("accounts.deliver-event")[0]?.payload).toMatchObject({
      event: "account.document.declined",
      reason: "Te duur",
      declined_by: "admin@example.test",
    });
    expect((await store.task(w.db, w.orgId, pushed.task?.id as string))?.status).toBe("withdrawn");
    expect((await call(w, "POST", `${C()}/documents/${id}/decline`, "admin", {})).status).toBe(409);
  });

  test("superseding and voiding an unsigned offer withdraws its task", async () => {
    const first = K.PushOfferResponse.parse(
      (await call(w, "POST", `${S()}/offers`, "staff", offerBody())).data,
    );
    const second = K.PushOfferResponse.parse(
      (
        await call(
          w,
          "POST",
          `${S()}/offers`,
          "staff",
          offerBody({ supersedes_id: first.document.id }),
        )
      ).data,
    );
    expect(second.document.version).toBe(first.document.version + 1);
    expect((await store.document(w.db, w.orgId, first.document.id))?.status).toBe("void");
    expect((await store.task(w.db, w.orgId, first.task?.id as string))?.status).toBe("withdrawn");
    const voided = await call(w, "POST", `${S()}/documents/${second.document.id}/void`, "staff", {
      reason: "wrong seats",
    });
    expect(K.DocumentDetail.parse(voided.data).status).toBe("void");
    expect(
      (await call(w, "POST", `${S()}/documents/${second.document.id}/void`, "admin", {})).status,
    ).toBe(403);
  });

  // ── billing details ─────────────────────────────────────────────────
  test("billing details: validated, saved, the task done at once, the event and Slack", async () => {
    const good = {
      legal_name: "Gemeente Testdorp",
      billing_email: "Facturen@Testdorp.example",
      address_line1: "Dorpsstraat 1",
      postal_code: "1234 AB",
      city: "Testdorp",
      country: "NL",
      kvk_number: "12345678",
      po_number: "PO-2026-77",
      peppol_id: "0190:00000000000000000000",
    };
    expect((await call(w, "PUT", `${C()}/billing`, "member", good)).status).toBe(403);
    expect(
      (await call(w, "PUT", `${C()}/billing`, "admin", { ...good, kvk_number: null })).status,
    ).toBe(422);
    expect(
      (await call(w, "PUT", `${C()}/billing`, "admin", { ...good, billing_email: "no" })).status,
    ).toBe(422);
    w.jobs.jobs.length = 0;
    const r = await call(w, "PUT", `${C()}/billing`, "billing", good);
    expect(r.status).toBe(200);
    expect(K.BillingDetails.parse(r.data)).toMatchObject({
      billing_email: "facturen@testdorp.example",
      po_number: "PO-2026-77",
    });
    expect(
      K.BillingDetails.parse((await call(w, "GET", `${C()}/billing`, "admin")).data).kvk_number,
    ).toBe("12345678");
    const task = (await store.tasks(w.db, w.orgId)).find((t) => t.kind === "billing_details");
    // Saving completes the task at once: no review by staff.
    expect(task?.status).toBe("done");
    expect(task?.nextReminderAt).toBeNull();
    expect(w.jobs.of("accounts.deliver-event")[0]?.payload).toMatchObject({
      event: "account.billing_details.updated",
      billing: { legal_name: "Gemeente Testdorp", kvk_number: "12345678", po_number: "PO-2026-77" },
    });
    expect(w.jobs.of("accounts.notify-slack")[0]?.text).toContain("PO-2026-77");
    const review = await call(w, "POST", `${S()}/tasks/${task?.id}/review`, "staff", {
      decision: "approve",
    });
    expect(review.status).toBe(409);
  });

  // ── tasks ───────────────────────────────────────────────────────────
  test("tasks: staff create, customers submit text or files, staff approve, send back or withdraw", async () => {
    expect((await call(w, "POST", `${S()}/tasks`, "admin", { title: "x" })).status).toBe(403);
    expect((await call(w, "POST", `${S()}/tasks`, "staff", { title: "" })).status).toBe(422);
    const po = K.Task.parse(
      (
        await call(w, "POST", `${S()}/tasks`, "staff", {
          title: "Send us your PO number",
          reminder_interval_days: 3,
        })
      ).data,
    );
    expect(po.next_reminder_at).toBe("2026-10-01T09:00:00.000Z");
    const logo = K.Task.parse(
      (
        await call(w, "POST", `${S()}/tasks`, "staff", {
          title: "Upload your logo",
          kind: "upload",
        })
      ).data,
    );
    expect(
      (await call(w, "POST", `${C()}/tasks/${po.id}/submit`, "member", { response_text: "PO-1" }))
        .status,
    ).toBe(403);
    expect((await call(w, "POST", `${C()}/tasks/${po.id}/submit`, "admin", {})).status).toBe(422);
    w.jobs.jobs.length = 0;
    const sub = await call(w, "POST", `${C()}/tasks/${po.id}/submit`, "admin", {
      response_text: "PO-1",
    });
    expect(K.Task.parse(sub.data).status).toBe("submitted");
    expect(w.jobs.of("accounts.deliver-event")[0]?.payload).toMatchObject({
      event: "account.task.submitted",
      task: { id: po.id, response_text: "PO-1", has_file: false },
    });
    expect(
      (await call(w, "POST", `${C()}/tasks/${po.id}/submit`, "admin", { response_text: "again" }))
        .status,
    ).toBe(409);
    expect(
      (await call(w, "POST", `${C()}/tasks/${logo.id}/submit`, "admin", { response_text: "here" }))
        .status,
    ).toBe(422);
    const form = new FormData();
    form.set("response_text", "Ons logo");
    form.set("file", new File([png()], "logo.png", { type: "image/png" }));
    const up = await w.app.request(`${C()}/tasks/${logo.id}/submit`, {
      method: "POST",
      headers: { "x-as": "admin" },
      body: form,
    });
    expect(up.status).toBe(200);
    expect(K.Task.parse(await up.json()).response_file_name).toBe("logo.png");
    // Signing tasks settle by signing.
    const signing = (await store.tasks(w.db, w.orgId)).find((t) => t.kind === "sign");
    expect(
      (await call(w, "POST", `${C()}/tasks/${signing?.id}/submit`, "admin", { response_text: "x" }))
        .status,
    ).toBe(409);
    // Review.
    expect(
      (await call(w, "POST", `${S()}/tasks/${po.id}/review`, "staff", { decision: "send_back" }))
        .status,
    ).toBe(422);
    const back = K.Task.parse(
      (
        await call(w, "POST", `${S()}/tasks/${po.id}/review`, "staff", {
          decision: "send_back",
          note: "Dit is het offertenummer",
        })
      ).data,
    );
    expect(back.status).toBe("changes_requested");
    expect(back.next_reminder_at).toBe("2026-10-01T09:00:00.000Z");
    const withdrawn = K.Task.parse(
      (await call(w, "POST", `${S()}/tasks/${po.id}/review`, "staff", { decision: "withdraw" }))
        .data,
    );
    expect(withdrawn.status).toBe("withdrawn");
    expect(
      (await call(w, "POST", `${S()}/tasks/${po.id}/review`, "staff", { decision: "approve" }))
        .status,
    ).toBe(409);
    expect(
      K.Task.parse(
        (await call(w, "POST", `${S()}/tasks/${logo.id}/review`, "staff", { decision: "approve" }))
          .data,
      ).status,
    ).toBe("done");
  });

  test("reminders: due tasks waiting on the customer email the account's people once per due time", async () => {
    const t = K.Task.parse(
      (await call(w, "POST", `${S()}/tasks`, "staff", { title: "Stuur de deelnemerslijst" })).data,
    );
    const mailer = new MemoryMailer();
    w.jobs.jobs.length = 0;
    const tick = (at: string) =>
      runRemindersTick({
        db: w.db,
        jobs: w.jobs,
        now: () => new Date(at),
        intervalDays: 7,
        logger: w.deps.logger,
      });
    expect(await tick("2026-10-04T09:00:00.000Z")).toBe(0);
    const due = await tick("2026-10-05T09:30:00.000Z");
    expect(due).toBeGreaterThanOrEqual(1);
    const queued = w.jobs.jobs.filter(
      (j) =>
        j.name === "accounts.task-reminder" && (j.payload as { taskId: string }).taskId === t.id,
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]?.workflowId).toBe(`accounts.reminder:${t.id}:2026-10-05T09:00:00.000Z`);
    expect((await store.task(w.db, w.orgId, t.id))?.nextReminderAt?.toISOString()).toBe(
      "2026-10-12T09:00:00.000Z",
    );
    // The same due time again does not queue a second email.
    await tick("2026-10-05T09:45:00.000Z");
    expect(
      w.jobs.jobs.filter((j) => (j.payload as { taskId?: string }).taskId === t.id),
    ).toHaveLength(1);
    const deps = {
      db: w.db,
      mailer,
      logger: w.deps.logger,
      dashboardUrl: "https://dash.test",
      now: () => new Date("2026-10-05T09:31:00Z"),
    };
    expect(
      await runTaskReminder(deps, queued[0]?.payload as { taskId: string; dueAt: string }),
    ).toBe("sent");
    expect(mailer.sent[0]?.to).toEqual(["admin@example.test", "billing@example.test"]);
    expect(mailer.sent[0]?.text).toContain(`https://dash.test/o/${w.orgId}/account`);
    // A task waiting on us, or done, does not remind.
    await call(w, "POST", `${C()}/tasks/${t.id}/submit`, "admin", {
      response_text: "lijst.xlsx volgt",
    });
    expect(await runTaskReminder(deps, { taskId: t.id, dueAt: "2026-10-12T09:00:00.000Z" })).toBe(
      "skipped",
    );
    const locked = (await store.dueReminders(w.db, new Date("2030-01-01"), 500)).filter(
      (x) => x.status === "locked" || x.status === "submitted",
    );
    expect(locked).toHaveLength(0);
  });

  // ── questions ───────────────────────────────────────────────────────
  test("questions: customers open and reply, staff answer and close; a new question reaches sam and Slack", async () => {
    expect(
      (await call(w, "POST", `${C()}/tickets`, "member", { subject: "a", body: "b" })).status,
    ).toBe(403);
    expect(
      (await call(w, "POST", `${C()}/tickets`, "admin", { subject: "", body: "b" })).status,
    ).toBe(422);
    w.jobs.jobs.length = 0;
    const opened = await call(w, "POST", `${C()}/tickets`, "admin", {
      subject: "Kwartaalfacturen?",
      body: "Kan dat?",
    });
    expect(opened.status).toBe(201);
    const ticket = K.Ticket.parse(opened.data);
    expect(ticket.status).toBe("waiting_on_dembrane");
    expect(w.jobs.of("accounts.deliver-event")[0]?.payload).toMatchObject({
      event: "account.ticket.opened",
      ticket: { id: ticket.id, subject: "Kwartaalfacturen?", message: "Kan dat?" },
    });
    expect(w.jobs.of("accounts.notify-slack")[0]?.text).toContain("Kwartaalfacturen?");
    const answered = K.Ticket.parse(
      (await call(w, "POST", `${S()}/tickets/${ticket.id}/messages`, "staff", { body: "Ja." }))
        .data,
    );
    expect(answered.messages.map((m) => m.from)).toEqual(["customer", "dembrane"]);
    expect(answered.status).toBe("waiting_on_customer");
    expect(
      (await call(w, "POST", `${S()}/tickets/${ticket.id}/messages`, "billing", { body: "x" }))
        .status,
    ).toBe(403);
    const replied = K.Ticket.parse(
      (await call(w, "POST", `${C()}/tickets/${ticket.id}/messages`, "billing", { body: "Dank!" }))
        .data,
    );
    expect(replied.status).toBe("waiting_on_dembrane");
    expect(
      K.Ticket.parse((await call(w, "POST", `${S()}/tickets/${ticket.id}/close`, "staff")).data)
        .status,
    ).toBe("closed");
    const staffOpened = await call(w, "POST", `${S()}/tickets`, "staff", {
      subject: "Logo?",
      body: "Welke kleur?",
    });
    expect(K.Ticket.parse(staffOpened.data).status).toBe("waiting_on_customer");
    expect(
      (await call(w, "POST", `${C()}/tickets/${ticket.id}/messages`, "outsider", { body: "x" }))
        .status,
    ).toBe(404);
  });

  test("a booked call lands on the timeline", async () => {
    expect((await call(w, "POST", `${C()}/booking`, "member", { uid: "cal-1" })).status).toBe(403);
    expect((await call(w, "POST", `${C()}/booking`, "admin", {})).status).toBe(422);
    const r = await call(w, "POST", `${C()}/booking`, "admin", {
      uid: "cal-1",
      start: "2026-10-02T10:00:00Z",
      status: "accepted",
    });
    expect(K.BookingResponse.parse(r.data).recorded).toBe(true);
    expect(
      (await store.events(w.db, w.orgId)).some(
        (e) => e.type === "booking.recorded" && e.subjectId === "cal-1",
      ),
    ).toBe(true);
  });

  // ── invoices ────────────────────────────────────────────────────────
  test("invoice mirrors: sam upserts on the Exact id; bank details always, Mollie only when present", async () => {
    const inv = {
      number: "2026-0421",
      issued_on: "2026-09-28",
      due_on: "2026-10-28",
      subtotal_cents: 125000,
      vat_cents: 26250,
      total_cents: 151250,
      status: "open",
      offer_id: offerId,
    };
    const path = `${S()}/invoices/EX-1`;
    expect((await call(w, "PUT", path, "admin", inv)).status).toBe(403);
    expect((await call(w, "PUT", path, "staff", { ...inv, total_cents: 1 })).status).toBe(422);
    const created = K.DocumentDetail.parse((await call(w, "PUT", path, "staff", inv)).data);
    expect(created.kind).toBe("invoice");
    expect(created.invoice?.bank_transfer).toEqual({
      iban: "NL49 RABO 0318910535",
      bic: "RABONL2U",
      account_name: "Dembrane B.V.",
      reference: "2026-0421",
    });
    expect(created.invoice?.payment_url).toBeNull();
    const pdf = Buffer.from(await (await PDFDocument.create()).save());
    const paid = K.DocumentDetail.parse(
      (
        await call(w, "PUT", path, "staff", {
          ...inv,
          status: "paid",
          payment_url: "https://www.mollie.com/checkout/abc",
          pdf_base64: pdf.toString("base64"),
        })
      ).data,
    );
    expect(paid.id).toBe(created.id);
    expect(paid.invoice?.status).toBe("paid");
    expect(paid.invoice?.paid_at).toBeTruthy();
    expect(paid.invoice?.payment_url).toBe("https://www.mollie.com/checkout/abc");
    expect(paid.file_url).toBe(`/api/v2/admin/accounts/${w.orgId}/documents/${created.id}/file`);
    expect(
      (
        await call(w, "PUT", path, "staff", {
          ...inv,
          subtotal_cents: 100000,
          vat_cents: 21000,
          total_cents: 121000,
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(w, "PUT", `/api/v2/admin/accounts/${w.otherOrgId}/invoices/EX-1`, "staff", inv))
        .status,
    ).toBe(409);
    const page = K.AccountPage.parse((await call(w, "GET", C(), "billing")).data);
    expect(page.documents.find((d) => d.kind === "invoice")?.invoice?.bank_transfer.iban).toBe(
      "NL49 RABO 0318910535",
    );
    expect((await call(w, "GET", `${C()}/documents/${created.id}/file`, "billing")).status).toBe(
      200,
    );
  });

  // ── other documents ─────────────────────────────────────────────────
  test("documents: text documents get a signing block; an uploaded PDF waits for fields, then is sent", async () => {
    const text = K.PushDocumentResponse.parse(
      (
        await call(w, "POST", `${S()}/documents`, "staff", {
          kind: "other",
          title: "Werkplan workshop",
          body: "# Werkplan\n\nWe beginnen om 9 uur.",
          requires_signature: true,
          task: { title: "Teken het werkplan" },
        })
      ).data,
    );
    expect(text.document.status).toBe("sent");
    expect(text.document.fields.at(-1)?.kind).toBe("signature");
    expect(text.task?.kind).toBe("sign");

    const upload = Buffer.from(
      await (
        await (async () => {
          const d = await PDFDocument.create();
          d.addPage();
          d.addPage();
          return d;
        })()
      ).save(),
    );
    const r = await call(w, "POST", `${S()}/documents`, "staff", {
      kind: "other",
      title: "Inkooporder",
      pdf_base64: upload.toString("base64"),
      requires_signature: true,
    });
    expect(r.status).toBe(201);
    const draft = K.PushDocumentResponse.parse(r.data).document;
    expect(draft.status).toBe("draft");
    expect(draft.page_count).toBe(2);
    // Drafts are not the customer's to see.
    expect((await call(w, "GET", `${C()}/documents/${draft.id}`, "admin")).status).toBe(404);
    const fieldsPath = `${S()}/documents/${draft.id}/fields`;
    expect((await call(w, "POST", `${S()}/documents/${draft.id}/send`, "staff", {})).status).toBe(
      422,
    );
    expect(
      (
        await call(w, "PUT", fieldsPath, "staff", {
          fields: [
            { page: 3, x: 0.1, y: 0.1, width: 0.2, height: 0.05, kind: "signature", label: "Sign" },
          ],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(w, "PUT", fieldsPath, "staff", {
          fields: [
            { page: 1, x: 0.9, y: 0.1, width: 0.2, height: 0.05, kind: "signature", label: "Sign" },
          ],
        })
      ).status,
    ).toBe(422);
    expect((await call(w, "PUT", fieldsPath, "admin", { fields: [] })).status).toBe(403);
    const set = await call(w, "PUT", fieldsPath, "staff", {
      fields: [
        {
          page: 2,
          x: 0.1,
          y: 0.8,
          width: 0.3,
          height: 0.06,
          kind: "signature",
          label: "Handtekening",
        },
        { page: 2, x: 0.1, y: 0.7, width: 0.4, height: 0.03, kind: "name", label: "Naam" },
        {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.05,
          height: 0.03,
          kind: "checkbox",
          label: "Akkoord met levering",
        },
      ],
    });
    const placed = K.DocumentFields.parse(set.data);
    expect(placed.fields.map((f) => f.kind)).toEqual(["checkbox", "name", "signature"]);
    expect(
      K.DocumentFields.parse((await call(w, "GET", fieldsPath, "staff")).data).fields,
    ).toHaveLength(3);
    const sent = K.DocumentDetail.parse(
      (
        await call(w, "POST", `${S()}/documents/${draft.id}/send`, "staff", {
          task: { title: "Teken de inkooporder" },
        })
      ).data,
    );
    expect(sent.status).toBe("sent");
    expect((await call(w, "PUT", fieldsPath, "staff", { fields: [] })).status).toBe(409);
    expect((await call(w, "POST", `${S()}/documents/${draft.id}/send`, "staff", {})).status).toBe(
      409,
    );
    const { body } = await signPayload(draft.id, "admin");
    expect((await call(w, "POST", `${C()}/documents/${draft.id}/sign`, "admin", body)).status).toBe(
      200,
    );
    expect(
      K.DocumentDetail.parse((await call(w, "GET", `${S()}/documents/${draft.id}`, "staff")).data)
        .signature?.values,
    ).toBeTruthy();

    expect(
      (
        await call(w, "POST", `${S()}/documents`, "staff", {
          kind: "other",
          title: "x",
          pdf_base64: Buffer.from("not a pdf at all").toString("base64"),
        })
      ).status,
    ).toBe(422);
    expect((await call(w, "POST", `${S()}/documents`, "staff", { kind: "other" })).status).toBe(
      422,
    );
  });

  test("the timeline and the card show all of it", async () => {
    const card = K.AccountCard.parse((await call(w, "GET", S(), "staff")).data);
    const types = new Set(card.timeline.map((e) => e.type));
    for (const t of [
      "document.sent",
      "document.signed",
      "document.declined",
      "billing_details.updated",
      "task.submitted",
      "ticket.opened",
    ])
      expect(types.has(t)).toBe(true);
    expect(card.documents.find((d) => d.id === offerId)?.signed_pdf_url).toBe(
      `/api/v2/admin/accounts/${w.orgId}/documents/${offerId}/signed.pdf`,
    );
    const rows = await w.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.account_signature);
    expect(rows[0]?.n).toBeGreaterThanOrEqual(4);
  });
});
