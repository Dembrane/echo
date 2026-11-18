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
import { admin, call, dropDatabase, type World, world } from "./helpers";

// Who brings someone new into the room: only owners and admins, as on the Members page,
// in every organisation. A workspace with inherit_organisation_members gives every plain
// member its projects and transcripts, so the answer says how many such workspaces the
// new person will reach. A colleague already a member is still anyone's in the room to
// add, and nobody takes a seat.
// Needs a scratch Postgres (TEST_DATABASE_ADMIN_URL).
const run = admin ? describe : describe.skip;
const DB = `accounts_room_workspaces_${process.pid}`;

type Who = keyof World["people"];

run("the room and the workspaces every member joins", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const codeOf = (r: { data: unknown }) => (r.data as { code?: string }).code;
  const asKees = "kees" as Who;
  const asOwner = "owner" as Who;
  let openToAll = "";

  const add = (as: Who, email: string, labels: string[] = []) =>
    call(w, "POST", `${C()}/room/people`, as, { email, name: "Some One", labels, other: null });
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
  const mailsTo = (email: string) => w.jobs.of("account.send-email").filter((m) => m.to === email);

  /** A workspace of the organisation, with the billing account the schema asks for. */
  async function workspace(visibility: string, settings: Record<string, unknown>) {
    const billingId = newId();
    await w.db
      .insert(schema.billing_account)
      .values({ id: billingId, org_id: w.orgId, tier: "free", payment_mode: "none" });
    const id = newId();
    await w.db.insert(schema.workspace).values({
      id,
      org_id: w.orgId,
      name: `Werkruimte ${visibility}`,
      billing_account_id: billingId,
      visibility,
      settings,
    });
    return id;
  }

  /** A signed-in member of the organisation with this role. */
  async function member(key: string, email: string, role: string) {
    const u = await w.db.transaction((tx) =>
      ensureUser(tx, { email, name: key, passwordHash: null, nowIso: w.clock.now.toISOString() }),
    );
    await w.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.id, u.userId));
    await w.db
      .insert(schema.org_membership)
      .values({ id: newId(), org_id: w.orgId, user_id: u.appUserId, role });
    (w.people as Record<string, unknown>)[key] = {
      appUserId: u.appUserId,
      directusUserId: u.userId,
      isStaff: false,
      email,
    };
  }

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    w.app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message, code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
    // Workspaces a new plain member would not reach: invite-only, and open to the
    // organisation's admins but not to every member.
    await workspace("invite_only", { inherit_organisation_members: true });
    await workspace("open_to_organisation", {});
    await member("owner", "owner@example.test", "owner");
    // Kees, a plain member, brought into the room by the admin.
    await member("kees", "kees@example.test", "member");
    expect((await add("admin", "kees@example.test", ["rollout"])).status).toBe(200);
  });
  // Ten additions an hour per organisation: each test starts in a fresh hour.
  beforeEach(() => {
    w.clock.now = new Date(w.clock.now.getTime() + 61 * 60_000);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("without a workspace every member joins, only owners and admins invite someone new", async () => {
    for (const [as, status] of [
      [asOwner, 200],
      ["admin", 200],
      ["billing", 403],
      [asKees, 403],
    ] as const) {
      const email = `eerst-${String(as)}@example.test`;
      const r = await add(as, email, ["it_security"]);
      expect([as, r.status]).toEqual([as, status]);
      if (status === 403) {
        expect([as, codeOf(r)]).toEqual([as, "room.new_person_admins_only"]);
        expect(await orgInvites(email)).toEqual([]);
        expect(mailsTo(email)).toEqual([]);
      } else {
        const res = K.AddRoomPersonResponse.parse(r.data);
        expect([as, res.status, res.workspaces_reached]).toEqual([as, "invited", 0]);
      }
    }
  });

  test("Billing and a room member still bring in a colleague who is a member already", async () => {
    for (const [as, email] of [
      [asKees, "member@example.test"],
      ["billing", "billing-brings@example.test"],
    ] as const) {
      if (email !== "member@example.test") await member("brought", email, "member");
      const r = await add(as, email, ["staff_stakeholders"]);
      expect([as, r.status]).toEqual([as, 200]);
      const res = K.AddRoomPersonResponse.parse(r.data);
      expect([res.status, res.workspaces_reached]).toEqual(["added", null]);
    }
    // And change what the colleague they brought in does.
    const again = await add(asKees, "member@example.test", ["staff_stakeholders", "rollout"]);
    expect(K.AddRoomPersonResponse.parse(again.data).status).toBe("updated");
  });

  test("with a workspace every member joins, the answer says how many they will reach", async () => {
    openToAll = await workspace("open_to_organisation", { inherit_organisation_members: true });
    const refused = await add(asKees, "ander@example.test", ["go_ahead"]);
    expect([refused.status, codeOf(refused)]).toEqual([403, "room.new_person_admins_only"]);
    for (const [as, email] of [
      ["admin", "nieuw@example.test"],
      [asOwner, "ander@example.test"],
    ] as const) {
      const r = await add(as, email, ["go_ahead"]);
      expect(r.status).toBe(200);
      const res = K.AddRoomPersonResponse.parse(r.data);
      expect([res.status, res.workspaces_reached]).toEqual(["invited", 1]);
    }
  });

  test("once accepted they reach that workspace by inheritance, and take no seat", async () => {
    const mail = mailsTo("nieuw@example.test").at(-1);
    const url = ((mail?.data ?? {}) as { room_url?: string }).room_url ?? "";
    const token = new URL(url).searchParams.get("invite") as string;
    const id = newId();
    await w.db.insert(schema.auth_user).values({
      id,
      name: "",
      email: "nieuw@example.test",
      emailVerified: true,
      createdAt: w.clock.now,
      updatedAt: w.clock.now,
    });
    await w.db.insert(schema.directus_users).values({ id, email: "nieuw@example.test" });
    (w.people as Record<string, unknown>).nieuw = {
      appUserId: null,
      directusUserId: id,
      isStaff: false,
      email: "nieuw@example.test",
    };
    const taken = await call(w, "POST", `${C()}/room/invite/accept`, "nieuw" as Who, {
      invite: token,
      first_name: "Nieuw",
      last_name: null,
    });
    expect(taken.status).toBe(200);
    const appUserId = (await store.appUserByDirectusId(w.db, id))?.id as string;
    // What the answer said: as a plain member they read the workspace every member joins.
    const reached = await w.deps.access.workspace(
      { appUserId, directusUserId: id },
      openToAll,
      "project:read",
    );
    expect(reached.role).toBe("member");
    // Seats are direct workspace rows; inheriting makes none.
    const rows = await w.db
      .select()
      .from(schema.workspace_membership)
      .where(eq(schema.workspace_membership.user_id, appUserId));
    expect(rows).toEqual([]);
  });
});
