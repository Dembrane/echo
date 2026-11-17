import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { newId, PlatformError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { and, eq, sql } from "drizzle-orm";
import * as K from "../src/contract";
import { ensureUser } from "../src/prospect";
import { accountsRoutes } from "../src/routes";
import { store } from "../src/storage";
import { admin, call, dropDatabase, png, pngB64, type World, world } from "./helpers";

// What the room shows and to whom, beyond the access table's main rows: someone invited
// shows no account of theirs before they accept; a room member sees only signing tasks and
// a signature without its details; the dashboard's own invitation list; removal of someone
// meanwhile named to sign; an inviter changing their own invitee; the owner column; the
// cells for a named signer, staff and a staff key; a named room member signing; two adds
// of one address at once. Needs a scratch Postgres (TEST_DATABASE_ADMIN_URL).
const run = admin ? describe : describe.skip;
const DB = `accounts_room_review_${process.pid}`;

type Who = keyof World["people"];

run("the room, as reviewed", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  const asKees = "kees" as Who;
  const asOwner = "owner" as Who;
  let offerId = "";
  let dpaId = "";

  const add = (as: Who, email: string, labels: string[] = [], name = "Typed Name") =>
    call(w, "POST", `${C()}/room/people`, as, { email, name, labels, other: null });
  const room = async (as: Who, path = `${C()}/room`) => {
    const r = await call(w, "GET", path, as);
    expect(r.status).toBe(200);
    return K.RoomPage.parse(r.data);
  };
  const orgInvites = (email: string) =>
    w.db
      .select()
      .from(schema.org_invite)
      .where(
        and(
          eq(schema.org_invite.org_id, w.orgId),
          sql`lower(${schema.org_invite.email}) = ${email}`,
        ),
      );
  const nameSigner = (docId: string, name: string, email: string) =>
    call(w, "POST", `${C()}/documents/${docId}/signer`, "admin", { name, email, role: null });

  /** A signed-in person with an account, optionally a member. */
  async function person(key: string, email: string, role?: string, name = key) {
    const u = await w.db.transaction((tx) =>
      ensureUser(tx, { email, name, passwordHash: null, nowIso: w.clock.now.toISOString() }),
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
    return u;
  }

  /** Fills and signs a document as `as`, from the document as `as` sees it. */
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
        values[f.id] = f.key === "organisation" ? "Testdorp" : "Dorpsstraat 1";
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
    await person("owner", "owner@example.test", "owner");
    await person("kees", "kees@example.test", "member");
    expect((await add("admin", "kees@example.test", ["rollout"])).status).toBe(200);
    // Someone with a dembrane account elsewhere, not a member here.
    await person("known", "known@example.test", undefined, "Known Person");
  });
  beforeEach(() => {
    w.clock.now = new Date(w.clock.now.getTime() + 61 * 60_000);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("someone invited shows no account of theirs before they accept", async () => {
    const known = await add(asKees, "known@example.test");
    const unknown = await add(asKees, "unknown@example.test");
    const [a, b] = [known, unknown].map((r) => K.AddRoomPersonResponse.parse(r.data));
    // The answer is the same whether the address has an account or not.
    for (const res of [a, b])
      expect([res?.status, res?.email_sent, res?.workspaces_reached]).toEqual(["invited", true, 0]);
    expect([a?.person.app_user_id, a?.person.name]).toEqual([null, "Typed Name"]);
    for (const [as, path] of [
      [asKees, `${C()}/room`],
      ["admin", `${C()}/room`],
      ["staff", `${S()}/room`],
    ] as const) {
      const p = (await room(as, path)).people.find((x) => x.email === "known@example.test");
      expect([as, p?.app_user_id, p?.name]).toEqual([as, null, "Typed Name"]);
    }
  });

  test("a room member sees only signing tasks, without anyone's answers", async () => {
    const upload = await call(w, "POST", `${S()}/tasks`, "staff", {
      title: "Send us the decision",
      kind: "upload",
      document_id: offerId,
    });
    expect(upload.status).toBe(201);
    const taskId = K.Task.parse(upload.data).id;
    const form = new FormData();
    form.set("response_text", "Besluit van het college");
    form.set("file", new File([png()], "besluit.png", { type: "image/png" }));
    const sent = await w.app.request(`${C()}/tasks/${taskId}/submit`, {
      method: "POST",
      headers: { "x-as": "admin" },
      body: form,
    });
    expect(sent.status).toBe(200);
    const back = await call(w, "POST", `${S()}/tasks/${taskId}/review`, "staff", {
      decision: "send_back",
      note: "Wrong file",
    });
    expect(back.status).toBe(200);
    // No route puts an answer on a signing task today, so one is written straight onto the
    // rows: the room member's copy must stay empty even if a later route does.
    await w.db
      .update(schema.account_task)
      .set({ responseText: "Signed by post", responseFileName: "scan.pdf", reviewNote: "Checked" })
      .where(and(eq(schema.account_task.orgId, w.orgId), eq(schema.account_task.kind, "sign")));
    const asAdmin = K.AccountPage.parse((await call(w, "GET", C(), "admin")).data);
    const answered = asAdmin.tasks.filter((t) => t.kind === "sign");
    expect(answered.length).toBeGreaterThan(0);
    for (const t of answered)
      expect([t.response_text, t.response_file_name, t.review_note]).toEqual([
        "Signed by post",
        "scan.pdf",
        "Checked",
      ]);
    const page = K.AccountPage.parse((await call(w, "GET", C(), asKees)).data);
    expect(page.tasks.length).toBeGreaterThan(0);
    expect(page.tasks.some((t) => t.id === taskId)).toBe(false);
    for (const t of page.tasks) {
      expect(t.kind).toBe("sign");
      expect([t.response_text, t.response_file_name, t.review_note]).toEqual([null, null, null]);
    }
  });

  test("a room member sees who signed and when, not the signer's details", async () => {
    expect((await sign(dpaId, "admin", "Anna de Vries")).status).toBe(200);
    const asAdmin = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${dpaId}`, "admin")).data,
    );
    expect(Object.keys(asAdmin.signature?.values ?? {}).length).toBeGreaterThan(0);
    const d = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${dpaId}`, asKees)).data,
    );
    expect(d.signature?.name).toBe("Anna de Vries");
    expect(d.signature?.signed_at).toBe(asAdmin.signature?.signed_at as string);
    expect([d.signature?.address, d.signature?.vat_number, d.signature?.values]).toEqual([
      null,
      null,
      {},
    ]);
    // The signed PDF itself stays readable.
    expect((await call(w, "GET", `${C()}/documents/${dpaId}/signed.pdf`, asKees)).status).toBe(200);
  });

  test("accepted through the dashboard's own invitation list, they are matched by verified address", async () => {
    expect((await add("admin", "listed@example.test")).status).toBe(200);
    // As the account package's acceptOrgInvite does: a membership, the invitation taken
    // up, and nothing written to the room's row.
    const u = await person("listed", "listed@example.test");
    await w.db
      .update(schema.auth_user)
      .set({ emailVerified: false })
      .where(eq(schema.auth_user.id, u.userId));
    await w.db
      .insert(schema.org_membership)
      .values({ id: newId(), org_id: w.orgId, user_id: u.appUserId, role: "member" });
    await w.db
      .update(schema.org_invite)
      .set({ accepted_at: w.clock.now.toISOString() })
      .where(sql`lower(${schema.org_invite.email}) = 'listed@example.test'`);
    const read = () => call(w, "GET", `${C()}/documents/${offerId}`, "listed" as Who);
    // Unverified, the address proves nothing.
    expect((await read()).status).toBe(403);
    await w.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.id, u.userId));
    const ok = await read();
    expect(ok.status).toBe(200);
    expect(K.DocumentDetail.parse(ok.data).access).toBe("room");
    // Another member's verified address reaches nothing.
    expect((await call(w, "GET", `${C()}/documents/${offerId}`, "member")).status).toBe(403);
  });

  test("taken out before accepting while named to sign: the Billing invitation comes back", async () => {
    const r = await add("admin", "named@example.test", ["go_ahead"]);
    const target = K.AddRoomPersonResponse.parse(r.data).person;
    expect((await nameSigner(offerId, "Named Person", "named@example.test")).status).toBe(200);
    // Naming made none: the room's invitation was waiting already.
    expect((await orgInvites("named@example.test")).map((i) => i.role)).toEqual(["member"]);
    const out = await call(w, "POST", `${C()}/room/people/${target.id}/remove`, "admin", {});
    expect(K.RemoveRoomPersonResponse.parse(out.data).membership).toBe("withdrawn");
    const live = (await orgInvites("named@example.test")).filter((i) => !i.deleted_at);
    expect(live.map((i) => i.role)).toEqual(["billing"]);
  });

  test("a room member changes what their own invitee does", async () => {
    expect((await add(asKees, "own@example.test", ["rollout"])).status).toBe(200);
    const again = await add(asKees, "own@example.test", ["rollout", "privacy_ai"]);
    expect(again.status).toBe(200);
    const res = K.AddRoomPersonResponse.parse(again.data);
    expect([res.status, res.person.labels]).toEqual(["updated", ["rollout", "privacy_ai"]]);
  });

  test("an owner runs the account and the room, as admins do", async () => {
    const page = K.AccountPage.parse((await call(w, "GET", C(), asOwner)).data);
    expect(page.access).toBe("account");
    expect((await call(w, "GET", `${C()}/billing`, asOwner)).status).toBe(200);
    const r = await room(asOwner);
    expect([r.me?.room, r.me?.may_dismiss_hints]).toEqual(["by_role", true]);
    expect((await call(w, "POST", `${C()}/room/hints/go_ahead/dismiss`, asOwner, {})).status).toBe(
      200,
    );
    expect((await add(asOwner, "by-owner@example.test")).status).toBe(200);
    expect((await call(w, "GET", `${S()}/room`, asOwner)).status).toBe(403);
  });

  test("a named signer, signed-in staff and a staff key reach nothing of the room", async () => {
    expect((await nameSigner(offerId, "Signer Person", "signer@example.test")).status).toBe(200);
    const someone = (await room("admin")).people.find((p) => p.email === "own@example.test");
    for (const as of ["signer", "staff", "key"] as const) {
      for (const [method, path, body] of [
        ["GET", `${C()}/room`, undefined],
        ["POST", `${C()}/room/people/${someone?.id}/remove`, {}],
        ["POST", `${C()}/room/me/labels`, { labels: [], other: null }],
        ["POST", `${C()}/room/hints/it_security/dismiss`, {}],
      ] as const) {
        const r = await call(w, method, path, as, body);
        expect([as, path, r.status]).toEqual([as, path, 404]);
      }
    }
  });

  test("the staff room page is for staff only, and each read is audited", async () => {
    for (const as of ["billing", asKees, "member", "signer"] as const)
      expect([as, (await call(w, "GET", `${S()}/room`, as)).status]).toEqual([as, 403]);
    const audited = async () =>
      (
        await w.db
          .select()
          .from(schema.staff_audit_event)
          .where(eq(schema.staff_audit_event.action, "accounts.room.read"))
      ).filter((e) => e.targetId === w.orgId).length;
    const before = await audited();
    await room("staff", `${S()}/room`);
    expect(await audited()).toBe(before + 1);
  });

  test("a room member named to sign signs as the signer", async () => {
    expect((await nameSigner(offerId, "kees", "kees@example.test")).status).toBe(200);
    const d = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${offerId}`, asKees)).data,
    );
    expect(d.access).toBe("signer");
    expect((await sign(offerId, asKees, "Kees Lid")).status).toBe(200);
    expect((await store.signatureOf(w.db, offerId))?.email).toBe("kees@example.test");
  });

  test("an admin whose labels someone else set answers the question once", async () => {
    expect((await add("billing", "admin@example.test", ["go_ahead"])).status).toBe(200);
    expect((await room("admin")).me?.labels_question).toBe(true);
    const r = await call(w, "POST", `${C()}/room/me/labels`, "admin", {
      labels: ["go_ahead", "contract_purchasing"],
      other: null,
    });
    expect(r.status).toBe(200);
    expect(K.RoomPerson.parse(r.data).labels).toEqual(["go_ahead", "contract_purchasing"]);
  });

  test("two adds of one new address at once make one row and one invitation", async () => {
    const [a, b] = await Promise.all([
      add("admin", "race@example.test", ["rollout"]),
      add("billing", "race@example.test", ["rollout"]),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const statuses = [a, b].map((r) => K.AddRoomPersonResponse.parse(r.data).status).sort();
    expect(statuses).toEqual(["invited", "updated"]);
    const rows = await w.db
      .select()
      .from(schema.account_room_person)
      .where(eq(schema.account_room_person.email, "race@example.test"));
    expect(rows).toHaveLength(1);
    expect(await orgInvites("race@example.test")).toHaveLength(1);
    expect(
      w.jobs.of("account.send-email").filter((m) => m.to === "race@example.test"),
    ).toHaveLength(1);
  });

  test("two invitations at once of someone whose invitation lapsed make one new invitation", async () => {
    expect((await add("admin", "lapsed@example.test", ["rollout"])).status).toBe(200);
    await w.db
      .update(schema.org_invite)
      .set({ expires_at: "2020-01-01T00:00:00.000Z" })
      .where(
        and(
          eq(schema.org_invite.org_id, w.orgId),
          sql`lower(${schema.org_invite.email}) = 'lapsed@example.test'`,
        ),
      );
    const [a, b] = await Promise.all([
      add("admin", "lapsed@example.test", ["rollout"]),
      add("billing", "lapsed@example.test", ["rollout"]),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const statuses = [a, b].map((r) => K.AddRoomPersonResponse.parse(r.data).status).sort();
    expect(statuses).toEqual(["invited", "updated"]);
    // The lapsed one and one new one.
    expect(await orgInvites("lapsed@example.test")).toHaveLength(2);
    expect(
      w.jobs.of("account.send-email").filter((m) => m.to === "lapsed@example.test"),
    ).toHaveLength(2);
  });
});
