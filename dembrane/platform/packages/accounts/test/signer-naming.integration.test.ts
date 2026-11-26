import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { newId, PlatformError } from "@dembrane/core";
import { createDb, schema } from "@dembrane/db";
import { and, eq } from "drizzle-orm";
import * as K from "../src/contract";
import { nameSigner, remindSigner } from "../src/customer";
import { ensureUser } from "../src/prospect";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, pngB64, type World, world } from "./helpers";

// Naming someone to sign the offer or the DPA, and changing who signs, is for owners and
// admins: a signer who is not a member is invited into the organisation, and bringing
// someone new in is theirs to do, as on the Members page and in the data room. Billing
// keeps everything else: reading, signing themselves, answering "I sign", reminding the
// person already named. Each naming path, per role. Needs a scratch Postgres
// (TEST_DATABASE_ADMIN_URL).
const run = admin ? describe : describe.skip;
const DB = `accounts_signer_naming_${process.pid}`;
const REFUSED = "room.name_signer_admins_only";

type Who = keyof World["people"];

run("who may name a signer", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  const codeOf = (r: { data: unknown }) => (r.data as { code?: string }).code;
  const owner = "owner" as Who;
  const colleague = "colleague" as Who;

  /** A signed-in person with an account, optionally a member of the organisation. */
  async function person(key: string, email: string, role?: string): Promise<Who> {
    const u = await w.db.transaction((tx) =>
      ensureUser(tx, { email, name: key, passwordHash: null, nowIso: w.clock.now.toISOString() }),
    );
    await w.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.id, u.userId));
    if (role)
      await w.db
        .insert(schema.org_membership)
        .values({ id: newId(), org_id: w.orgId, user_id: u.appUserId, role });
    (w.people as Record<string, unknown>)[key] = {
      appUserId: u.appUserId,
      directusUserId: u.userId,
      isStaff: false,
      email,
    };
    return key as Who;
  }

  /**
   * A fresh offer and its who-signs question, and the DPA waiting with it: one per DPA text,
   * so every offer here shares it while it waits.
   */
  async function pushOffer() {
    const pushed = await call(w, "POST", `${S()}/offers`, "staff", {
      template: "subscription",
      language: "nl",
      offer_name: "Gemeente Testdorp",
      person_name: "Anna",
      items: [
        { description: "Licentie", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 },
      ],
    });
    expect(pushed.status).toBe(201);
    const offer = K.PushOfferResponse.parse(pushed.data).document;
    const docs = await store.documents(w.db, w.orgId);
    const dpa = docs.find((x) => x.kind === "dpa" && ["sent", "viewed"].includes(x.status));
    const task = (await store.tasks(w.db, w.orgId)).find(
      (t) => t.code === "who_signs" && t.documentId === offer.id,
    );
    expect(task?.status).toBe("open");
    return { offerId: offer.id, dpaId: dpa?.id as string, taskId: task?.id as string };
  }

  /** Fills and signs a document as `as`, from the document as they see it. */
  async function sign(docId: string, as: Who, name: string) {
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

  /** What a naming leaves behind for an address: the invitation and the signing email. */
  async function traces(email: string) {
    const invites = await w.db
      .select({ role: schema.org_invite.role })
      .from(schema.org_invite)
      .where(and(eq(schema.org_invite.org_id, w.orgId), eq(schema.org_invite.email, email)));
    const mails = w.jobs
      .of("account.send-email")
      .filter((m) => (m as { to?: string }).to === email);
    return { invites: invites.length, mails: mails.length };
  }

  const signerOf = async (docId: string) =>
    (await store.document(w.db, w.orgId, docId))?.signerEmail ?? null;
  const namings = async (docId: string) =>
    (await store.events(w.db, w.orgId)).filter(
      (e) => e.subjectId === docId && e.type.startsWith("document.signer_"),
    ).length;

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    // The error code next to the text, so a refusal is checked for the right reason.
    w.app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message, code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
    await person("owner", "owner@example.test", "owner");
    // A plain member, brought into the data room by an admin.
    await person("colleague", "colleague@example.test", "member");
    expect(
      (
        await call(w, "POST", `${C()}/room/people`, "admin", {
          email: "colleague@example.test",
          name: "Col League",
          labels: ["it_security"],
          other: null,
        })
      ).status,
    ).toBe(200);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("the signer route: owners and admins name and change the signer; Billing is refused with its own code and nothing changes", async () => {
    const { offerId, dpaId } = await pushOffer();
    const path = (docId: string) => `${C()}/documents/${docId}/signer`;
    const newcomer = { name: "New Comer", email: "newcomer@example.test", role: null };
    w.jobs.jobs.length = 0;

    // Billing, on the offer and on the DPA, before anyone is named.
    for (const docId of [offerId, dpaId]) {
      const r = await call(w, "POST", path(docId), "billing", newcomer);
      expect([r.status, codeOf(r)]).toEqual([403, REFUSED]);
      expect(await signerOf(docId)).toBeNull();
      expect(await namings(docId)).toBe(0);
    }
    expect(await traces("newcomer@example.test")).toEqual({ invites: 0, mails: 0 });
    // Not even themselves: naming is naming.
    const self = await call(w, "POST", path(offerId), "billing", {
      name: "billing",
      email: "billing@example.test",
      role: null,
    });
    expect([self.status, codeOf(self)]).toEqual([403, REFUSED]);
    expect(await signerOf(offerId)).toBeNull();

    // Those who never ran the account are refused as before.
    const member = await call(w, "POST", path(offerId), "member", newcomer);
    expect([member.status, codeOf(member)]).toEqual([403, "access.forbidden"]);
    const inRoom = await call(w, "POST", path(offerId), colleague, newcomer);
    expect([inRoom.status, codeOf(inRoom)]).toEqual([403, "access.forbidden"]);
    expect((await call(w, "POST", path(offerId), "signer", newcomer)).status).toBe(404);
    expect((await call(w, "POST", path(offerId), "outsider", newcomer)).status).toBe(404);
    expect(await signerOf(offerId)).toBeNull();

    // The owner names someone new, who is invited with the Billing role and emailed.
    expect((await call(w, "POST", path(offerId), owner, newcomer)).status).toBe(200);
    expect(await signerOf(offerId)).toBe("newcomer@example.test");
    expect(await traces("newcomer@example.test")).toEqual({ invites: 1, mails: 1 });

    // An admin changes who signs.
    const replacement = { name: "Other Person", email: "other@example.test", role: "Griffier" };
    expect((await call(w, "POST", path(offerId), "admin", replacement)).status).toBe(200);
    expect(await signerOf(offerId)).toBe("other@example.test");

    // Billing cannot change it back, or to anyone else.
    for (const who of [newcomer, { name: "Third", email: "third@example.test", role: null }]) {
      const r = await call(w, "POST", path(offerId), "billing", who);
      expect([r.status, codeOf(r)]).toEqual([403, REFUSED]);
    }
    expect(await signerOf(offerId)).toBe("other@example.test");
    expect(await traces("third@example.test")).toEqual({ invites: 0, mails: 0 });
    expect(await namings(offerId)).toBe(2);

    // The named signer, not a member, cannot pass the document on.
    expect((await call(w, "POST", path(offerId), "signer", newcomer)).status).toBe(404);
  });

  test("Billing keeps the rest: reading, reminding the person already named, and signing themselves", async () => {
    w.clock.now = new Date(w.clock.now.getTime() + 3_700_000);
    const named = await pushOffer();
    expect(
      (
        await call(w, "POST", `${C()}/documents/${named.offerId}/signer`, "admin", {
          name: "Taylor Lake",
          email: "taylor@example.test",
          role: null,
        })
      ).status,
    ).toBe(200);
    const id = named.offerId;
    expect((await call(w, "GET", C(), "billing")).status).toBe(200);
    expect((await call(w, "GET", `${C()}/documents/${id}`, "billing")).status).toBe(200);
    expect((await call(w, "GET", `${C()}/documents/${id}/file`, "billing")).status).toBe(200);
    const remind = await call(w, "POST", `${C()}/documents/${id}/signer/remind`, "billing", {});
    expect(remind.status).toBe(200);
    expect(K.NameSignerResponse.parse(remind.data).signer.email).toBe("taylor@example.test");
    // Nobody is named on this one, so Billing signs it themselves.
    const { offerId } = await pushOffer();
    expect((await sign(offerId, "billing", "Bram Jansen")).status).toBe(200);
    expect((await store.signatureOf(w.db, offerId))?.email).toBe("billing@example.test");
  });

  test('who signs: Billing answering "I sign" settles it; an answer by Billing that names anyone is refused whole, with nothing applied', async () => {
    const { offerId, dpaId, taskId } = await pushOffer();
    const path = `${C()}/tasks/${taskId}/who-signs`;
    const officer = { name: "Data Officer", email: "dpo@example.test", role: "FG" };
    const refusedAnswers = [
      // Someone else signs both.
      { offer_signer: officer, dpa_same: true, dpa_signer: null, dpia: false },
      // Billing signs the offer, someone else the DPA.
      { offer_signer: null, dpa_same: false, dpa_signer: officer, dpia: true },
      // Someone else signs the offer, Billing the DPA.
      { offer_signer: officer, dpa_same: false, dpa_signer: null, dpia: false },
    ];
    w.jobs.jobs.length = 0;
    for (const answer of refusedAnswers) {
      const r = await call(w, "POST", path, "billing", answer);
      expect([r.status, codeOf(r)]).toEqual([403, REFUSED]);
    }
    expect((await store.task(w.db, w.orgId, taskId))?.status).toBe("open");
    expect(await signerOf(offerId)).toBeNull();
    expect(await signerOf(dpaId)).toBeNull();
    expect(await namings(offerId)).toBe(0);
    expect(await namings(dpaId)).toBe(0);
    expect(await traces("dpo@example.test")).toEqual({ invites: 0, mails: 0 });
    expect(w.jobs.of("accounts.deliver-event")).toEqual([]);

    // Those who never ran the account are refused as before.
    const answer = { offer_signer: null, dpa_same: true, dpa_signer: null, dpia: false };
    expect((await call(w, "POST", path, "member", answer)).status).toBe(403);
    expect((await call(w, "POST", path, colleague, answer)).status).toBe(403);
    expect((await call(w, "POST", path, "signer", answer)).status).toBe(404);

    // "I sign", for both: answered, and nobody named.
    const r = await call(w, "POST", path, "billing", answer);
    expect(r.status).toBe(200);
    expect(K.Task.parse(r.data).status).toBe("done");
    expect(await signerOf(offerId)).toBeNull();
    expect(await signerOf(dpaId)).toBeNull();
  });

  test("who signs: owners and admins name someone else in their answer", async () => {
    for (const as of [owner, "admin"] as const) {
      const { offerId, dpaId, taskId } = await pushOffer();
      const email = `${as}-pick@example.test`;
      const r = await call(w, "POST", `${C()}/tasks/${taskId}/who-signs`, as, {
        offer_signer: { name: "Picked Person", email, role: null },
        dpa_same: true,
        dpa_signer: null,
        dpia: false,
      });
      expect(r.status).toBe(200);
      expect(await signerOf(offerId)).toBe(email);
      expect(await signerOf(dpaId)).toBe(email);
    }
  });

  test("a named signer who is not a member reaches and signs their one document as before", async () => {
    const { offerId } = await pushOffer();
    w.jobs.jobs.length = 0;
    expect(
      (
        await call(w, "POST", `${C()}/documents/${offerId}/signer`, owner, {
          name: "Signer Person",
          email: "signer@example.test",
          role: null,
        })
      ).status,
    ).toBe(200);
    const [mail] = w.jobs.of("account.send-email");
    expect((mail as { data: { sign_url: string } }).data.sign_url).toMatch(
      new RegExp(
        `^https://dash\\.test/o/${w.orgId}/account/documents/${offerId}/sign\\?invite=[\\w-]{32}$`,
      ),
    );
    const seen = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${offerId}`, "signer")).data,
    );
    expect(seen.access).toBe("signer");
    expect((await sign(offerId, "signer", "Signer Person")).status).toBe(200);
    expect((await store.signatureOf(w.db, offerId))?.email).toBe("signer@example.test");
  });

  test("may_name_signer tells the dashboard whether the caller may name a signer", async () => {
    const { offerId } = await pushOffer();
    w.clock.now = new Date(w.clock.now.getTime() + 3_700_000);
    expect(
      (
        await call(w, "POST", `${C()}/documents/${offerId}/signer`, "admin", {
          name: "Signer Person",
          email: "signer@example.test",
          role: null,
        })
      ).status,
    ).toBe(200);
    const onPage = async (as: Who) =>
      K.AccountPage.parse((await call(w, "GET", C(), as)).data).documents.find(
        (x) => x.id === offerId,
      )?.may_name_signer;
    const onDocument = async (as: Who, base = C()) =>
      K.DocumentDetail.parse((await call(w, "GET", `${base}/documents/${offerId}`, as)).data)
        .may_name_signer;
    for (const [as, may] of [
      [owner, true],
      ["admin", true],
      ["billing", false],
      [colleague, false],
    ] as const) {
      expect([as, await onPage(as)]).toEqual([as, may]);
      expect([as, await onDocument(as)]).toEqual([as, may]);
    }
    // The named signer reaches only the document; staff do not name signers here.
    expect(await onDocument("signer")).toBe(false);
    expect(await onDocument("staff", S())).toBe(false);
  });

  test("namings are limited per organisation, whoever of the owners and admins asks, and a refusal does not count", async () => {
    const { offerId } = await pushOffer();
    // An hour on, so the namings above no longer count to the limit.
    w.clock.now = new Date(w.clock.now.getTime() + 3_700_000);
    const path = `${C()}/documents/${offerId}/signer`;
    const first = { name: "First Person", email: "first@example.test", role: null };
    const second = { name: "Second Person", email: "second@example.test", role: null };
    for (let i = 0; i < 3; i++)
      expect((await call(w, "POST", path, "billing", first)).status).toBe(403);
    let status = 200;
    let made = 0;
    // Each naming changes who signs: naming the one already named costs nothing.
    for (let i = 0; i < 10 && status === 200; i++) {
      const who = i % 2 ? second : first;
      status = (await call(w, "POST", path, i % 2 ? "admin" : owner, who)).status;
      if (status === 200) made++;
    }
    expect([made, status]).toEqual([10, 200]);
    expect((await call(w, "POST", path, "admin", first)).status).toBe(429);
  });
  test("who signs: once the DPA no longer waits, an answer by Billing that names a DPA signer is still refused", async () => {
    // An hour on, past the limit the test above used up.
    w.clock.now = new Date(w.clock.now.getTime() + 3_700_000);
    const { dpaId } = await pushOffer();
    // The admin takes the DPA back and signs it, so the next offer goes out without one.
    expect(
      (
        await call(w, "POST", `${C()}/documents/${dpaId}/signer`, "admin", {
          name: "admin",
          email: "admin@example.test",
          role: null,
        })
      ).status,
    ).toBe(200);
    expect((await sign(dpaId, "admin", "Anna de Vries")).status).toBe(200);
    const next = await pushOffer();
    expect(next.dpaId).toBeUndefined();
    const path = `${C()}/tasks/${next.taskId}/who-signs`;
    const officer = { name: "Data Officer", email: "late-dpo@example.test", role: null };
    const r = await call(w, "POST", path, "billing", {
      offer_signer: null,
      dpa_same: false,
      dpa_signer: officer,
      dpia: false,
    });
    expect([r.status, codeOf(r)]).toEqual([403, REFUSED]);
    expect((await store.task(w.db, w.orgId, next.taskId))?.status).toBe("open");
    const ok = await call(w, "POST", path, "billing", {
      offer_signer: null,
      dpa_same: true,
      dpa_signer: null,
      dpia: false,
    });
    expect(ok.status).toBe(200);
  });

  test("naming and reminding a signer need no second connection, so a full pool cannot stall them", async () => {
    w.clock.now = new Date(w.clock.now.getTime() + 3_700_000);
    const { offerId } = await pushOffer();
    const single = createDb({ url: w.url, poolMax: 1 });
    const d = { ...w.deps, db: single.db, access: new Access(new DrizzleAccessStore(single.db)) };
    const done = (p: Promise<unknown>) =>
      Promise.race([p.then(() => "done"), Bun.sleep(5_000).then(() => "stalled")]);
    const email = "full-pool@example.test";
    try {
      const signer = { name: "Full Pool", email, role: null };
      expect(await done(nameSigner(d, w.people.admin, w.orgId, offerId, signer))).toBe("done");
      expect(await done(remindSigner(d, w.people.admin, w.orgId, offerId))).toBe("done");
      expect(await signerOf(offerId)).toBe(email);
      expect(await traces(email)).toEqual({ invites: 1, mails: 2 });
    } finally {
      await single.close();
    }
  });
});
