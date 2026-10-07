import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DrizzleAccessStore } from "@dembrane/access";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { Hono } from "hono";
import type postgres from "postgres";
import { MemoryJobSink } from "../src/jobs";
import { tenancyRoutes } from "../src/routes";

// Who may list an organisation's pending invites: org admins all of them, a workspace admin
// those of the workspace they manage.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `tenancy_pending_invites_${process.pid}`;

const n = (prefix: string, k: number) =>
  `${prefix}000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const BA = n("ba", 1);
const ORG = n("0a", 1);
const WS_A = n("c1", 1);
const WS_B = n("c1", 2);

type Person = { directus: string; app: string; email: string };
const person = (k: number, name: string): Person => ({
  directus: n("d1", k),
  app: n("a1", k),
  email: `${name}@example.com`,
});
// alice owns the org; wanda is an org member who admins workspace A; carol is an org member
// with a plain seat in workspace A; sam admins workspace A only through staff support.
const P = {
  alice: person(1, "alice"),
  wanda: person(2, "wanda"),
  carol: person(3, "carol"),
  sam: person(4, "sam"),
};

run("listing an organisation's pending invites", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono<Env>;

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
    await sql`insert into org (id, name) values (${ORG}, 'Org')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values
      (${WS_A}, 'A', ${ORG}, ${BA}), (${WS_B}, 'B', ${ORG}, ${BA})`;
    for (const p of Object.values(P)) {
      await sql`insert into directus_users (id, email) values (${p.directus}, ${p.email})`;
      await sql`insert into auth_user (id, email, email_verified, name) values (${p.directus}, ${p.email}, true, ${p.email})`;
      await sql`insert into app_user (id, directus_user_id, email, display_name) values (${p.app}, ${p.directus}, ${p.email}, ${p.email})`;
    }
    await sql`insert into org_membership (id, org_id, user_id, role) values
      (${n("e1", 1)}, ${ORG}, ${P.alice.app}, 'owner'),
      (${n("e1", 2)}, ${ORG}, ${P.wanda.app}, 'member'),
      (${n("e1", 3)}, ${ORG}, ${P.carol.app}, 'member')`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values
      (${n("f1", 1)}, ${WS_A}, ${P.wanda.app}, 'admin'),
      (${n("f1", 2)}, ${WS_A}, ${P.carol.app}, 'member')`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role, source, expires_at, custom_policies)
      values (${n("f1", 3)}, ${WS_A}, ${P.sam.app}, 'admin', 'staff_support', now() + interval '1 day', '["member:manage"]')`;
    await sql`insert into workspace_invite (id, workspace_id, email, role, invited_by, expires_at) values
      (${n("e9", 1)}, ${WS_A}, 'to-a@example.com', 'member', ${P.wanda.app}, now() + interval '7 days'),
      (${n("e9", 2)}, ${WS_B}, 'to-b@example.com', 'member', ${P.alice.app}, now() + interval '7 days')`;
    await sql`insert into org_invite (id, org_id, email, role, invited_by, expires_at) values
      (${n("e9", 3)}, ${ORG}, 'to-org@example.com', 'member', ${P.alice.app}, now() + interval '7 days')`;

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
        jobs: new MemoryJobSink(),
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

  const list = async (as: Person, workspaceId?: string) => {
    const q = workspaceId ? `?workspace_id=${workspaceId}` : "";
    const res = await app.request(`/api/v2/orgs/${ORG}/pending-invites${q}`, {
      headers: { "x-as": as.email },
    });
    const body = (await res.json()) as { email: string }[] | { code: string };
    return {
      status: res.status,
      emails: Array.isArray(body) ? body.map((i) => i.email).sort() : body.code,
    };
  };

  test("an org owner sees every pending invite", async () => {
    expect(await list(P.alice)).toEqual({
      status: 200,
      emails: ["to-a@example.com", "to-b@example.com", "to-org@example.com"],
    });
  });

  test("a workspace admin sees the pending invites of their workspace", async () => {
    expect(await list(P.wanda, WS_A)).toEqual({ status: 200, emails: ["to-a@example.com"] });
  });

  test("a workspace admin sees neither another workspace's invites nor the org-wide list", async () => {
    expect(await list(P.wanda, WS_B)).toEqual({ status: 403, emails: "organisation.admin_only" });
    expect(await list(P.wanda)).toEqual({ status: 403, emails: "organisation.admin_only" });
  });

  test("a plain workspace member and a staff support admin are refused", async () => {
    expect(await list(P.carol, WS_A)).toEqual({ status: 403, emails: "organisation.admin_only" });
    expect(await list(P.sam, WS_A)).toEqual({ status: 403, emails: "organisation.no_access" });
  });

  test("a deleted organisation's invites are listed to nobody", async () => {
    await sql`update org set deleted_at = now() where id = ${ORG}`;
    expect(await list(P.wanda, WS_A)).toEqual({ status: 403, emails: "organisation.no_access" });
  });
});
