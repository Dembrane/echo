import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { invalidateFreeLimits } from "@dembrane/allowance";
import { AudioUrls, ParticipantTokens } from "@dembrane/conversations";
import { newId, PlatformError } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { fakeModels, lastPayer } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FilesystemStorage } from "@dembrane/storage";
import { Hono } from "hono";
import type postgres from "postgres";
import { verifyRoutes } from "../src";
import { seedDefaultTopics } from "../src/defaults";
import { TRY_IT_LIMIT } from "../src/try-it/service";

// ECHO-1061: POST /api/v2/projects/:project_id/portal-editor/try with a fake model. Who may
// run it, the per-person limit, the payer, and that nothing is stored.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `verify_try_it_${process.pid}`;

run("portal editor try it", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono<Env>;
  const prompts: string[] = [];

  beforeAll(async () => {
    invalidateFreeLimits();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    await seedDefaultTopics(database.db);
    app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("principal", {
        appUserId: c.req.header("x-app"),
        directusUserId: c.req.header("x-directus") ?? null,
        isStaff: false,
      } as Signed);
      await next();
    });
    app.route(
      "/",
      verifyRoutes({
        db: database.db,
        access: new Access(new DrizzleAccessStore(database.db)),
        audio: new FilesystemStorage(mkdtempSync(join(tmpdir(), "try-it-")), "http://t", "/a"),
        audioUrls: new AudioUrls("http://s3.test", "bucket"),
        models: fakeModels({
          text: (prompt) => {
            prompts.push(JSON.stringify(prompt));
            return "Draft to correct together.\n- Shade first.\nIs this right?";
          },
        }),
        tokens: new ParticipantTokens("s".repeat(48), false),
        limiter: new RateLimiter(new MemoryRateCounter()),
        logger: createLogger(
          { service: "t", release: "r", env: "test", level: "error" },
          new Writable({ write: (_c, _e, cb) => cb() }),
        ),
        now: () => new Date("2026-11-12T12:00:00Z"),
      }),
    );
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json({ code: err.code }, err.status as 400)
        : c.json({ detail: String(err) }, 500),
    );
  });

  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function projectWith(role: string) {
    const person = { app: newId(), directus: newId() };
    await sql`insert into directus_users (id) values (${person.directus})`;
    await sql`insert into app_user (id, directus_user_id) values (${person.app}, ${person.directus})`;
    const [org, billing, ws, project] = [newId(), newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'innovator')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${person.app}, ${role})`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, context, default_conversation_transcript_prompt, is_verify_enabled, is_get_reply_enabled)
      values (${project}, 'Park', 'en', ${ws}, true, 'Evenings on the park by the library.', 'Lindepark', false, false)`;
    return { person, project };
  }

  const tryIt = (who: Awaited<ReturnType<typeof projectWith>>, body: Record<string, unknown>) =>
    Promise.resolve(
      app.request(`/api/v2/projects/${who.project}/portal-editor/try`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-app": who.person.app,
          "x-directus": who.person.directus,
        },
        body: JSON.stringify(body),
      }),
    );

  const stored = async () => {
    const [row] = await sql`select
      (select count(*) from conversation)::int as conversations,
      (select count(*) from conversation_chunk)::int as chunks,
      (select count(*) from conversation_reply)::int as replies,
      (select count(*) from conversation_artifact)::int as artifacts`;
    return row;
  };

  test("runs Explore and Verify on the sample, with the project's key terms, storing nothing", async () => {
    const owner = await projectWith("owner");
    const before = await stored();
    prompts.length = 0;

    const explore = await tryIt(owner, {
      kind: "explore",
      language: "nl",
      get_reply_mode: "custom",
      get_reply_prompt: "Vraag door op schaduw.",
    });
    expect(explore.status).toBe(200);
    expect(await explore.json()).toMatchObject({
      kind: "explore",
      key: "custom",
      language: "nl",
      source: "sample",
    });
    expect(lastPayer()).toEqual({ ref: "project", id: owner.project });
    expect(prompts.at(-1)).toContain("Vraag door op schaduw.");
    expect(prompts.at(-1)).toContain("Lindepark");
    expect(prompts.at(-1)).toContain("parkje naast de bibliotheek");

    // Switched off in the project: a host tries before switching on.
    const verify = await tryIt(owner, { kind: "verify", language: "en", topic_key: "agreements" });
    expect(verify.status).toBe(200);
    expect(((await verify.json()) as { text: string }).text).toContain("Shade first.");

    expect(await stored()).toEqual(before);
  });

  test("refuses an unknown topic", async () => {
    const owner = await projectWith("owner");
    const res = await tryIt(owner, { kind: "verify", topic_key: "nope" });
    expect(res.status).toBe(400);
  });

  test("an observer may not run it", async () => {
    const observer = await projectWith("observer");
    const res = await tryIt(observer, { kind: "explore" });
    expect(res.status).toBe(403);
  });

  test(`stops at ${TRY_IT_LIMIT.capacity} tries per person per hour`, async () => {
    const owner = await projectWith("owner");
    for (let i = 0; i < TRY_IT_LIMIT.capacity; i++)
      expect((await tryIt(owner, { kind: "explore" })).status).toBe(200);
    const over = await tryIt(owner, { kind: "explore" });
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ code: "rate_limit.exceeded" });
  });
});
