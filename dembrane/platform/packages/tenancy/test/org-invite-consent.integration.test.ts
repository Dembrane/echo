import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DrizzleAccessStore } from "@dembrane/access";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { Hono } from "hono";
import type postgres from "postgres";
import { MemoryJobSink } from "../src/jobs";
import { tenancyRoutes } from "../src/routes";

// Organisation-only invites ask for consent from anyone not already in the organisation,
// and the answer never reveals whether the email has an account.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_org_invite_${process.pid}`;

const n = (prefix: string, k: number) =>
  `${prefix}000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const BA = n("ba", 1);
const ORG_A = n("0a", 1);
const ORG_B = n("0b", 1);
const WS_A = n("c1", 1);

type Person = { directus: string; app: string; email: string };
const person = (k: number, name: string): Person => ({
  directus: n("d1", k),
  app: n("a1", k),
  email: `${name}@example.com`,
});
// alice owns org A, carol is a member, fred was removed, gina is an external guest in one of
// its workspaces, xavier belongs only to org B.
const P = {
  alice: person(1, "alice"),
  carol: person(2, "carol"),
  fred: person(3, "fred"),
  gina: person(4, "gina"),
  xavier: person(5, "xavier"),
};

run("organisation invites and consent", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono<Env>;
  const jobs = new MemoryJobSink();

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
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${WS_A}, 'Main', ${ORG_A}, ${BA})`;
    for (const p of Object.values(P)) {
      await sql`insert into directus_users (id, email) values (${p.directus}, ${p.email})`;
      await sql`insert into auth_user (id, email, email_verified, name) values (${p.directus}, ${p.email}, true, ${p.email})`;
      await sql`insert into app_user (id, directus_user_id, email, display_name) values (${p.app}, ${p.directus}, ${p.email}, ${p.email})`;
    }
    let m = 0;
    const orgMember = (p: Person, org: string, role: string, deleted = false) =>
      sql`insert into org_membership (id, org_id, user_id, role, deleted_at) values
        (${n("e1", ++m)}, ${org}, ${p.app}, ${role}, ${deleted ? new Date().toISOString() : null})`;
    await orgMember(P.alice, ORG_A, "owner");
    await orgMember(P.carol, ORG_A, "member");
    await orgMember(P.fred, ORG_A, "member", true);
    await orgMember(P.xavier, ORG_B, "owner");
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values
      (${n("f1", 1)}, ${WS_A}, ${P.gina.app}, 'external')`;

    app = new Hono<Env>();
    app.use(async (c, next) => {
      const who = Object.values(P).find((p) => p.email === c.req.header("x-as"));
      if (who)
        c.set("principal", {
          appUserId: who.app,
          directusUserId: who.directus,
          isStaff: false,
        } satisfies Signed);
      await next();
    });
    app.route(
      "/",
      tenancyRoutes({
        db: database.db,
        accessStore: new DrizzleAccessStore(database.db),
        jobs,
        dashboardUrl: "http://dashboard.test",
        inviteSecret: "h".repeat(32),
      }),
    );
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

  const invite = async (email: string) => {
    const res = await app.request(`/api/v2/orgs/${ORG_A}/invites`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-as": P.alice.email },
      body: JSON.stringify({ email, role: "member" }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  const inOrg = async (p: Person) =>
    (
      await sql`select 1 from org_membership where org_id = ${ORG_A} and user_id = ${p.app} and deleted_at is null`
    ).length > 0;
  const shape = (r: Record<string, unknown>) => ({
    ...r,
    email: "-",
    invite_url: typeof r.invite_url === "string" ? "url" : r.invite_url,
  });

  test("a current member is reported as already a member", async () => {
    const r = await invite(P.carol.email);
    expect(r.status).toBe("already_member");
    expect(r).not.toHaveProperty("user_existed");
  });

  test("accounts outside the organisation get pending invites, answered like a new email", async () => {
    const fresh = await invite("nobody@example.com");
    for (const p of [P.xavier, P.fred, P.gina]) {
      const r = await invite(p.email);
      expect(shape(r)).toEqual(shape(fresh));
      expect(await inOrg(p)).toBe(false);
    }
    const [note] =
      await sql`select event_code, action from notification where audience_user_id = ${P.xavier.app}`;
    expect(note).toEqual({ event_code: "INVITE_RECEIVED", action: "NAVIGATE_INVITE" });
    const pending =
      await sql`select email from org_invite where org_id = ${ORG_A} and accepted_at is null order by email`;
    expect(pending.map((r) => r.email)).toEqual([
      P.fred.email,
      P.gina.email,
      "nobody@example.com",
      P.xavier.email,
    ]);
  });
});
