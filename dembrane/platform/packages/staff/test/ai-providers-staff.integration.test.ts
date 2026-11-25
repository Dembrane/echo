import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { DrizzleStaffAudit } from "@dembrane/access";
import { createBilling, FakeMollie } from "@dembrane/billing";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, migrate, schema } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { routingPolicyOf } from "@dembrane/llm";
import { MemoryMailer } from "@dembrane/mail";
import { createLogger } from "@dembrane/observability";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type postgres from "postgres";
import { staffRoutes } from "../src";

// Staff set which AI providers an account may use and its default, after a written request.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `staff_ai_providers_${process.pid}`;
const NOW = new Date("2026-12-03T10:00:00Z");

const STAFF: Signed = {
  appUserId: "a0000000-0000-4000-8000-000000000001",
  directusUserId: "d0000000-0000-4000-8000-000000000001",
  isStaff: true,
};
const ALICE: Signed = {
  appUserId: "a0000000-0000-4000-8000-000000000002",
  directusUserId: "d0000000-0000-4000-8000-000000000002",
  isStaff: false,
};
const logger = createLogger(
  { service: "t", release: "r", env: "test", level: "warn" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("staff AI providers", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono<Env>;

  const build = (aiPolicy: ReturnType<typeof routingPolicyOf>) => {
    const a = new Hono<Env>();
    a.use(async (c, next) => {
      const who = c.req.header("x-as");
      c.set("requestId", "req-1");
      c.set("principal", who === "staff" ? STAFF : who === "alice" ? ALICE : null);
      await next();
    });
    a.route(
      "/",
      staffRoutes({
        db: database.db,
        staffAudit: new DrizzleStaffAudit(database.db),
        billing: createBilling({
          db: database.db,
          mollie: new FakeMollie(),
          mailer: new MemoryMailer(),
          logger,
          billingConfig: {
            webhookUrl: null,
            forceReconcileFailure: false,
            dashboardUrl: "https://dash.test",
          },
          clock: () => NOW,
        }),
        mailer: new MemoryMailer(),
        logger,
        config: { http: { dashboardUrl: "https://dash.test" } },
        clock: () => NOW,
        aiPolicy,
      }),
    );
    a.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ code: err.code, detail: err.message }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
    return a;
  };

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 3 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    app = build(
      routingPolicyOf({ provider: "openai-compatible", providers: ["scaleway", "google"] }),
    );
  });

  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const call = (a: Hono<Env>, as: string, method: string, path: string, body?: unknown) =>
    a.request(path, {
      method,
      headers: { "x-as": as, ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  async function account() {
    const orgId = randomUUID();
    await sql`insert into org (id, name) values (${orgId}, 'Acme')`;
    const ticket = randomUUID();
    await sql`insert into account_ticket (id, org_id, subject, created_at)
      values (${ticket}, ${orgId}, 'Google Vertex AI', '2026-12-02T09:00:00Z')`;
    return { orgId, ticket, url: `/api/v2/admin/orgs/${orgId}/ai-providers` };
  }

  const BOTH = {
    transcription_enabled: ["scaleway", "google"],
    analysis_enabled: ["scaleway", "google"],
    transcription_default: "scaleway",
    analysis_default: "scaleway",
  };

  test("staff read the account's setting, its cost and its tickets; nobody else does", async () => {
    const o = await account();
    const read = await call(app, "staff", "GET", o.url);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      jobs: ["transcription", "analysis"],
      available: ["scaleway", "google"],
      enabled: { transcription: ["scaleway"], analysis: ["scaleway"] },
      defaults: { transcription: "scaleway", analysis: "scaleway" },
      month: { spent: { scaleway: 0, google: 0 } },
      tickets: [{ id: o.ticket, subject: "Google Vertex AI" }],
    });
    expect((await call(app, "alice", "GET", o.url)).status).toBe(403);
    expect(
      (await call(app, "alice", "PUT", o.url, { ...BOTH, request_ticket_id: o.ticket })).status,
    ).toBe(403);
    expect((await call(app, "nobody", "GET", o.url)).status).toBeGreaterThanOrEqual(401);
  });

  test("a change needs a request ticket of the account; it is audited and lands on the account's timeline", async () => {
    const o = await account();
    const body = { ...BOTH, request_ticket_id: o.ticket };
    const without = await call(app, "staff", "PUT", o.url, BOTH);
    expect(without.status).toBeGreaterThanOrEqual(400);
    const foreign = await call(app, "staff", "PUT", o.url, {
      ...body,
      request_ticket_id: randomUUID(),
    });
    expect(foreign.status).toBe(400);
    const ok = await call(app, "staff", "PUT", o.url, body);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      enabled: { transcription: ["scaleway", "google"], analysis: ["scaleway", "google"] },
      defaults: { transcription: "scaleway", analysis: "scaleway" },
    });
    const [org] =
      await sql`select ai_transcription_providers, ai_analysis_providers, ai_transcription_default, ai_analysis_default from org where id = ${o.orgId}`;
    expect(org).toMatchObject({
      ai_transcription_providers: ["scaleway", "google"],
      ai_analysis_providers: ["scaleway", "google"],
      ai_transcription_default: "scaleway",
      ai_analysis_default: "scaleway",
    });
    const [event] =
      await sql`select actor_kind, actor_user_id::text, detail from account_event where org_id = ${o.orgId}`;
    expect(event).toMatchObject({ actor_kind: "staff", actor_user_id: STAFF.directusUserId });
    expect(event?.detail).toMatchObject({
      request_ticket_id: o.ticket,
      after: { enabled: { analysis: ["scaleway", "google"] } },
    });
    const audit = await database.db
      .select()
      .from(schema.staff_audit_event)
      .where(eq(schema.staff_audit_event.action, "org.ai_providers.set"));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  test("the modal's rules hold on the server: a default must be enabled for its job, and each job keeps a provider", async () => {
    const o = await account();
    const put = (b: object) =>
      call(app, "staff", "PUT", o.url, { ...BOTH, request_ticket_id: o.ticket, ...b });
    // Google as the analysis default while it is not enabled for analysis.
    const res = await put({ analysis_enabled: ["scaleway"], analysis_default: "google" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toMatch(
      /analysis default must be one of/,
    );
    // A job with nothing enabled.
    expect((await put({ transcription_enabled: [] })).status).toBeGreaterThanOrEqual(400);
    // Google can be the default of one job and not of the other.
    const mixed = await put({ analysis_default: "google" });
    expect(mixed.status).toBe(200);
    expect(await mixed.json()).toMatchObject({
      defaults: { transcription: "scaleway", analysis: "google" },
    });
    expect(await sql`select 1 from account_event where org_id = ${o.orgId}`).toHaveLength(1);
  });

  test("a deployment without Google cannot be told to enable it", async () => {
    const only = build(routingPolicyOf({ provider: "openai-compatible" }));
    const o = await account();
    const res = await call(only, "staff", "PUT", o.url, { ...BOTH, request_ticket_id: o.ticket });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/no provider google/);
    expect(await sql`select 1 from account_event where org_id = ${o.orgId}`).toHaveLength(0);
  });
});
