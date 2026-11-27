import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PlatformError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { and, eq } from "drizzle-orm";
import * as K from "../src/contract";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, pngB64, type World, world } from "./helpers";

// "Who signs" when someone is named already (staff named them when sending): the answer
// says what is true afterwards. "I sign" takes the earlier naming away, so the person
// answering signs and the earlier link stops; that changes who signs, so it is for owners
// and admins. Answering with the person already named changes nothing and emails nobody.
// Needs a scratch Postgres (TEST_DATABASE_ADMIN_URL).
const run = admin ? describe : describe.skip;
const DB = `accounts_who_signs_named_${process.pid}`;
const REFUSED = "room.name_signer_admins_only";

run("who signs, with a signer named already", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  const codeOf = (r: { data: unknown }) => (r.data as { code?: string }).code;
  const A = { name: "Antoine Burgers", email: "antoine@testdorp.example", role: "Wethouder" };
  const B = { name: "Bea Bakker", email: "bea@testdorp.example", role: null };
  let n = 0;

  /** An offer staff send with A named to sign it, its who-signs task and the DPA beside it. */
  async function sentWithA() {
    const r = await call(w, "POST", `${S()}/offers`, "staff", {
      template: "subscription",
      language: "nl",
      offer_name: "Gemeente Testdorp",
      person_name: "Anna",
      reference: `OFFER-WHO-SIGNS-${++n}`,
      items: [{ description: "Licentie", quantity: 1, unit_price_cents: 8600, vat_rate_bps: 2100 }],
      customer_signer: A,
    });
    expect(r.status).toBe(201);
    const offerId = K.PushOfferResponse.parse(r.data).document.id;
    const task = (await store.tasks(w.db, w.orgId)).find(
      (t) => t.code === "who_signs" && t.documentId === offerId,
    );
    const dpa = (await store.documents(w.db, w.orgId)).find(
      (x) => x.kind === "dpa" && ["sent", "viewed"].includes(x.status),
    );
    return { offerId, taskId: task?.id as string, dpaId: dpa?.id as string };
  }
  const answer = (taskId: string, as: keyof World["people"], body: Record<string, unknown>) =>
    call(w, "POST", `${C()}/tasks/${taskId}/who-signs`, as, {
      offer_signer: null,
      dpa_same: true,
      dpa_signer: null,
      dpia: false,
      ...body,
    });
  const doc = (id: string) => store.document(w.db, w.orgId, id);
  const mailsTo = (email: string) =>
    w.jobs
      .of("account.send-email")
      .filter(
        (m) =>
          (m as { to?: string }).to === email &&
          (m as { template?: string }).template === "account_signer_invite",
      ).length;
  const invitesOf = async (email: string) =>
    (
      await w.db
        .select({ id: schema.org_invite.id })
        .from(schema.org_invite)
        .where(and(eq(schema.org_invite.org_id, w.orgId), eq(schema.org_invite.email, email)))
    ).length;
  /** The newest signing link's token sent to `email`. */
  const tokenOf = (email: string) => {
    const mail = w.jobs
      .of("account.send-email")
      .filter((m) => (m as { to?: string }).to === email)
      .at(-1) as { data: { sign_url: string } } | undefined;
    return new URL(mail?.data.sign_url ?? "https://x.test").searchParams.get("invite") ?? "";
  };
  const linkWorks = async (docId: string, token: string) =>
    (await call(w, "GET", `${C()}/documents/${docId}/invite?invite=${token}`, null)).status === 200;
  const signerEvents = async (docId: string) =>
    (await store.events(w.db, w.orgId))
      .filter((e) => e.subjectId === docId && e.type.startsWith("document.signer_"))
      .map((e) => [e.type, e.actorKind]);

  async function sign(docId: string, as: keyof World["people"], name: string) {
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${docId}`, as)).data,
    );
    const values: Record<string, string | boolean> = {};
    for (const f of detail.fields) {
      if (f.kind === "name") values[f.id] = name;
      else if (f.kind === "role") values[f.id] = "Wethouder";
      else if (f.kind === "date") values[f.id] = "28-09-2026";
      else if (f.kind === "checkbox") values[f.id] = true;
      else if (f.kind === "text" && f.key !== "po_number")
        values[f.id] = f.key === "organisation" ? "Testdorp" : "n/a";
    }
    return call(w, "POST", `${C()}/documents/${docId}/sign`, as, {
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
  }

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    w.app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message, code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test('Billing answering "I sign" while A is named is refused whole, and A stays', async () => {
    const { offerId, taskId } = await sentWithA();
    const token = tokenOf(A.email);
    const r = await answer(taskId, "billing", {});
    expect([r.status, codeOf(r)]).toEqual([403, REFUSED]);
    expect((await doc(offerId))?.signerEmail).toBe(A.email);
    expect(await linkWorks(offerId, token)).toBe(true);
    expect((await store.task(w.db, w.orgId, taskId))?.status).toBe("open");
    // Only the DPA is Billing's to answer for themselves: A is not theirs to replace.
    const dpaOnly = await answer(taskId, "billing", { dpa_same: false });
    expect([dpaOnly.status, codeOf(dpaOnly)]).toEqual([403, REFUSED]);
    expect((await doc(offerId))?.signerEmail).toBe(A.email);
  });

  test("Billing keeps A and answers the rest: nothing about the offer's signer changes", async () => {
    const { offerId, taskId } = await sentWithA();
    const token = tokenOf(A.email);
    const before = mailsTo(A.email);
    const r = await answer(taskId, "billing", { offer_signer: A, dpa_same: false, dpia: true });
    expect(r.status).toBe(200);
    expect(K.Task.parse(r.data).status).toBe("done");
    expect((await doc(offerId))?.signerEmail).toBe(A.email);
    expect(mailsTo(A.email)).toBe(before);
    expect(await linkWorks(offerId, token)).toBe(true);
  });

  test("an admin naming A again changes nothing: no new invitation, no email, the link stands", async () => {
    const { offerId, taskId } = await sentWithA();
    const token = tokenOf(A.email);
    const mails = mailsTo(A.email);
    const invites = await invitesOf(A.email);
    const events = await signerEvents(offerId);
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    const r = await answer(taskId, "admin", { offer_signer: A, dpa_same: false });
    expect(r.status).toBe(200);
    expect(mailsTo(A.email)).toBe(mails);
    expect(await invitesOf(A.email)).toBe(invites);
    expect(await signerEvents(offerId)).toEqual(events);
    expect(await linkWorks(offerId, token)).toBe(true);
  });

  test("an admin naming B replaces A, as before", async () => {
    const { offerId, taskId } = await sentWithA();
    const token = tokenOf(A.email);
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    const r = await answer(taskId, "admin", { offer_signer: B, dpa_same: false });
    expect(r.status).toBe(200);
    expect((await doc(offerId))?.signerEmail).toBe(B.email);
    expect(await linkWorks(offerId, token)).toBe(false);
    // Newest first.
    expect(await signerEvents(offerId)).toEqual([
      ["document.signer_replaced", "customer"],
      ["document.signer_named", "staff"],
    ]);
  });

  test('an admin answering "I sign" takes A off: the link stops, the admin signs, the timeline says so', async () => {
    const { offerId, taskId, dpaId } = await sentWithA();
    const token = tokenOf(A.email);
    // The DPA has someone named too; "I sign" for both takes both off.
    expect((await call(w, "POST", `${S()}/documents/${dpaId}/signer`, "staff", B)).status).toBe(
      200,
    );
    const dpaToken = tokenOf(B.email);
    w.clock.now = new Date(w.clock.now.getTime() + 60_000);
    const r = await answer(taskId, "admin", {});
    expect(r.status).toBe(200);
    const task = K.Task.parse(r.data);
    expect(task.status).toBe("done");
    // The stored answer says what is true now.
    const stored = await store.task(w.db, w.orgId, taskId);
    expect(stored?.responseText).toContain("Offer: signed by admin (admin@example.test)");
    expect(stored?.responseText).toContain(`in place of ${A.name} (${A.email})`);
    expect((await doc(offerId))?.signerEmail).toBeNull();
    expect((await doc(dpaId))?.signerEmail).toBeNull();
    expect(await linkWorks(offerId, token)).toBe(false);
    expect(await linkWorks(dpaId, dpaToken)).toBe(false);
    const removed = (await store.events(w.db, w.orgId)).filter(
      (e) => e.subjectId === offerId && e.type === "document.signer_removed",
    );
    expect(removed.map((e) => [e.actorKind, e.detail])).toEqual([
      [
        "customer",
        { previous_email: A.email, previous_name: A.name, withdrawn_invite_ids: expect.any(Array) },
      ],
    ]);
    // A can no longer sign it; the admin can.
    expect(
      K.DocumentDetail.parse((await call(w, "GET", `${C()}/documents/${offerId}`, "admin")).data)
        .signer,
    ).toBeNull();
    expect((await sign(offerId, "admin", "Anna de Vries")).status).toBe(200);
    expect((await store.signatureOf(w.db, offerId))?.email).toBe("admin@example.test");
  });
});
