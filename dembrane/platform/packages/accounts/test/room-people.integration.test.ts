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

// Who does what in the data room: adding a colleague in each case (someone new, a member
// already, an owner, admin or Billing member, the same address twice, a mistyped address),
// the invitation page and its acceptance, taking someone out before and after they accepted,
// the once-asked question about their own labels, the hints admins and Billing wave away,
// who signs as the signer model says, the PostHog events, and that nobody takes a seat.
// Needs a scratch Postgres (TEST_DATABASE_ADMIN_URL).
const run = admin ? describe : describe.skip;
const DB = `accounts_room_people_${process.pid}`;

type Who = keyof World["people"];
type Captured = { distinctId: string; event: string; properties: Record<string, unknown> };

run("who does what in the data room", () => {
  setDefaultTimeout(60_000);
  let w: World;
  const C = () => `/api/v2/orgs/${w.orgId}/account`;
  const S = () => `/api/v2/admin/accounts/${w.orgId}`;
  const codeOf = (r: { data: unknown }) => (r.data as { code?: string }).code;
  const captured: Captured[] = [];
  const events = (name: string) => captured.filter((e) => e.event === name);
  let offerId = "";
  let dpaId = "";
  // A member made in beforeAll; the world helper's people do not name them.
  const asKees = "kees" as Who;

  const add = (
    as: Who,
    email: string,
    labels: string[] = [],
    other: string | null = null,
    name = "Some One",
  ) => call(w, "POST", `${C()}/room/people`, as, { email, name, labels, other });
  const room = async (as: Who) => {
    const r = await call(w, "GET", `${C()}/room`, as);
    expect(r.status).toBe(200);
    return K.RoomPage.parse(r.data);
  };
  const personIn = async (as: Who, email: string) =>
    (await room(as)).people.find((p) => p.email === email);
  const mails = () => w.jobs.of("account.send-email");
  const mailTo = (email: string) => mails().filter((m) => m.to === email);
  const roomUrlOf = (mail: Record<string, unknown> | undefined) =>
    ((mail?.data ?? {}) as { room_url?: string }).room_url ?? "";
  const tokenOf = (mail: Record<string, unknown> | undefined) =>
    new URL(roomUrlOf(mail)).searchParams.get("invite") as string;
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

  /** A signed-in person with an account, optionally a member of the organisation. */
  async function person(
    key: string,
    email: string,
    opts: { role?: string; language?: string } = {},
  ): Promise<Who> {
    const u = await w.db.transaction((tx) =>
      ensureUser(tx, { email, name: key, passwordHash: null, nowIso: w.clock.now.toISOString() }),
    );
    await w.db
      .update(schema.auth_user)
      .set({ emailVerified: true })
      .where(eq(schema.auth_user.id, u.userId));
    if (opts.language)
      await w.db
        .update(schema.directus_users)
        .set({ language: opts.language })
        .where(eq(schema.directus_users.id, u.userId));
    if (opts.role)
      await w.db
        .insert(schema.org_membership)
        .values({ id: newId(), org_id: w.orgId, user_id: u.appUserId, role: opts.role });
    (w.people as Record<string, unknown>)[key] = {
      appUserId: u.appUserId,
      directusUserId: u.userId,
      isStaff: false,
      email,
    };
    return key as Who;
  }

  /**
   * Someone new after the six-digit code sign-in: an identity and a verified address, without
   * the app user onboarding makes (as the code sign-in leaves a named signer).
   */
  async function newcomer(key: string, email: string): Promise<Who> {
    const id = newId();
    await w.db.insert(schema.auth_user).values({
      id,
      name: "",
      email,
      emailVerified: true,
      createdAt: w.clock.now,
      updatedAt: w.clock.now,
    });
    await w.db.insert(schema.directus_users).values({ id, email });
    (w.people as Record<string, unknown>)[key] = {
      appUserId: null,
      directusUserId: id,
      isStaff: false,
      email,
    };
    return key as Who;
  }

  /** The session middleware resolves the app user on each request; after joining they have one. */
  async function refresh(key: Who) {
    const p = w.people[key];
    const appUser = await store.appUserByDirectusId(w.db, p.directusUserId);
    (w.people as Record<string, unknown>)[key] = { ...p, appUserId: appUser?.id ?? null };
  }

  /** Invites someone new as `as` and takes the invitation up as them. */
  async function inviteAndAccept(as: Who, key: string, email: string, labels: string[]) {
    const r = await add(as, email, labels, null, "New Person");
    expect(r.status).toBe(200);
    const token = tokenOf(mailTo(email).at(-1));
    const who = await newcomer(key, email);
    const taken = await call(w, "POST", `${C()}/room/invite/accept`, who, {
      invite: token,
      first_name: "New",
      last_name: "Person",
    });
    expect(taken.status).toBe(200);
    await refresh(who);
    return { who, person: K.AddRoomPersonResponse.parse(r.data).person, token };
  }

  beforeAll(async () => {
    w = await world(DB, accountsRoutes);
    w.app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message, code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
    // PostHog, as the API wires it: recorded here instead of sent.
    (w.deps as unknown as { capture: unknown }).capture = async (
      distinctId: string,
      event: string,
      properties: Record<string, unknown>,
    ) => {
      captured.push({ distinctId, event, properties });
    };
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
    await person("kees", "kees@example.test", { role: "member", language: "en-US" });
  });
  // Ten additions an hour per organisation: each test starts in a fresh hour.
  beforeEach(() => {
    w.clock.now = new Date(w.clock.now.getTime() + 61 * 60_000);
  });
  afterAll(async () => {
    await w?.close();
    await dropDatabase(DB);
  });

  test("someone new: a pending invitation, one email in the organisation's language, nothing for sam", async () => {
    w.jobs.jobs.length = 0;
    const r = await add("admin", "Noor@Example.test", ["go_ahead", "privacy_ai"], "Wethouder");
    expect(r.status).toBe(200);
    const res = K.AddRoomPersonResponse.parse(r.data);
    expect([res.status, res.email_sent]).toEqual(["invited", true]);
    expect(res.person).toMatchObject({
      email: "noor@example.test",
      name: "Some One",
      status: "invited",
      room: "by_invite",
      org_role: null,
      app_user_id: null,
      labels: ["go_ahead", "privacy_ai"],
      other: "Wethouder",
      labels_answered_at: null,
    });
    expect(res.person.invited_by?.app_user_id).toBe(w.people.admin.appUserId as string);
    // One email: to them, in the language of the organisation's documents (they have no
    // account to take one from), with the link that opens their invitation.
    expect(w.jobs.jobs.map((j) => j.name)).toEqual(["account.send-email"]);
    const [mail] = mails();
    expect(mail).toMatchObject({
      to: "noor@example.test",
      template: "account_room_invite",
      language: "nl-NL",
    });
    expect(roomUrlOf(mail)).toMatch(
      new RegExp(`^https://dash\\.test/o/${w.orgId}/account/join\\?invite=[\\w-]{32}$`),
    );
    // The invitation is an ordinary pending one, as a member: that lets the code sign-in in.
    const [invite] = await orgInvites("noor@example.test");
    expect(invite).toMatchObject({
      role: "member",
      invited_by: w.people.admin.appUserId,
      accepted_at: null,
      deleted_at: null,
    });
    expect(await store.mayReceiveCode(w.db, "noor@example.test", w.clock.now)).toBe(true);
    // On the timeline, and in PostHog under the inviter, never with the invitee's address.
    expect((await store.events(w.db, w.orgId)).map((e) => e.type)).toContain("room.person_invited");
    const [ev] = events("server_room_person_invited");
    expect(ev?.distinctId).toBe("admin@example.test");
    expect(ev?.properties).toMatchObject({
      org_id: w.orgId,
      person_id: res.person.id,
      labels: ["go_ahead", "privacy_ai"],
      has_other: true,
      existing_member: false,
    });
    expect(JSON.stringify(ev?.properties)).not.toContain("noor@");
    // Everyone in the room sees them as invited.
    expect((await personIn("admin", "noor@example.test"))?.status).toBe("invited");
  });

  test("the invitation page greets them before sign-in; accepting makes them a member with room access", async () => {
    const token = tokenOf(mailTo("noor@example.test").at(-1));
    const page = `${C()}/room/invite`;
    const seen = await call(w, "GET", `${page}?invite=${token}`, null);
    expect(seen.status).toBe(200);
    expect(K.RoomInvite.parse(seen.data)).toEqual({
      organisation: { name: "Gemeente Testdorp" },
      inviter: { name: "admin" },
      person: { email: "noor@example.test", first_name: "Some", last_name: "One" },
      labels: ["go_ahead", "privacy_ai"],
      other: "Wethouder",
      status: "open",
      has_account: false,
    });
    const wrong = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect((await call(w, "GET", `${page}?invite=${wrong}`, null)).status).toBe(404);

    const noor = await newcomer("noor", "noor@example.test");
    const accept = { invite: token, first_name: "Noor", last_name: "Nieuw" };
    expect((await call(w, "POST", `${page}/accept`, null, accept)).status).toBe(401);
    const other = await call(w, "POST", `${page}/accept`, "admin", accept);
    expect([other.status, codeOf(other)]).toEqual([403, "invite.not_for_you"]);
    const taken = await call(w, "POST", `${page}/accept`, noor, accept);
    expect(taken.status).toBe(200);
    expect(K.AcceptRoomInviteResponse.parse(taken.data)).toEqual({ org_id: w.orgId });
    await refresh(noor);
    const appUserId = w.people[noor].appUserId as string;
    expect(appUserId).toBeTruthy();
    // An ordinary member now, with the name they confirmed; the invitation is taken up.
    expect(await store.orgMembership(w.db, w.orgId, appUserId)).toMatchObject({
      role: "member",
      deleted_at: null,
    });
    expect((await store.identity(w.db, w.people[noor].directusUserId))?.name).toBe("Noor Nieuw");
    expect((await orgInvites("noor@example.test"))[0]?.accepted_at).toBeTruthy();
    expect(K.AccountPage.parse((await call(w, "GET", C(), noor)).data).access).toBe("room");
    const me = await personIn(noor, "noor@example.test");
    expect([me?.status, me?.org_role, me?.app_user_id]).toEqual(["member", "member", appUserId]);
    // The link has done its work.
    const after = K.RoomInvite.parse((await call(w, "GET", `${page}?invite=${token}`, null)).data);
    expect(after.status).toBe("accepted");
    const [ev] = events("server_room_invite_accepted");
    expect(ev?.distinctId).toBe("noor@example.test");
    expect(ev?.properties).toMatchObject({ org_id: w.orgId, person_id: me?.id });
  });

  test("on first entry they are asked once whether their labels are right, and may correct their own", async () => {
    const noor = "noor" as Who;
    const before = await room(noor);
    expect(before.me?.labels_question).toBe(true);
    const r = await call(w, "POST", `${C()}/room/me/labels`, noor, {
      labels: ["go_ahead", "it_security"],
      other: null,
    });
    expect(r.status).toBe(200);
    const mine = K.RoomPerson.parse(r.data);
    expect([mine.labels, mine.other]).toEqual([["go_ahead", "it_security"], null]);
    expect(mine.labels_answered_at).toBe(w.clock.now.toISOString());
    expect((await room(noor)).me?.labels_question).toBe(false);
    const [ev] = events("server_room_labels_corrected");
    expect(ev?.distinctId).toBe("noor@example.test");
    expect(ev?.properties).toMatchObject({
      org_id: w.orgId,
      person_id: mine.id,
      labels: ["go_ahead", "it_security"],
      added: ["it_security"],
      removed: ["privacy_ai"],
      other_changed: true,
    });
    // Once: the answer is recorded and not asked again.
    const again = await call(w, "POST", `${C()}/room/me/labels`, noor, {
      labels: ["rollout"],
      other: null,
    });
    expect([again.status, codeOf(again)]).toEqual([409, "room.labels_already_answered"]);
    expect((await personIn("admin", "noor@example.test"))?.labels).toEqual([
      "go_ahead",
      "it_security",
    ]);
    // Only someone brought in by someone else is asked.
    const byRole = await call(w, "POST", `${C()}/room/me/labels`, "admin", {
      labels: ["go_ahead"],
      other: null,
    });
    expect([byRole.status, codeOf(byRole)]).toEqual([409, "room.no_labels_question"]);
  });

  test("a member already: room access and labels at once, an email in their own language, no invitation", async () => {
    w.jobs.jobs.length = 0;
    const r = await add("billing", "kees@example.test", ["rollout"]);
    expect(r.status).toBe(200);
    const res = K.AddRoomPersonResponse.parse(r.data);
    expect([res.status, res.email_sent]).toEqual(["added", true]);
    expect(res.person).toMatchObject({
      status: "member",
      room: "by_invite",
      org_role: "member",
      app_user_id: w.people[asKees].appUserId,
      // Their own name, not the one typed.
      name: "kees",
      labels: ["rollout"],
    });
    expect(await orgInvites("kees@example.test")).toEqual([]);
    const [mail] = mailTo("kees@example.test");
    expect(mail).toMatchObject({ template: "account_room_invite", language: "en-US" });
    // A member signs in as always: the link is the account itself.
    expect(roomUrlOf(mail)).toBe(`https://dash.test/o/${w.orgId}/account`);
    expect(K.AccountPage.parse((await call(w, "GET", C(), asKees)).data).access).toBe("room");
    const ev = events("server_room_person_invited").at(-1);
    expect([ev?.distinctId, ev?.properties.existing_member]).toEqual([
      "billing@example.test",
      true,
    ]);
    // Confirming the labels as they are is an answer, and no correction.
    const corrections = events("server_room_labels_corrected").length;
    const ok = await call(w, "POST", `${C()}/room/me/labels`, asKees, {
      labels: ["rollout"],
      other: null,
    });
    expect(ok.status).toBe(200);
    expect(K.RoomPerson.parse(ok.data).labels_answered_at).toBeTruthy();
    expect(events("server_room_labels_corrected")).toHaveLength(corrections);
  });

  test("owners, admins and Billing are in by their role: adding them only sets their labels", async () => {
    w.jobs.jobs.length = 0;
    const invitedBefore = events("server_room_person_invited").length;
    // Those who run the account set each other's labels; a room member who did not invite
    // them does not.
    const byKees = await add(asKees, "billing@example.test", ["go_ahead"]);
    expect([byKees.status, codeOf(byKees)]).toEqual([403, "room.manage_forbidden"]);
    const r = await add("admin", "billing@example.test", ["contract_purchasing"]);
    expect(r.status).toBe(200);
    const res = K.AddRoomPersonResponse.parse(r.data);
    expect([res.status, res.email_sent]).toEqual(["updated", false]);
    expect(res.person).toMatchObject({
      room: "by_role",
      org_role: "billing",
      labels: ["contract_purchasing"],
    });
    expect(w.jobs.jobs).toEqual([]);
    expect(await orgInvites("billing@example.test")).toEqual([]);
    // Nobody was invited, so no invitation event.
    expect(events("server_room_person_invited")).toHaveLength(invitedBefore);
  });

  test("the same address twice keeps one invitation and sends nothing new", async () => {
    w.jobs.jobs.length = 0;
    expect((await add("admin", "dubbel@example.test", ["rollout"])).status).toBe(200);
    const again = await add("billing", "DUBBEL@example.test", ["rollout", "staff_stakeholders"]);
    expect(again.status).toBe(200);
    const res = K.AddRoomPersonResponse.parse(again.data);
    expect([res.status, res.email_sent]).toEqual(["updated", false]);
    expect(res.person.labels).toEqual(["rollout", "staff_stakeholders"]);
    expect(await orgInvites("dubbel@example.test")).toHaveLength(1);
    expect(mailTo("dubbel@example.test")).toHaveLength(1);
    // What someone already in the room does is changed by them, their inviter, an admin or
    // Billing; not by any other colleague.
    const byOther = await add(asKees, "dubbel@example.test", ["go_ahead"]);
    expect([byOther.status, codeOf(byOther)]).toEqual([403, "room.manage_forbidden"]);
    expect((await personIn("admin", "dubbel@example.test"))?.labels).toEqual([
      "rollout",
      "staff_stakeholders",
    ]);
  });

  test("a mistyped address, an unknown label or yourself is refused before anything is made", async () => {
    w.jobs.jobs.length = 0;
    const invites = async () => (await w.db.select().from(schema.org_invite)).length;
    const count = await invites();
    for (const body of [
      { email: "piet@@example", name: "Piet", labels: [], other: null },
      { email: "", name: "Piet", labels: [], other: null },
      { email: "piet@example.test", name: "", labels: [], other: null },
      // There is no "will use it", and "kept informed" is having no label.
      { email: "piet@example.test", name: "Piet", labels: ["uses"], other: null },
      { email: "piet@example.test", name: "Piet", labels: ["informed"], other: null },
      { email: "piet@example.test", name: "Piet", labels: ["other"], other: null },
      { email: "piet@example.test", name: "Piet", labels: [], other: "x".repeat(81) },
    ]) {
      const r = await call(w, "POST", `${C()}/room/people`, "admin", body);
      expect([JSON.stringify(body).slice(0, 60), r.status]).toEqual([
        JSON.stringify(body).slice(0, 60),
        422,
      ]);
    }
    const self = await add(asKees, "Kees@example.test", ["rollout"]);
    expect([self.status, codeOf(self)]).toEqual([400, "invite.self"]);
    expect(await invites()).toBe(count);
    expect(w.jobs.jobs).toEqual([]);
  });

  test("taken out before accepting: the invitation and its link are withdrawn", async () => {
    expect((await add("admin", "weg@example.test", ["go_ahead"])).status).toBe(200);
    const token = tokenOf(mailTo("weg@example.test").at(-1));
    const target = await personIn("admin", "weg@example.test");
    const path = `${C()}/room/people/${target?.id}/remove`;
    // Not by another colleague in the room, nor a member outside it.
    const byKees = await call(w, "POST", path, asKees, {});
    expect([byKees.status, codeOf(byKees)]).toEqual([403, "room.remove_forbidden"]);
    expect((await call(w, "POST", path, "member", {})).status).toBe(403);
    expect((await call(w, "POST", path, "outsider", {})).status).toBe(404);
    const r = await call(w, "POST", path, "admin", {});
    expect(r.status).toBe(200);
    expect(K.RemoveRoomPersonResponse.parse(r.data)).toEqual({
      status: "removed",
      membership: "withdrawn",
    });
    expect((await orgInvites("weg@example.test"))[0]?.deleted_at).toBeTruthy();
    expect((await call(w, "GET", `${C()}/room/invite?invite=${token}`, null)).status).toBe(404);
    expect(await store.mayReceiveCode(w.db, "weg@example.test", w.clock.now)).toBe(false);
    expect(await personIn("admin", "weg@example.test")).toBeUndefined();
    expect((await call(w, "POST", path, "admin", {})).status).toBe(404);
    const ev = events("server_room_person_removed").at(-1);
    expect(ev?.distinctId).toBe("admin@example.test");
    expect(ev?.properties).toMatchObject({
      org_id: w.orgId,
      person_id: target?.id,
      by: "admin",
      accepted: false,
    });
    expect((await store.events(w.db, w.orgId)).map((e) => e.type)).toContain("room.person_removed");
  });

  test("taken out after accepting, by their inviter: room access and labels go, the membership stays", async () => {
    // An admin invites someone new, who accepts, and takes them out again.
    const { who: lisa, person } = await inviteAndAccept("admin", "lisa", "lisa@example.test", [
      "staff_stakeholders",
    ]);
    expect((await call(w, "GET", C(), lisa)).status).toBe(200);
    const out = await call(w, "POST", `${C()}/room/people/${person.id}/remove`, "admin", {});
    expect(K.RemoveRoomPersonResponse.parse(out.data).membership).toBe("kept");
    expect(events("server_room_person_removed").at(-1)?.properties).toMatchObject({
      by: "admin",
      accepted: true,
    });
    // A colleague in the room brings her back in, now a member, and takes her out.
    const back = await add(asKees, "lisa@example.test", ["staff_stakeholders"]);
    expect(K.AddRoomPersonResponse.parse(back.data).status).toBe("added");
    const again = K.AddRoomPersonResponse.parse(back.data).person;
    const r = await call(w, "POST", `${C()}/room/people/${again.id}/remove`, asKees, {});
    expect(r.status).toBe(200);
    expect(K.RemoveRoomPersonResponse.parse(r.data).membership).toBe("kept");
    const appUserId = w.people[lisa].appUserId as string;
    expect(await store.orgMembership(w.db, w.orgId, appUserId)).toMatchObject({
      role: "member",
      deleted_at: null,
    });
    // Back to a member without room access: nothing of the account.
    expect((await call(w, "GET", C(), lisa)).status).toBe(403);
    expect((await call(w, "GET", `${C()}/room`, lisa)).status).toBe(403);
    const seen = await personIn("admin", "lisa@example.test");
    expect([seen?.room, seen?.labels, seen?.other]).toEqual(["none", [], null]);
    expect(events("server_room_person_removed").at(-1)?.properties).toMatchObject({
      by: "inviter",
      accepted: true,
    });
  });

  test("an admin or Billing member takes out someone who was a member before; the membership stays", async () => {
    // A member already, brought in by a colleague in the room.
    await person("tijn", "tijn@example.test", { role: "member" });
    const invited = await add(asKees, "tijn@example.test", ["rollout"]);
    expect(invited.status).toBe(200);
    const tijn = K.AddRoomPersonResponse.parse(invited.data).person;
    const kees = await personIn("admin", "kees@example.test");
    expect(kees?.room).toBe("by_invite");
    const r = await call(w, "POST", `${C()}/room/people/${kees?.id}/remove`, "billing", {});
    expect(r.status).toBe(200);
    expect(K.RemoveRoomPersonResponse.parse(r.data).membership).toBe("kept");
    expect(
      await store.orgMembership(w.db, w.orgId, w.people[asKees].appUserId as string),
    ).toMatchObject({ role: "member", deleted_at: null });
    expect((await call(w, "GET", C(), asKees)).status).toBe(403);
    // An inviter out of the room keeps no say over the people they brought in.
    expect((await call(w, "POST", `${C()}/room/people/${tijn.id}/remove`, asKees, {})).status).toBe(
      403,
    );
    expect((await personIn("admin", "tijn@example.test"))?.room).toBe("by_invite");
    // Brought back in, they read the room again.
    expect(
      K.AddRoomPersonResponse.parse((await add("admin", "kees@example.test")).data).status,
    ).toBe("added");
    expect((await call(w, "GET", C(), asKees)).status).toBe(200);
  });

  test("people in by their role cannot be taken out of the room", async () => {
    const billing = await personIn("admin", "billing@example.test");
    // Billing has a row for the labels set earlier; the role is what lets them in.
    expect(billing?.id).toBeTruthy();
    const r = await call(w, "POST", `${C()}/room/people/${billing?.id}/remove`, "admin", {});
    expect([r.status, codeOf(r)]).toEqual([409, "room.in_by_role"]);
  });

  test("admins and Billing wave away a hint per label, for their organisation only", async () => {
    const path = (label: string) => `${C()}/room/hints/${label}/dismiss`;
    const r = await call(w, "POST", path("go_ahead"), "admin", {});
    expect(r.status).toBe(200);
    expect(K.DismissHintResponse.parse(r.data).dismissed_hints).toEqual(["go_ahead"]);
    expect((await call(w, "POST", path("it_security"), "billing", {})).status).toBe(200);
    // Twice is the same as once.
    expect((await call(w, "POST", path("go_ahead"), "billing", {})).status).toBe(200);
    expect(new Set((await room("noor" as Who)).dismissed_hints)).toEqual(
      new Set(["go_ahead", "it_security"]),
    );
    // Not by a colleague in the room, a member outside it, or an outsider.
    expect((await call(w, "POST", path("privacy_ai"), "noor" as Who, {})).status).toBe(403);
    expect((await call(w, "POST", path("privacy_ai"), "member", {})).status).toBe(403);
    expect((await call(w, "POST", path("privacy_ai"), "outsider", {})).status).toBe(404);
    // Only the four labels whose absence can stop a deal have a hint.
    for (const label of ["rollout", "staff_stakeholders", "other", "nonsense"])
      expect((await call(w, "POST", path(label), "admin", {})).status).toBe(422);
    // The other organisation (the outsider runs it) is untouched.
    const elsewhere = await call(w, "GET", `/api/v2/orgs/${w.otherOrgId}/account/room`, "outsider");
    expect(elsewhere.status).toBe(200);
    expect(K.RoomPage.parse(elsewhere.data).dismissed_hints).toEqual([]);
    const timeline = (await store.events(w.db, w.orgId)).filter(
      (e) => e.type === "room.hint_dismissed",
    );
    expect(timeline.length).toBeGreaterThanOrEqual(2);
  });

  test("the listing says who signs the offer and the DPA, as the signer model has it", async () => {
    let r = await room("admin");
    // No one named: whoever runs the account signs.
    expect(r.signers).toEqual({ offer: null, dpa: null });
    const name = (docId: string, who: { name: string; email: string }) =>
      call(w, "POST", `${C()}/documents/${docId}/signer`, "admin", { ...who, role: null });
    expect((await name(offerId, { name: "kees", email: "kees@example.test" })).status).toBe(200);
    expect((await name(dpaId, { name: "Noor", email: "noor@example.test" })).status).toBe(200);
    r = await room(asKees);
    expect([r.signers.offer?.email, r.signers.offer?.document_id]).toEqual([
      "kees@example.test",
      offerId,
    ]);
    expect([r.signers.dpa?.email, r.signers.dpa?.document_id]).toEqual([
      "noor@example.test",
      dpaId,
    ]);
    expect(r.people.find((p) => p.email === "kees@example.test")?.signs).toEqual(["offer"]);
    expect(r.people.find((p) => p.email === "noor@example.test")?.signs).toEqual(["dpa"]);
    // Named, a room member reaches that one document as its signer; the other as a reader.
    const asSigner = K.DocumentDetail.parse(
      (await call(w, "GET", `${C()}/documents/${dpaId}`, "noor" as Who)).data,
    );
    expect(asSigner.access).toBe("signer");
    expect(asSigner.fields.length).toBeGreaterThan(0);
    expect(
      K.DocumentDetail.parse(
        (await call(w, "GET", `${C()}/documents/${offerId}`, "noor" as Who)).data,
      ).access,
    ).toBe("room");
    // One holder per document: naming another person moves the duty.
    expect((await name(offerId, { name: "Dubbel", email: "dubbel@example.test" })).status).toBe(
      200,
    );
    r = await room("admin");
    expect(r.signers.offer?.email).toBe("dubbel@example.test");
    expect(r.people.find((p) => p.email === "kees@example.test")?.signs).toEqual([]);
    expect(r.people.find((p) => p.email === "dubbel@example.test")?.signs).toEqual(["offer"]);
  });

  test("nobody in the room takes a seat or shows up as one", async () => {
    const people = (await room("admin")).people.filter((p) => p.room === "by_invite");
    expect(people.length).toBeGreaterThan(0);
    for (const p of people) {
      if (p.app_user_id) {
        const rows = await w.db
          .select()
          .from(schema.workspace_membership)
          .where(eq(schema.workspace_membership.user_id, p.app_user_id));
        expect([p.email, rows]).toEqual([p.email, []]);
        expect(
          (await store.orgMembership(w.db, w.orgId, p.app_user_id))?.role === "member" ||
            p.org_role === "member",
        ).toBe(true);
      }
      const wsInvites = await w.db
        .select()
        .from(schema.workspace_invite)
        .where(sql`lower(${schema.workspace_invite.email}) = ${p.email}`);
      expect([p.email, wsInvites]).toEqual([p.email, []]);
    }
    // A plain member's invitation: the room never makes a Billing one.
    for (const invite of await w.db
      .select()
      .from(schema.org_invite)
      .where(eq(schema.org_invite.org_id, w.orgId)))
      expect([invite.email, invite.role]).toEqual([invite.email, "member"]);
  });

  test("ten additions an hour per organisation", async () => {
    for (let i = 0; i < 10; i++)
      expect((await add("admin", `many${i}@example.test`)).status).toBe(200);
    const r = await add("admin", "many10@example.test");
    expect(r.status).toBe(429);
    expect(mailTo("many10@example.test")).toEqual([]);
  });
});
