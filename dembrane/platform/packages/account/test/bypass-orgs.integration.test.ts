import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { Notifier } from "@dembrane/notifications";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { MemoryJobSink, tenancyRoutes } from "@dembrane/tenancy";
import { Hono } from "hono";
import { type AccountApiDeps, accountRoutes } from "../src/routes";

// Bypass review B: onboarding creates organisations without the one-free-org rule.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `account_bypass_orgs_${process.pid}`;

const n = (prefix: string, k: number) =>
  `${prefix}000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const BA = n("ba", 1);
const ORG_A = n("0a", 1);
const WS_A = n("c1", 1);

type Person = { directus: string; app: string | null; email: string };
const NEW: Person = { directus: n("d1", 1), app: null, email: "newbie@example.com" };
const ADMIN: Person = { directus: n("d1", 2), app: n("a1", 2), email: "legacy@example.com" };
const OWNER: Person = { directus: n("d1", 3), app: n("a1", 3), email: "owner@example.com" };
// Signed up (app_user exists) but owns no org yet: onboarding and POST /orgs can both create one.
const RACERS: Person[] = [4, 5, 6, 7, 8].map((k) => ({
  directus: n("d1", k),
  app: n("a1", k),
  email: `racer${k}@example.com`,
}));
const PEOPLE = [NEW, ADMIN, OWNER, ...RACERS];

run("bypass: organisations via onboarding", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: ReturnType<typeof connect>;
  let app: Hono<Env>;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 8 });
    sql = connect(url, { max: 2, onnotice: () => {} });

    for (const p of PEOPLE) {
      await sql`insert into directus_users (id, email) values (${p.directus}, ${p.email})`;
      await sql`insert into auth_user (id, email, email_verified, name) values (${p.directus}, ${p.email}, true, ${p.email})`;
      if (p.app)
        await sql`insert into app_user (id, directus_user_id, email, display_name) values (${p.app}, ${p.directus}, ${p.email}, ${p.email})`;
    }
    // Free org A: OWNER owns it, ADMIN administers it (org row only, as an org invite leaves it).
    await sql`insert into org (id, name) values (${ORG_A}, 'Free A')`;
    await sql`insert into billing_account (id, org_id, tier) values (${BA}, ${ORG_A}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id, is_default) values (${WS_A}, 'Default', ${ORG_A}, ${BA}, true)`;
    await sql`insert into org_membership (id, org_id, user_id, role) values
      (${n("e1", 1)}, ${ORG_A}, ${OWNER.app}, 'owner'), (${n("e1", 2)}, ${ORG_A}, ${ADMIN.app}, 'admin')`;
    // ADMIN still has a pre-workspace project of their own.
    await sql`insert into project (id, name, directus_user_id, is_conversation_allowed) values (${n("9a", 1)}, 'Legacy', ${ADMIN.directus}, true)`;

    const deps = {
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      auth: { api: {} },
      identity: {},
      notifier: new Notifier(database.db),
      limiter: new RateLimiter(new MemoryRateCounter()),
      jobs: { enqueue: async () => "job" },
      files: {},
      config: {
        account: { inviteHashSecret: "h".repeat(32), onboardingFollowupInbox: "" },
        http: { dashboardUrl: "http://dashboard.test" },
        files: { directusLocation: "local" },
      },
    } as unknown as AccountApiDeps;
    app = new Hono<Env>();
    app.use(async (c, next) => {
      const p = PEOPLE.find((x) => x.email === c.req.header("x-as"));
      if (p)
        c.set("principal", {
          appUserId: p.app,
          directusUserId: p.directus,
          isStaff: false,
        } as unknown as Signed);
      await next();
    });
    app.route("/", accountRoutes(deps));
    app.route(
      "/",
      tenancyRoutes({
        db: database.db,
        accessStore: new DrizzleAccessStore(database.db),
        jobs: new MemoryJobSink(),
        dashboardUrl: "http://dashboard.test",
        inviteSecret: "s".repeat(32),
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

  const onboard = (p: Person) =>
    app.request("/api/v2/onboarding/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-as": p.email },
      body: JSON.stringify({ org_name: "Mine" }),
    });

  const managedFreeOrgs = async (directusId: string) =>
    Number(
      (
        await sql`select count(distinct m.org_id)::int as n from org_membership m
          join app_user u on u.id = m.user_id
          join org o on o.id = m.org_id and o.deleted_at is null
          where u.directus_user_id = ${directusId} and m.deleted_at is null
            and m.role in ('owner', 'admin')
            and (select b.tier from billing_account b where b.org_id = o.id and b.deleted_at is null
                 order by b.created_at asc nulls last, b.id asc limit 1) = 'free'`
      )[0]?.n ?? 0,
    );

  test("parallel onboarding by a new user creates at most one free organisation", async () => {
    const results = await Promise.all([onboard(NEW), onboard(NEW), onboard(NEW), onboard(NEW)]);
    for (const r of results) expect(r.status).toBe(200);
    expect(await managedFreeOrgs(NEW.directus)).toBe(1);
  });

  test("onboarding racing POST /orgs yields one free organisation", async () => {
    await Promise.all(
      RACERS.map((p) =>
        Promise.all([
          onboard(p),
          app.request("/api/v2/orgs", {
            method: "POST",
            headers: { "content-type": "application/json", "x-as": p.email },
            body: JSON.stringify({ name: "Other" }),
          }),
        ]),
      ),
    );
    for (const p of RACERS) expect(await managedFreeOrgs(p.directus)).toBe(1);
  });

  // Accepted 2026-10-21: rare legacy case, an admin (not owner) with old projects gets their own org.
  test("an admin of a free org with a legacy project gets an org of their own from onboarding", async () => {
    const res = await onboard(ADMIN);
    expect(res.status).toBe(200);
    expect(await managedFreeOrgs(ADMIN.directus)).toBe(2);
  });

  test("control: the owner of a free org gets no new org from onboarding", async () => {
    expect((await onboard(OWNER)).status).toBe(200);
    expect(await managedFreeOrgs(OWNER.directus)).toBe(1);
  });
});
