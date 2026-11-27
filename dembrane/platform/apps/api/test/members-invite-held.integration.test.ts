import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { DrizzleAccessStore } from "@dembrane/access";
import { accountsRoutes, invitationHeld, contract as K } from "@dembrane/accounts";
import { newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { MemoryJobSink, tenancyRoutes } from "@dembrane/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import {
  admin,
  call,
  dropDatabase,
  type World,
  world,
} from "../../../packages/accounts/test/helpers";

// An owner or admin invites someone from the Members page whose only pending invitation
// was made by naming them to sign, or by bringing them into the data room. That invitation
// is withdrawn when the naming or the room ends, so the Members page replaces it with one
// of its own: the role the admin chose, never shorter-lived than the one it replaces, and
// withdrawn by nothing a signer or the room does. Both orders, for a naming and for the
// room, with the real Members route and the real accounts routes wired as apps/api wires
// them. Needs a scratch Postgres (TEST_DATABASE_ADMIN_URL).
const run = admin ? describe : describe.skip;
const DB = `api_members_invite_held_${process.pid}`;

run("a Members invitation of someone a naming or the room invited", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const tenancyJobs = new MemoryJobSink();
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  let n = 0;
  const fresh = (who: string) => `${who}-${++n}@testdorp.example`;
  const person = (email: string) => ({ name: email.split("@")[0] as string, email, role: null });

  const pushed = async () => {
    const r = await call(w, "POST", `${S()}/offers`, "staff", {
      template: "subscription",
      language: "nl",
      offer_name: "Gemeente Testdorp",
      person_name: "Anna",
      reference: `OFFER-MEMBERS-HELD-${++n}`,
      items: [
        { description: "Licentie", quantity: 12, unit_price_cents: 8600, vat_rate_bps: 2100 },
      ],
    });
    expect(r.status).toBe(201);
    return K.PushOfferResponse.parse(r.data).document;
  };
  const names = async (docId: string, email: string) => {
    const r = await call(w, "POST", `${C()}/documents/${docId}/signer`, "admin", person(email));
    expect(r.status).toBe(200);
  };
  const addToRoom = async (email: string) => {
    const r = await call(w, "POST", `${C()}/room/people`, "admin", {
      email,
      name: "Kamer Lid",
      labels: ["it_security"],
      other: null,
    });
    expect(r.status).toBe(200);
    return (r.data as { person: { id: string } }).person.id;
  };
  const takeOutOfRoom = async (id: string) => {
    const r = await call(w, "POST", `${C()}/room/people/${id}/remove`, "admin", {});
    expect(r.status).toBe(200);
  };
  /** The Members page's invite, as an owner or admin sends it. */
  const membersInvite = async (email: string, role: string) => {
    const r = await call(w, "POST", `/api/v2/orgs/${w.orgId}/invites`, "admin", { email, role });
    expect(r.status).toBe(200);
    return r.data as { status: string; email_sent: boolean };
  };

  /** Every invitation of the address still waiting: exactly one is the rule. */
  const waiting = (email: string) =>
    w.db
      .select()
      .from(schema.org_invite)
      .where(
        and(
          eq(schema.org_invite.org_id, w.orgId),
          eq(schema.org_invite.email, email),
          isNull(schema.org_invite.accepted_at),
          isNull(schema.org_invite.deleted_at),
        ),
      );
  const one = async (email: string) => {
    const rows = await waiting(email);
    expect(rows).toHaveLength(1);
    return rows[0] as (typeof rows)[number];
  };
  /** The Members page's invitation emails to the address. */
  const membersEmails = (email: string) =>
    tenancyJobs.jobs.filter((j) => (j.payload as { to?: string }).to === email);
  /** The accounts emails (signing, room) to the address. */
  const accountsEmails = (email: string) =>
    w.jobs.of("account.send-email").filter((m) => (m as { to?: string }).to === email);

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    // As apps/api/src/app.ts wires the Members page.
    w.app.route(
      "/",
      tenancyRoutes({
        db: w.db,
        accessStore: new DrizzleAccessStore(w.db),
        jobs: tenancyJobs,
        dashboardUrl: "https://dash.test",
        inviteSecret: "x".repeat(32),
        now: () => w.clock.now,
        invitationHeld: (orgId, email, id) => invitationHeld(w.db, orgId, email, id),
      }),
    );
  });
  // An hour on each time, so the namings per hour never run out.
  beforeEach(() => {
    w.clock.now = new Date(w.clock.now.getTime() + 3_700_000);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("named, then invited from Members: a fresh invitation in the admin's role that a new signer does not withdraw", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    const doc = await pushed();
    await names(doc.id, a);
    const naming = await one(a);
    expect(naming.role).toBe("billing");

    const answer = await membersInvite(a, "member");
    expect(answer).toMatchObject({ status: "invited", email_sent: true });
    const members = await one(a);
    expect(members.id).not.toBe(naming.id);
    expect(members.role).toBe("member");
    // Never shorter-lived than the naming's: the signing window still holds.
    expect(Date.parse(members.expires_at)).toBeGreaterThanOrEqual(Date.parse(naming.expires_at));
    expect(membersEmails(a)).toHaveLength(1);

    // Asked again from Members: the same invitation, nothing sent.
    expect(await membersInvite(a, "member")).toMatchObject({
      status: "already_invited",
      email_sent: false,
    });
    expect(membersEmails(a)).toHaveLength(1);

    await names(doc.id, b);
    expect((await one(a)).id).toBe(members.id);
    const replaced = (await w.db.select().from(schema.account_event)).find(
      (e) => e.subjectId === doc.id && e.type === "document.signer_replaced",
    );
    expect(replaced?.detail).toMatchObject({ withdrawn_invite_ids: [] });
    // One signing email to them, no more.
    expect(accountsEmails(a)).toHaveLength(1);
  });

  test("invited from Members, then named and replaced: the Members invitation stays the only one", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    await membersInvite(a, "billing");
    const members = await one(a);
    const doc = await pushed();
    await names(doc.id, a);
    expect((await one(a)).id).toBe(members.id);
    await names(doc.id, b);
    expect((await one(a)).id).toBe(members.id);
    expect(membersEmails(a)).toHaveLength(1);
    expect(accountsEmails(a)).toHaveLength(1);
  });

  test("brought into the room, then invited from Members: taking them out of the room leaves the Members invitation", async () => {
    const a = fresh("a");
    const row = await addToRoom(a);
    const room = await one(a);
    expect(await membersInvite(a, "admin")).toMatchObject({ status: "invited" });
    const members = await one(a);
    expect([members.id === room.id, members.role]).toEqual([false, "admin"]);
    await takeOutOfRoom(row);
    expect((await one(a)).id).toBe(members.id);
    expect(membersEmails(a)).toHaveLength(1);
    expect(accountsEmails(a)).toHaveLength(1);
  });

  test("brought into the room, then invited from Members as Billing: the room's link still works and they join as Billing", async () => {
    const a = fresh("a");
    await addToRoom(a);
    await membersInvite(a, "billing");
    const mail = accountsEmails(a).at(-1) as { data: { room_url: string } };
    const token = new URL(mail.data.room_url).searchParams.get("invite") as string;
    const id = newId();
    await w.db.insert(schema.auth_user).values({
      id,
      name: "",
      email: a,
      emailVerified: true,
      createdAt: w.clock.now,
      updatedAt: w.clock.now,
    });
    await w.db.insert(schema.directus_users).values({ id, email: a });
    (w.people as Record<string, unknown>).joiner = {
      appUserId: null,
      directusUserId: id,
      isStaff: false,
      email: a,
    };
    const taken = await call(w, "POST", `${C()}/room/invite/accept`, "joiner" as "admin", {
      invite: token,
      first_name: "Kamer",
      last_name: "Lid",
    });
    expect(taken.status).toBe(200);
    expect(await waiting(a)).toHaveLength(0);
    const [joined] = await w.db
      .select({ role: schema.org_membership.role })
      .from(schema.org_membership)
      .innerJoin(schema.app_user, eq(schema.app_user.id, schema.org_membership.user_id))
      .where(and(eq(schema.org_membership.org_id, w.orgId), eq(schema.app_user.email, a)));
    expect(joined?.role).toBe("billing");
  });

  test("invited from Members, then brought into the room and taken out: the Members invitation stays", async () => {
    const a = fresh("a");
    await membersInvite(a, "member");
    const members = await one(a);
    const row = await addToRoom(a);
    expect((await one(a)).id).toBe(members.id);
    await takeOutOfRoom(row);
    expect((await one(a)).id).toBe(members.id);
    expect(membersEmails(a)).toHaveLength(1);
  });

  test("named, in the room, then invited from Members: neither the room nor a new signer withdraws it", async () => {
    const [a, b] = [fresh("a"), fresh("b")];
    const doc = await pushed();
    await names(doc.id, a);
    const row = await addToRoom(a);
    await membersInvite(a, "member");
    const members = await one(a);
    await takeOutOfRoom(row);
    await names(doc.id, b);
    expect((await one(a)).id).toBe(members.id);
  });
});
