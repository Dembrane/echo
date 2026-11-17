import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { newId, PlatformError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import * as K from "../src/contract";
import { ensureUser } from "../src/prospect";
import { accountRecipients } from "../src/recipients";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, pngB64, type World, world } from "./helpers";

// The data room's access table, row by row: who reaches what of an organisation's account
// once colleagues can be brought into the room. Owners, admins and Billing keep everything
// they have today; a member without room access and a named signer who is not a member gain
// nothing; a member with room access reads the offer and the DPA and sees the room, and
// nothing about paying. Needs a scratch Postgres (TEST_DATABASE_ADMIN_URL).
const run = admin ? describe : describe.skip;
const DB = `accounts_room_access_${process.pid}`;

type Who = keyof World["people"];

run("data room access", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  const codeOf = (r: { data: unknown }) => (r.data as { code?: string }).code;
  let offerId = "";
  let dpaId = "";
  let invoiceId = "";
  let payTaskId = "";
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
   * Fills and signs a document as `as`, from the document as `readAs` sees it: a room
   * member sees no fields and nothing to confirm, so their attempt is built from an admin's.
   */
  async function sign(docId: string, as: Who, name: string, readAs: Who = as) {
    const detail = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${docId}`, readAs)).data,
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
    // The error code next to the text, so a refusal is checked for the right reason.
    w.app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message, code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
    expect(
      (
        await call(w, "PUT", `${C()}/billing`, "admin", {
          legal_name: "Gemeente Testdorp",
          billing_email: "finance@testdorp.example",
          address_line1: "Dorpsstraat 1",
          postal_code: "1234 AB",
          city: "Testdorp",
          country: "Netherlands",
          vat_id: "NL001234567B01",
        })
      ).status,
    ).toBe(200);
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
    offerId = K.PushOfferResponse.parse(pushed.data).document.id;
    dpaId = (await store.documents(w.db, w.orgId)).find((x) => x.kind === "dpa")?.id as string;
    expect(dpaId).toBeTruthy();
    const pdf = Buffer.from(await (await PDFDocument.create()).save()).toString("base64");
    const invoice = await call(w, "PUT", `${S()}/invoices/EX-ROOM-1`, "staff", {
      number: "2026-0501",
      issued_on: "2026-09-28",
      due_on: "2026-10-28",
      subtotal_cents: 103200,
      vat_cents: 21672,
      total_cents: 124872,
      status: "open",
      offer_id: offerId,
      pdf_base64: pdf,
    });
    expect(invoice.status).toBe(200);
    invoiceId = K.DocumentDetail.parse(invoice.data).id;
    const pay = await call(w, "POST", `${S()}/tasks`, "staff", {
      title: "Pay the first invoice",
      kind: "generic",
      document_id: invoiceId,
    });
    expect(pay.status).toBe(201);
    payTaskId = K.Task.parse(pay.data).id;
    // A colleague who is already a plain member, brought into the room by an admin. Not
    // asserted here, so each test below fails on its own while the room does not exist.
    await person("colleague", "colleague@example.test", "member");
    await call(w, "POST", `${C()}/room/people`, "admin", {
      email: "colleague@example.test",
      name: "Col League",
      labels: ["it_security"],
      other: null,
    });
    // Someone named to sign the DPA who is not a member.
    expect(
      (
        await call(w, "POST", `${C()}/documents/${dpaId}/signer`, "admin", {
          name: "Signer Person",
          email: "signer@example.test",
          role: null,
        })
      ).status,
    ).toBe(200);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("owners, admins and Billing keep what they have today, and see the room by their role", async () => {
    for (const as of ["admin", "billing"] as const) {
      const page = await call(w, "GET", C(), as);
      expect(page.status).toBe(200);
      const p = K.AccountPage.parse(page.data);
      expect(p.access).toBe("account");
      expect(p.documents.some((d) => d.id === invoiceId)).toBe(true);
      expect(p.tasks.some((t) => t.id === payTaskId)).toBe(true);
      expect(p.billing.legal_name).toBe("Gemeente Testdorp");
      expect(p.documents.find((d) => d.id === offerId)?.may_download).toBe(true);
      expect((await call(w, "GET", `${C()}/documents/${invoiceId}`, as)).status).toBe(200);
      expect((await call(w, "GET", `${C()}/billing`, as)).status).toBe(200);
      const detail = K.DocumentDetail.parse(
        (await call(w, "GET", `${C()}/documents/${offerId}`, as)).data,
      );
      expect([detail.access, detail.may_download]).toEqual(["member", true]);
      expect(detail.prefill.organisation).toBe("Gemeente Testdorp");
      const room = await call(w, "GET", `${C()}/room`, as);
      expect(room.status).toBe(200);
      const r = K.RoomPage.parse(room.data);
      expect(r.me?.room).toBe("by_role");
      expect(r.me?.may_dismiss_hints).toBe(true);
      // They also see the members who are not in the room, to bring them in.
      expect(r.people.find((x) => x.email === "member@example.test")?.room).toBe("none");
      expect(r.people.find((x) => x.email === "colleague@example.test")?.room).toBe("by_invite");
    }
  });

  test("a member without room access sees nothing of the account, the room included", async () => {
    const refusals: [string, string, unknown?][] = [
      ["GET", C()],
      ["GET", `${C()}/documents/${offerId}`],
      ["GET", `${C()}/documents/${offerId}/file`],
      ["GET", `${C()}/documents/${dpaId}`],
      ["GET", `${C()}/room`],
      [
        "POST",
        `${C()}/room/people`,
        { email: "friend@example.test", name: "Friend", labels: [], other: null },
      ],
      ["POST", `${C()}/room/me/labels`, { labels: ["rollout"], other: null }],
      ["POST", `${C()}/room/hints/go_ahead/dismiss`, {}],
    ];
    for (const [method, path, body] of refusals) {
      const r = await call(w, method, path, "member", body);
      expect([path, r.status]).toEqual([path, 403]);
    }
    expect(w.jobs.of("account.send-email").some((m) => m.to === "friend@example.test")).toBe(false);
  });

  test("a named signer who is not a member reaches their one document and nothing of the room", async () => {
    // The room exists for those it is for; the signer is not one of them.
    expect((await call(w, "GET", `${C()}/room`, "admin")).status).toBe(200);
    const dpa = await call(w, "GET", `${C()}/documents/${dpaId}`, "signer");
    expect(dpa.status).toBe(200);
    expect(K.DocumentDetail.parse(dpa.data).access).toBe("signer");
    for (const path of [
      C(),
      `${C()}/documents/${offerId}`,
      `${C()}/documents/${invoiceId}`,
      `${C()}/room`,
    ])
      expect([path, (await call(w, "GET", path, "signer")).status]).toEqual([path, 404]);
    const add = await call(w, "POST", `${C()}/room/people`, "signer", {
      email: "friend@example.test",
      name: "Friend",
      labels: [],
      other: null,
    });
    expect(add.status).toBe(404);
  });

  test("a member with room access reads the offer and the DPA, without billing details or a download", async () => {
    const page = await call(w, "GET", C(), colleague);
    expect(page.status).toBe(200);
    const p = K.AccountPage.parse(page.data);
    expect(p.access).toBe("room");
    expect(new Set(p.documents.map((d) => d.kind))).toEqual(new Set(["offer", "dpa"]));
    expect(p.documents.every((d) => d.may_download === false)).toBe(true);
    // Only the tasks about the offer and the DPA: nothing about paying or billing.
    const allowed = new Set([offerId, dpaId]);
    expect(p.tasks.length).toBeGreaterThan(0);
    expect(p.tasks.every((t) => t.document_id !== null && allowed.has(t.document_id))).toBe(true);
    expect(p.tasks.some((t) => t.kind === "billing_details" || t.id === payTaskId)).toBe(false);
    expect(Object.values(p.billing).every((v) => v === null)).toBe(true);
    expect(p.tickets).toEqual([]);
    expect(p.needs_form_reference).toBeNull();

    for (const id of [offerId, dpaId]) {
      const r = await call(w, "GET", `${C()}/documents/${id}`, colleague);
      expect(r.status).toBe(200);
      const d = K.DocumentDetail.parse(r.data);
      expect([d.access, d.may_download]).toEqual(["room", false]);
      // The billing details the signing form would prefill are not theirs to see.
      expect(d.prefill).toEqual({ organisation: null, address: null, po_number: null });
      // Nothing to fill in: they do not sign.
      expect(d.fields).toEqual([]);
      expect(d.confirmation).toBeNull();
      const file = await w.app.request(`${C()}/documents/${id}/file`, {
        headers: { "x-as": colleague },
      });
      // Reading needs the bytes; they come inline, never as an attachment.
      expect(file.status).toBe(200);
      expect(file.headers.get("content-disposition")).toStartWith("inline");
      expect(file.headers.get("cache-control")).toBe("private, no-store");
      // The texts the document pins: an offer its terms, the DPA only the DPA text.
      expect(d.legal.length).toBeGreaterThan(0);
      for (const pin of d.legal)
        expect(
          (await call(w, "GET", `${C()}/documents/${id}/legal/${pin.kind}`, colleague)).status,
        ).toBe(200);
      expect((await call(w, "POST", `${C()}/documents/${id}/view`, colleague, {})).status).toBe(
        200,
      );
    }
    const room = K.RoomPage.parse((await call(w, "GET", `${C()}/room`, colleague)).data);
    expect(room.me?.room).toBe("by_invite");
    expect(room.me?.may_dismiss_hints).toBe(false);
    // The room's people, not the members outside it.
    expect(room.people.some((x) => x.email === "member@example.test")).toBe(false);
    expect(room.people.some((x) => x.email === "admin@example.test")).toBe(true);
  });

  test("a member with room access cannot read invoices, billing or pay tasks, and cannot sign", async () => {
    // In the room, so every refusal below is the room's limit, not a missing membership.
    expect((await call(w, "GET", `${C()}/room`, colleague)).status).toBe(200);
    const refused: [string, string, unknown?][] = [
      ["GET", `${C()}/documents/${invoiceId}`],
      ["GET", `${C()}/documents/${invoiceId}/file`],
      ["GET", `${C()}/billing`],
      ["POST", `${C()}/peppol-lookup`, { vat_id: "NL001234567B01", kvk_number: null }],
      ["POST", `${C()}/tasks/${payTaskId}/submit`, { response_text: "Paid" }],
      [
        "POST",
        `${C()}/documents/${offerId}/signer`,
        { name: "Me", email: "colleague@example.test", role: null },
      ],
      ["POST", `${C()}/documents/${offerId}/signer/remind`, {}],
      ["POST", `${C()}/documents/${offerId}/decline`, { reason: "No" }],
      ["POST", `${C()}/tickets`, { subject: "Price", body: "Lower?" }],
    ];
    for (const [method, path, body] of refused) {
      const r = await call(w, method, path, colleague, body);
      expect([path, r.status]).toEqual([path, 403]);
    }
    const signing = await sign(offerId, colleague, "Col League", "admin");
    expect(signing.status).toBe(403);
    // Account emails (invoices, reminders) still go only to those who run the account.
    const to = (await accountRecipients(w.db, w.orgId)).map((r) => r.email);
    expect(to).not.toContain("colleague@example.test");
  });

  test("outsiders and signed-in staff see nothing on the customer side; a staff key never adds anyone", async () => {
    for (const as of ["outsider", "staff"] as const) {
      expect((await call(w, "GET", `${C()}/room`, as)).status).toBe(404);
      const add = await call(w, "POST", `${C()}/room/people`, as, {
        email: "friend@example.test",
        name: "Friend",
        labels: [],
        other: null,
      });
      expect(add.status).toBe(404);
    }
    const before = w.jobs.jobs.length;
    const key = await call(w, "POST", `${C()}/room/people`, "key", {
      email: "friend@example.test",
      name: "Friend",
      labels: [],
      other: null,
    });
    expect([key.status, codeOf(key)]).toEqual([403, "staff.key_cannot_email"]);
    expect(w.jobs.jobs.length).toBe(before);
  });

  test("staff read the room on the staff side, and customers cannot", async () => {
    for (const as of ["staff", "key"] as const) {
      const r = await call(w, "GET", `${S()}/room`, as);
      expect(r.status).toBe(200);
      const room = K.RoomPage.parse(r.data);
      expect(room.me).toBeNull();
      expect(room.people.find((x) => x.email === "colleague@example.test")?.labels).toEqual([
        "it_security",
      ]);
    }
    expect((await call(w, "GET", `${S()}/room`, "admin")).status).toBe(403);
  });

  test("once signed, a room member may download the signed copy, and still only reads", async () => {
    expect((await call(w, "GET", `${C()}/room`, colleague)).status).toBe(200);
    expect((await sign(offerId, "admin", "Anna de Vries")).status).toBe(200);
    const p = K.AccountPage.parse((await call(w, "GET", C(), colleague)).data);
    const offer = p.documents.find((d) => d.id === offerId);
    expect([offer?.status, offer?.may_download]).toEqual(["signed", true]);
    expect(p.documents.find((d) => d.id === dpaId)?.may_download).toBe(false);
    expect((await call(w, "GET", `${C()}/documents/${offerId}/signed.pdf`, colleague)).status).toBe(
      200,
    );
    expect((await call(w, "GET", `${C()}/documents/${invoiceId}`, colleague)).status).toBe(403);
  });
});
