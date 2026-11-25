import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { setOrg } from "@dembrane/ai-providers";
import { PlatformError } from "@dembrane/core";
import { connect, createDb, type Db, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { routingPolicyOf } from "@dembrane/llm";
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
    await sql`delete from account_event`;
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

  test("Google leaves the account, then the project moves to one that allows it: a Google call there is flagged", async () => {
    // The project chose Google in A. Staff take Google away from A, which clears the choice
    // without any project event of its own; the move then finds it already null and writes none.
    const project = await chose();
    const ticket = randomUUID();
    await sql`insert into account_ticket (id, org_id, subject, created_at) values (${ticket}, ${orgA}, 'Google', '2026-10-30T09:00:00Z')`;
    await sql`insert into account_ticket_message (id, ticket_id, from_staff, body, created_at) values (${randomUUID()}, ${ticket}, false, 'Please change.', '2026-10-30T09:00:00Z')`;
    clock = new Date("2026-11-01T11:00:00Z");
    await setOrg(
      {
        db,
        policy: routingPolicyOf({
          provider: "openai-compatible",
          providers: ["scaleway", "google"],
        }),
        models: {},
        now: () => clock,
      },
      randomUUID(),
      orgA,
      {
        enabled: { transcription: ["scaleway", "google"], analysis: ["scaleway"] },
        defaults: { transcription: "scaleway", analysis: "scaleway" },
        requestTicketId: ticket,
      },
    );
    const [row] = await sql`select ai_analysis_provider as a from project where id = ${project}`;
    expect(row?.a).toBeNull();
    // The clearing is in A's history, by staff, with its cause.
    const cleared = await sql<{ actor_kind: string; detail: Record<string, unknown> }[]>`
      select actor_kind, detail from account_event
      where subject_id = ${project} and detail::jsonb ->> 'cause' = 'provider_removed'`;
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.actor_kind).toBe("staff");
    expect(cleared[0]?.detail).toEqual({
      job: "analysis",
      before: "google",
      after: null,
      cause: "provider_removed",
    });
    await move(project, wsB, "2026-11-01T12:00:00Z");
    // The call A allowed while it chose Google is not flagged; the one in B, where nobody chose it, is.
    await vertexCall(orgB, project, "2026-11-01T12:30:00Z");
    expect(await check("2026-11-01T13:00:00Z")).toMatchObject({
      leaks: 1,
      byJob: { analysis: 1, transcription: 0 },
    });
  });

  test("a Google call made while a move waits for its lock, still on the choice, is not flagged", async () => {
    const project = await chose();
    clock = new Date("2026-11-01T11:00:00Z");
    // Another transaction holds the project's row, so the move cannot commit yet.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holding = sql.begin(async (tx) => {
      await tx`select id from project where id = ${project} for update`;
      await held;
    });
    await Bun.sleep(300);
    const moving = app.request(`/api/v2/projects/${project}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_workspace_id: wsB }),
    });
    await Bun.sleep(500);
    // Ten minutes pass while it waits; the project still has Google, so this call was allowed.
    clock = new Date("2026-11-01T11:10:00Z");
    await vertexCall(orgA, project, "2026-11-01T11:05:00Z");
    release();
    await holding;
    expect((await moving).status).toBe(200);
    const [row] = await sql`select ai_analysis_provider as a from project where id = ${project}`;
    expect(row?.a).toBeNull();
    expect((await check("2026-11-01T12:00:00Z")).leaks).toBe(0);
  });

  test("a choice made while a move waits for its lock is the one the move clears and records", async () => {
    // The project starts with no choice; an admin picks Google while the move waits for the row.
    const project = randomUUID();
    await sql`delete from model_call`;
    await sql`delete from ai_provider_check`;
    await sql`delete from account_event`;
    await sql`insert into project (id, is_conversation_allowed, workspace_id) values (${project}, true, ${wsA})`;
    for (const org of [orgA, orgB])
      await event(
        org,
        "ai_providers.changed",
        org,
        { before: null, after: both },
        "2026-11-01T09:00:00Z",
      );
    clock = new Date("2026-11-01T11:00:00Z");
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const choosing = sql.begin(async (tx) => {
      await tx`select id from project where id = ${project} for update`;
      await held;
      await tx`update project set ai_analysis_provider = 'google' where id = ${project}`;
      await tx`insert into account_event (id, org_id, actor_kind, type, subject_type, subject_id, detail, created_at)
        values (${randomUUID()}, ${orgA}, 'customer', 'project.ai_provider.changed', 'project', ${project},
          ${tx.json({ job: "analysis", before: null, after: "google" } as never)}, '2026-11-01T11:01:00Z'::timestamptz)`;
    });
    await Bun.sleep(300);
    const moving = app.request(`/api/v2/projects/${project}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_workspace_id: wsB }),
    });
    await Bun.sleep(500);
    clock = new Date("2026-11-01T11:10:00Z");
    release();
    await choosing;
    expect((await moving).status).toBe(200);
    const cleared = await sql<{ org_id: string; detail: Record<string, unknown> }[]>`
      select org_id, detail from account_event
      where subject_id = ${project} and detail::jsonb ->> 'cause' = 'project_move'`;
    expect(cleared.map((e) => e.org_id).sort()).toEqual([orgA, orgB].sort());
    expect(cleared[0]?.detail).toMatchObject({ job: "analysis", before: "google", after: null });
    // In B nobody chose Google, so a Google call there is flagged.
    await vertexCall(orgB, project, "2026-11-01T12:30:00Z");
    expect((await check("2026-11-01T13:00:00Z")).leaks).toBe(1);
  });
});
