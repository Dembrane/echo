import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { runProviderCheck } from "@dembrane/metering";
import { projectRoutes } from "@dembrane/projects";
import { Hono } from "hono";
import type postgres from "postgres";

/**
 * A project that chose Google in account A, moved to account B and came back to A with no
 * choice made: a Google call after the return is a call nobody allowed, and the daily check
 * must say so. It reads the choice the project's history ends on, wherever it was written.
 */
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `api_check_move_${process.pid}`;
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

run("the daily provider check after a project moves between accounts", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  let db: Db;
  let close: () => Promise<void>;
  let app: Hono<Env>;
  let clock = new Date("2026-11-01T10:00:00Z");
  let user: { appUserId: string; directusUserId: string };
  let orgA: string;
  let orgB: string;
  let wsA: string;
  let wsB: string;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    sql = connect(url, { max: 2, onnotice: () => {} });
    const made = createDb({ url, poolMax: 4 });
    db = made.db;
    close = made.close;

    user = { appUserId: randomUUID(), directusUserId: randomUUID() };
    await sql`insert into directus_users (id) values (${user.directusUserId})`;
    await sql`insert into app_user (id, directus_user_id) values (${user.appUserId}, ${user.directusUserId})`;
    // Two accounts (organisations) under one billing account, so a project may move between them.
    orgA = randomUUID();
    orgB = randomUUID();
    for (const org of [orgA, orgB])
      await sql`insert into org (id, name, ai_transcription_providers, ai_analysis_providers, ai_transcription_default, ai_analysis_default)
        values (${org}, 'o', array['scaleway','google'], array['scaleway','google'], 'scaleway', 'scaleway')`;
    const billing = randomUUID();
    await sql`insert into billing_account (id, tier, org_id) values (${billing}, 'paid', ${orgA})`;
    wsA = randomUUID();
    wsB = randomUUID();
    for (const [ws, org] of [
      [wsA, orgA],
      [wsB, orgB],
    ] as const) {
      await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'w', ${org}, ${billing})`;
      await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${randomUUID()}, ${ws}, ${user.appUserId}, 'owner')`;
    }
    const jobs = { enqueue: async () => "job" };
    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("principal", { ...user, isStaff: false } as Signed);
      await next();
    });
    app.route(
      "/",
      projectRoutes({
        db,
        access: new Access(new DrizzleAccessStore(db)),
        queue: jobs,
        now: () => clock,
      }),
    );
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ detail: err.details ?? err.message }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });

  afterAll(async () => {
    await sql?.end();
    await close?.();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const both = {
    enabled: { transcription: ["scaleway", "google"], analysis: ["scaleway", "google"] },
    defaults: { transcription: "scaleway", analysis: "scaleway" },
  };
  const event = (org: string, type: string, subject: string, detail: object, at: string) =>
    sql`insert into account_event (id, org_id, actor_kind, type, subject_type, subject_id, detail, created_at)
      values (${randomUUID()}, ${org}, 'customer', ${type}, ${type.startsWith("project") ? "project" : "org"}, ${subject},
        ${sql.json(detail as never)}, ${at}::timestamptz)`;
  const vertexCall = (org: string, project: string, at: string) =>
    sql`insert into model_call (started_at, recorded_at, service, model_group, model, kind, status, attempt, ms, provider, routed_provider, routing_job, routing_reason, routing_allowed, organisation_id, project_id)
      values (${at}::timestamptz, ${at}::timestamptz, 'echo-worker', 'text_fast', 'gemini', 'generate', 'ok', 1, 1, 'vertex', 'google', 'analysis', 'project', array['scaleway','google'], ${org}, ${project})`;
  const check = (at: string) =>
    runProviderCheck({
      db,
      logger: quiet,
      alerts: null,
      now: () => new Date(at),
      lagMs: 0,
      defaultProvider: "scaleway",
    });
  const move = async (project: string, to: string, at: string) => {
    clock = new Date(at);
    const res = await app.request(`/api/v2/projects/${project}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_workspace_id: to }),
    });
    expect(res.status).toBe(200);
  };

  /** A project in account A that chose Google for analysis at 10:00, and a Google call while it was there. */
  async function chose() {
    await sql`delete from model_call`;
    await sql`delete from ai_provider_check`;
    const project = randomUUID();
    await sql`insert into project (id, is_conversation_allowed, workspace_id, ai_analysis_provider)
      values (${project}, true, ${wsA}, 'google')`;
    await event(
      orgA,
      "ai_providers.changed",
      orgA,
      { before: null, after: both },
      "2026-11-01T09:00:00Z",
    );
    await event(
      orgB,
      "ai_providers.changed",
      orgB,
      { before: null, after: both },
      "2026-11-01T09:00:00Z",
    );
    await event(
      orgA,
      "project.ai_provider.changed",
      project,
      { job: "analysis", before: null, after: "google" },
      "2026-11-01T10:00:00Z",
    );
    await vertexCall(orgA, project, "2026-11-01T10:30:00Z");
    return project;
  }

  test("A to B to A with no choice: a Google call after the return is flagged, the one while it chose Google is not", async () => {
    const project = await chose();
    await move(project, wsB, "2026-11-01T11:00:00Z");
    await move(project, wsA, "2026-11-01T12:00:00Z");
    const [row] =
      await sql`select ai_analysis_provider as a, workspace_id::text as w from project where id = ${project}`;
    expect(row).toMatchObject({ a: null, w: wsA });
    // The move out cleared the choice in A's history too, and in B's.
    const cleared = await sql<{ org_id: string }[]>`select org_id::text from account_event
      where subject_id = ${project} and detail::jsonb ->> 'cause' = 'project_move'`;
    expect(cleared.map((e) => e.org_id).sort()).toEqual([orgA, orgB].sort());

    expect((await check("2026-11-01T12:15:00Z")).leaks).toBe(0);
    await vertexCall(orgA, project, "2026-11-01T12:30:00Z");
    expect(await check("2026-11-01T13:00:00Z")).toMatchObject({
      leaks: 1,
      byJob: { analysis: 1, transcription: 0 },
    });
  });

  test("history from before a move wrote to both accounts is read across accounts, and flags the same call", async () => {
    // History as it stands today: only the account it joined holds the clearing event.
    const project = await chose();
    await move(project, wsB, "2026-11-01T11:00:00Z");
    await move(project, wsA, "2026-11-01T12:00:00Z");
    await sql`delete from account_event where org_id = ${orgA} and subject_id = ${project} and detail::jsonb ->> 'cause' = 'project_move'`;
    await sql`delete from ai_provider_check`;
    await vertexCall(orgA, project, "2026-11-01T12:30:00Z");
    expect((await check("2026-11-01T13:00:00Z")).leaks).toBe(1);
  });
});
