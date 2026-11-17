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

// The room and the workspaces every member joins (risk 1 of the data room design). A
// workspace with inherit_organisation_members gives every plain member its projects and
// transcripts, so in an organisation with one only those who run the account bring in
// someone who is not a member yet, and the answer says how many workspaces they will
// reach. A colleague already a member is still anyone's to add, and nobody takes a seat.
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
    // Kees, a plain member, brought into the room by the admin.
    const u = await w.db.transaction((tx) =>
      ensureUser(tx, {
        email: "kees@example.test",
        name: "kees",
        passwordHash: null,
        nowIso: w.clock.now.toISOString(),
      }),
    );
    await w.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.id, u.userId));
    await w.db
      .insert(schema.org_membership)
      .values({ id: newId(), org_id: w.orgId, user_id: u.appUserId, role: "member" });
    (w.people as Record<string, unknown>).kees = {
      appUserId: u.appUserId,
      directusUserId: u.userId,
      isStaff: false,
      email: "kees@example.test",
    };
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

  test("without a workspace every member joins, a room member invites someone new", async () => {
    const r = await add(asKees, "eerst@example.test", ["it_security"]);
    expect(r.status).toBe(200);
    const res = K.AddRoomPersonResponse.parse(r.data);
    expect([res.status, res.workspaces_reached]).toEqual(["invited", 0]);
  });

  test("with one, a room member cannot invite someone new, and nothing is made", async () => {
    openToAll = await workspace("open_to_organisation", { inherit_organisation_members: true });
    const r = await add(asKees, "nieuw@example.test", ["go_ahead"]);
    expect([r.status, codeOf(r)]).toEqual([403, "room.new_person_admins_only"]);
    expect(await orgInvites("nieuw@example.test")).toEqual([]);
    expect(mailsTo("nieuw@example.test")).toEqual([]);
    const page = K.RoomPage.parse((await call(w, "GET", `${C()}/room`, "admin")).data);
    expect(page.people.some((p) => p.email === "nieuw@example.test")).toBe(false);
  });

  test("a room member still brings in a colleague who is a member already", async () => {
    const r = await add(asKees, "member@example.test", ["staff_stakeholders"]);
    expect(r.status).toBe(200);
    const res = K.AddRoomPersonResponse.parse(r.data);
    expect([res.status, res.workspaces_reached]).toEqual(["added", null]);
    // Re-adding someone they invited before the workspace existed only changes labels.
    const again = await add(asKees, "eerst@example.test", ["it_security", "privacy_ai"]);
    expect(K.AddRoomPersonResponse.parse(again.data).status).toBe("updated");
  });

  test("an admin or Billing invites someone new and is told how many workspaces they reach", async () => {
    for (const [as, email] of [
      ["admin", "nieuw@example.test"],
      ["billing", "ander@example.test"],
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
