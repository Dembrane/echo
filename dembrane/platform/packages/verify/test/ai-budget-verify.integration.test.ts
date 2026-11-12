import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { AI_SPEND_KEY, allowanceForProject, invalidateFreeLimits } from "@dembrane/allowance";
import { AudioUrls, ParticipantTokens } from "@dembrane/conversations";
import { errorBody, newId, PlatformError } from "@dembrane/core";
import { createDb, migrate } from "@dembrane/db";
import { fakeCalls, fakeModels, takeUnscopedFakeCalls } from "@dembrane/llm";
import { createLogger, withPayer } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FilesystemStorage } from "@dembrane/storage";
import { Hono } from "hono";
import postgres from "postgres";
import { verifyRoutes } from "../src";
import { seedDefaultTopics } from "../src/defaults";

// Verify refuses at a used-up AI budget with a plain error that names no plan or budget.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `verify_ai_budget_${process.pid}`;
const LIMIT = 5_000_000;
const NOW = new Date();

setDefaultTimeout(60_000);

run("verify and the AI budget", () => {
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let app: Hono;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    await seedDefaultTopics(database.db);
    sql = postgres(url, { max: 2, onnotice: () => {} });
    const routes = verifyRoutes({
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio: new FilesystemStorage(mkdtempSync(join(tmpdir(), "verify-budget-")), "http://t", "/a"),
      audioUrls: new AudioUrls("http://s3.test", "bucket"),
      models: fakeModels({ text: "# Gems\n\nChargers." }),
      tokens: new ParticipantTokens("s".repeat(48), false),
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: createLogger(
        { service: "t", release: "r", env: "test", level: "error" },
        new Writable({ write: (_c, _e, cb) => cb() }),
      ),
      now: () => NOW,
    });
    app = new Hono();
    app.route("/", routes);
    app.onError((err, c) =>
      err instanceof PlatformError
        ? c.json(errorBody(err), err.status as 400)
        : c.json({ detail: "Internal Server Error" }, 500),
    );
  });
  beforeEach(() => invalidateFreeLimits());
  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  async function seed(spent: number) {
    const [org, billing, ws, project, conversation] = [newId(), newId(), newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, is_verify_enabled)
      values (${project}, 'P', 'en', ${ws}, true, true)`;
    await sql`insert into conversation (id, project_id, participant_name) values (${conversation}, ${project}, 'R')`;
    await sql`insert into conversation_chunk (id, conversation_id, transcript, timestamp)
      values (${newId()}, ${conversation}, 'We need chargers.', now() - interval '1 hour')`;
    const a = await allowanceForProject(database.db, project, NOW);
    if (!a) throw new Error("expected a free account");
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${billing}, ${a.periodStart.toISOString()}, ${AI_SPEND_KEY}, ${spent})`;
    return { conversation };
  }

  const generate = (conversation: string) =>
    app.request("/api/verify/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic_list: ["gems"], conversation_id: conversation }),
    });

  async function expectUnavailable(res: Response) {
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "portal.ai_unavailable",
      detail: "Not available right now.",
      action: "none",
    });
    expect(JSON.stringify(body)).not.toMatch(/budget|plan|upgrade|tier|limit/i);
  }

  test("generate at zero budget is refused plainly and calls no model", async () => {
    const { conversation } = await seed(LIMIT);
    takeUnscopedFakeCalls();
    await expectUnavailable(await generate(conversation));
    expect(fakeCalls().length).toBe(0);
    const [n] =
      await sql`select count(*)::int as n from conversation_artifact where conversation_id = ${conversation}`;
    expect(n?.n).toBe(0);
  });

  test("revising an artifact at zero budget is refused plainly and calls no model", async () => {
    const { conversation } = await seed(LIMIT);
    const artifact = newId();
    await sql`insert into conversation_artifact (id, conversation_id, key, content, date_created)
      values (${artifact}, ${conversation}, 'gems', 'Old', now() - interval '2 hours')`;
    await sql`insert into conversation_chunk (id, conversation_id, transcript, timestamp)
      values (${newId()}, ${conversation}, 'Add parking too.', now())`;
    takeUnscopedFakeCalls();
    const res = await app.request(`/api/verify/artifact/${artifact}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        useConversation: {
          conversationId: conversation,
          timestamp: new Date(Date.now() - 90 * 60_000).toISOString(),
        },
      }),
    });
    await expectUnavailable(res);
    expect(fakeCalls().length).toBe(0);
    const [row] = await sql`select content from conversation_artifact where id = ${artifact}`;
    expect(row?.content).toBe("Old");
  });

  test("editing or approving an artifact by hand at zero budget still works", async () => {
    const { conversation } = await seed(LIMIT);
    const artifact = newId();
    await sql`insert into conversation_artifact (id, conversation_id, key, content, date_created)
      values (${artifact}, ${conversation}, 'gems', 'Old', now())`;
    const res = await app.request(`/api/verify/artifact/${artifact}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Mine", approvedAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(200);
  });

  test("generate below the limit still works", async () => {
    const { conversation } = await seed(LIMIT - 1);
    takeUnscopedFakeCalls();
    const res = await withPayer({ ref: "conversation", id: conversation }, () =>
      generate(conversation),
    );
    expect(res.status).toBe(200);
    expect(fakeCalls().length).toBe(1);
  });
});
