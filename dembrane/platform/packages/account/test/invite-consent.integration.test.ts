import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { Notifier } from "@dembrane/notifications";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import { type AccountApiDeps, accountRoutes } from "../src/routes";

// Workspace invites ask for consent from anyone outside the inviter's organisation, and
// the answer never reveals whether the email has an account.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `account_invite_consent_${process.pid}`;

const n = (prefix: string, k: number) =>
  `${prefix}000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const BA = n("ba", 1);
const ORG_A = n("0a", 1);
const ORG_B = n("0b", 1);
const WS = n("c1", 1);
const WS_OTHER = n("c1", 2);
const WS_B = n("c1", 3);

type Person = { directus: string; app: string; email: string };
const displayName = (p: Person) => {
  const local = p.email.slice(0, p.email.indexOf("@"));
  return local.charAt(0).toUpperCase() + local.slice(1);
};
const person = (k: number, name: string): Person => ({
  directus: n("d1", k),
  app: n("a1", k),
  email: `${name}@example.com`,
});
// alice runs org A; carol is a member of it; gina is an external guest in another of its
// workspaces; fred was a member and was removed; xavier belongs only to org B; sam once had
// staff support access to the workspace, since removed; rob belongs only to org B.
const P = {
  alice: person(1, "alice"),
  carol: person(2, "carol"),
  gina: person(3, "gina"),
  fred: person(4, "fred"),
  xavier: person(5, "xavier"),
  sam: person(6, "sam"),
  rob: person(7, "rob"),
  tess: person(10, "tess"),
};
// Signed up but not onboarded yet: no app_user row. nina verified her email, uma did not.
const NEW = { nina: person(8, "nina"), uma: person(9, "uma") };

run("workspace invites and consent", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: ReturnType<typeof connect>;
  let app: Hono<Env>;
  const queued: { to: string; template: string }[] = [];

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = connect(url, { max: 2, onnotice: () => {} });

    await sql`insert into billing_account (id) values (${BA})`;
    await sql`insert into org (id, name) values (${ORG_A}, 'Org A'), (${ORG_B}, 'Org B')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values
      (${WS}, 'Main', ${ORG_A}, ${BA}), (${WS_OTHER}, 'Other', ${ORG_A}, ${BA}),
      (${WS_B}, 'B main', ${ORG_B}, ${BA})`;
    for (const p of Object.values(P)) {
      await sql`insert into directus_users (id, email) values (${p.directus}, ${p.email})`;
      await sql`insert into auth_user (id, email, email_verified, name) values (${p.directus}, ${p.email}, true, ${p.email})`;
      await sql`insert into app_user (id, directus_user_id, email, display_name) values (${p.app}, ${p.directus}, ${p.email}, ${displayName(p)})`;
    }
    for (const p of Object.values(NEW)) {
      await sql`insert into directus_users (id, email) values (${p.directus}, ${p.email})`;
      await sql`insert into auth_user (id, email, email_verified, name) values (${p.directus}, ${p.email}, ${p === NEW.nina}, ${p.email})`;
    }
    let m = 0;
    const orgMember = (p: Person, org: string, role: string, deleted = false) =>
      sql`insert into org_membership (id, org_id, user_id, role, deleted_at) values
        (${n("e1", ++m)}, ${org}, ${p.app}, ${role}, ${deleted ? new Date().toISOString() : null})`;
    const wsMember = (p: Person, ws: string, role: string) =>
      sql`insert into workspace_membership (id, workspace_id, user_id, role) values
        (${n("f1", ++m)}, ${ws}, ${p.app}, ${role})`;
    await orgMember(P.alice, ORG_A, "owner");
    await wsMember(P.alice, WS, "admin");
    await orgMember(P.carol, ORG_A, "member");
    await wsMember(P.gina, WS_OTHER, "external");
    await orgMember(P.fred, ORG_A, "member", true);
    await orgMember(P.xavier, ORG_B, "owner");
    await orgMember(P.rob, ORG_B, "member");
    await wsMember(P.xavier, WS_B, "admin");
    await sql`insert into workspace_membership (id, workspace_id, user_id, role, source, expires_at, custom_policies, deleted_at)
      values (${n("f1", 99)}, ${WS}, ${P.sam.app}, 'admin', 'staff_support', now() - interval '1 day',
              '["member:manage"]', now() - interval '1 hour')`;

    const deps = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      auth: { api: {} },
      identity: {},
      notifier: new Notifier(database.db),
      limiter: new RateLimiter(new MemoryRateCounter()),
      jobs: {
        enqueue: async (_def: unknown, p: { to: string; template: string }) => {
          queued.push({ to: p.to, template: p.template });
          return "job";
        },
      },
      files: {},
      config: {
        account: { inviteHashSecret: "h".repeat(32), onboardingFollowupInbox: "" },
        http: { dashboardUrl: "http://dashboard.test" },
        files: { directusLocation: "local" },
      },
    } as unknown as AccountApiDeps;
    app = new Hono<Env>();
    app.use(async (c, next) => {
      const who = Object.values(P).find((p) => p.email === c.req.header("x-as"));
      const newcomer = Object.values(NEW).find((p) => p.email === c.req.header("x-as"));
      if (newcomer)
        c.set("principal", {
          appUserId: null,
          directusUserId: newcomer.directus,
          isStaff: false,
        } as unknown as Signed);
      if (who)
        c.set("principal", {
          appUserId: who.app,
          directusUserId: who.directus,
          isStaff: false,
        } satisfies Signed);
      await next();
    });
    app.route("/", accountRoutes(deps));
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const call = (as: Person, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", "x-as": as.email },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const invite = async (email: string, role = "member") => {
    const res = await call(P.alice, "POST", `/api/v2/workspaces/${WS}/invite`, { email, role });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const inWorkspace = async (p: Person) =>
    (
      await sql`select 1 from workspace_membership where workspace_id = ${WS} and user_id = ${p.app} and deleted_at is null`
    ).length > 0;
  const inOrg = async (p: Person) =>
    (
      await sql`select 1 from org_membership where org_id = ${ORG_A} and user_id = ${p.app} and deleted_at is null`
    ).length > 0;
  // The fields an inviter sees, with the per-recipient parts blanked.
  const shape = (r: Record<string, unknown>) => ({
    ...r,
    email: "-",
    invite_url: typeof r.invite_url === "string" ? "url" : r.invite_url,
  });

  test("a member of the inviter's organisation is added at once", async () => {
    const r = await invite(P.carol.email);
    expect(r.status).toBe("added");
    expect(r).not.toHaveProperty("user_existed");
    expect(await inWorkspace(P.carol)).toBe(true);
  });

  test("an account outside the organisation gets a pending invite, answered like a new email", async () => {
    const fresh = await invite("nobody@example.com");
    const existing = await invite(P.xavier.email);
    expect(existing.status).toBe("invited");
    expect(shape(existing)).toEqual(shape(fresh));
    expect(await inWorkspace(P.xavier)).toBe(false);
    expect(await inOrg(P.xavier)).toBe(false);
    expect(queued.filter((q) => q.to === P.xavier.email).map((q) => q.template)).toEqual([
      "workspace_invite",
    ]);
    const [note] =
      await sql`select event_code, action from notification where audience_user_id = ${P.xavier.app}`;
    expect(note).toEqual({ event_code: "INVITE_RECEIVED", action: "NAVIGATE_INVITE" });
    const again = await invite(P.xavier.email);
    expect(shape(again)).toEqual(shape(await invite("nobody@example.com")));
  });

  test("an external guest of another workspace and a removed member also get pending invites", async () => {
    for (const p of [P.gina, P.fred]) {
      const r = await invite(p.email);
      expect(r.status).toBe("invited");
      expect(await inWorkspace(p)).toBe(false);
    }
    expect(await inOrg(P.fred)).toBe(false);
  });

  test("the invitee sees the invite and joins only by accepting it", async () => {
    const list = (await (await call(P.xavier, "GET", "/api/v2/me/invites")).json()) as {
      id: string;
      workspace_id: string;
    }[];
    const mine = list.find((i) => i.workspace_id === WS);
    expect(mine).toBeDefined();
    const res = await call(P.xavier, "POST", `/api/v2/me/invites/${mine?.id}/accept`);
    expect(res.status).toBe(200);
    expect(await inWorkspace(P.xavier)).toBe(true);
    expect(await inOrg(P.xavier)).toBe(true);
  });

  test("someone removed from the workspace rejoins by accepting, without their old access", async () => {
    expect((await invite(P.sam.email)).status).toBe("invited");
    expect(await inWorkspace(P.sam)).toBe(false);
    const list = (await (await call(P.sam, "GET", "/api/v2/me/invites")).json()) as {
      id: string;
    }[];
    expect((await call(P.sam, "POST", `/api/v2/me/invites/${list[0]?.id}/accept`)).status).toBe(
      200,
    );
    const live =
      await sql`select role, source, expires_at, custom_policies from workspace_membership
      where workspace_id = ${WS} and user_id = ${P.sam.app} and deleted_at is null`;
    expect([...live]).toEqual([
      { role: "member", source: "direct", expires_at: null, custom_policies: [] },
    ]);
  });

  test("declining leaves the invitee out", async () => {
    const list = (await (await call(P.fred, "GET", "/api/v2/me/invites")).json()) as {
      id: string;
      workspace_id: string;
    }[];
    const mine = list.find((i) => i.workspace_id === WS);
    const res = await call(P.fred, "POST", `/api/v2/me/invites/${mine?.id}/decline`);
    expect(res.status).toBe(200);
    expect(await inWorkspace(P.fred)).toBe(false);
  });

  const inviteNotice = async (p: Person) =>
    (
      await sql`select read_at from notification where audience_user_id = ${p.app} and event_code = 'INVITE_RECEIVED'`
    ).map((r) => r.read_at !== null);

  test("settling an invite marks the invitee's notice read", async () => {
    // xavier and sam accepted from /invites, fred declined (tests above).
    for (const p of [P.xavier, P.sam, P.fred]) expect(await inviteNotice(p)).toEqual([true]);
  });

  test("accepting through the email link marks the notice read", async () => {
    const url = String((await invite(P.gina.email)).invite_url);
    const hash = new URL(url).searchParams.get("h");
    const res = await call(P.gina, "POST", "/api/v2/me/invites/accept-by-hash", { hash });
    expect(res.status).toBe(200);
    expect(await inWorkspace(P.gina)).toBe(true);
    expect(await inviteNotice(P.gina)).toEqual([true]);
  });

  test("revoking an invite marks the invitee's notice read", async () => {
    expect((await invite(P.rob.email)).status).toBe("invited");
    expect(await inviteNotice(P.rob)).toEqual([false]);
    const [row] =
      await sql`select id from workspace_invite where email = ${P.rob.email} and deleted_at is null`;
    expect((await call(P.alice, "DELETE", `/api/v2/invites/${row?.id}`)).status).toBe(200);
    expect(await inviteNotice(P.rob)).toEqual([true]);
  });

  test("the decline notice names the person", async () => {
    const titles =
      await sql`select title from notification where audience_user_id = ${P.alice.app} and event_code = 'INVITE_DECLINED'`;
    expect(titles.map((t) => t.title)).toEqual(["Fred declined your invite"]);
  });

  test("accepting an organisation invite marks its notice read", async () => {
    const id = n("e9", 1);
    await sql`insert into org_invite (id, org_id, email, role, invited_by, expires_at)
      values (${id}, ${ORG_A}, ${P.rob.email}, 'member', ${P.alice.app}, now() + interval '7 days')`;
    await sql`insert into notification (id, audience_user_id, event_code, action, title, ref_org_id)
      values (${n("e9", 2)}, ${P.rob.app}, 'INVITE_RECEIVED', 'NAVIGATE_INVITE', 'Org invite', ${ORG_A})`;
    expect((await call(P.rob, "POST", `/api/v2/me/invites/${id}/accept`)).status).toBe(200);
    const notices = await sql`select title, read_at is not null as read from notification
      where audience_user_id = ${P.rob.app} and event_code = 'INVITE_RECEIVED' order by title`;
    expect(notices.map((r) => [r.title, r.read])).toEqual([
      ["Alice invited you to Main", true],
      ["Org invite", true],
    ]);
  });

  test("someone not onboarded yet sees invites to their verified email, so onboarding can name the organisation", async () => {
    expect((await invite(NEW.nina.email)).status).toBe("invited");
    await sql`insert into org_invite (id, org_id, email, role, invited_by, expires_at)
      values (${n("e9", 3)}, ${ORG_B}, ${NEW.nina.email}, 'member', ${P.xavier.app}, now() + interval '7 days')`;
    const res = await call(NEW.nina, "GET", "/api/v2/me/invites");
    expect(res.status).toBe(200);
    const list = (await res.json()) as { type: string; org_name: string }[];
    expect(list.map((i) => [i.type, i.org_name]).sort()).toEqual([
      ["org", "Org B"],
      ["workspace", "Org A"],
    ]);
  });

  test("onboarding a second time leaves an invited person in the inviter's organisation only", async () => {
    const complete = async () => {
      const res = await call(NEW.nina, "POST", "/api/v2/onboarding/complete", { org_name: "Mine" });
      expect(res.status).toBe(200);
      return (await res.json()) as { org_id: string; workspace_id: string };
    };
    expect(await complete()).toMatchObject({ org_id: "", workspace_id: WS });
    expect(await complete()).toMatchObject({ org_id: "", workspace_id: WS });
    const orgs = await sql`select m.org_id, m.role from org_membership m
      join app_user u on u.id = m.user_id
      where u.directus_user_id = ${NEW.nina.directus} and m.deleted_at is null order by m.org_id`;
    expect(orgs.map((o) => [o.org_id, o.role])).toEqual([
      [ORG_A, "member"],
      [ORG_B, "member"],
    ]);
  });

  test("an unverified email sees no invites", async () => {
    expect((await invite(NEW.uma.email)).status).toBe("invited");
    const res = await call(NEW.uma, "GET", "/api/v2/me/invites");
    expect(await res.json()).toEqual([]);
  });

  test("an invite's notice expires with it, and a resend keeps it alive as long", async () => {
    expect((await invite(P.tess.email)).status).toBe("invited");
    const expiries = async () =>
      (
        await sql`select i.id, i.expires_at as invite, n.expires_at as notice
          from workspace_invite i, notification n
          where i.email = ${P.tess.email} and n.audience_user_id = ${P.tess.app}
            and n.event_code = 'INVITE_RECEIVED'`
      )[0] as { id: string; invite: Date; notice: Date | null };
    const sent = await expiries();
    expect(sent.notice?.toISOString()).toBe(sent.invite.toISOString());

    await sql`update workspace_invite set expires_at = now() - interval '1 day' where id = ${sent.id}`;
    await sql`update notification set expires_at = now() - interval '1 day' where audience_user_id = ${P.tess.app}`;
    expect((await call(P.alice, "POST", `/api/v2/invites/${sent.id}/resend`)).status).toBe(200);
    const resent = await expiries();
    expect(resent.invite.getTime()).toBeGreaterThan(Date.now());
    expect(resent.notice?.toISOString()).toBe(resent.invite.toISOString());
  });
});
