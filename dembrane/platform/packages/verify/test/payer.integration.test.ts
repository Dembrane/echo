import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { AudioUrls, ParticipantTokens } from "@dembrane/conversations";
import { createDb, migrate } from "@dembrane/db";
import { fakeModels, lastPayer, takeUnscopedFakeCalls } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { FilesystemStorage } from "@dembrane/storage";
import postgres from "postgres";
import { verifyRoutes } from "../src";
import { seedDefaultTopics } from "../src/defaults";

// POST /api/verify/generate names its conversation in the body, out of the middleware's sight.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `verify_payer_${process.pid}`;
const project = "f9000000-0000-4000-8000-000000000001";
const conversation = "c9000000-0000-4000-8000-000000000001";

setDefaultTimeout(60_000);

run("verify generation payer", () => {
  let database: ReturnType<typeof createDb>;
  let routes: ReturnType<typeof verifyRoutes>;

  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 2 });
    await seedDefaultTopics(database.db);
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into project (id, name, language, is_conversation_allowed, is_verify_enabled)
      values (${project}, 'P', 'en', true, true)`;
    await sql`insert into conversation (id, project_id, participant_name) values (${conversation}, ${project}, 'R')`;
    await sql`insert into conversation_chunk (id, conversation_id, transcript, timestamp)
      values ('c9100000-0000-4000-8000-000000000001', ${conversation}, 'We need chargers.', now())`;
    await sql.end();
    routes = verifyRoutes({
      db: database.db,
      access: new Access(new DrizzleAccessStore(database.db)),
      audio: new FilesystemStorage(mkdtempSync(join(tmpdir(), "verify-payer-")), "http://t", "/a"),
      audioUrls: new AudioUrls("http://s3.test", "bucket"),
      models: fakeModels({ text: "# Gems\n\nChargers." }),
      tokens: new ParticipantTokens("s".repeat(48), false),
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: createLogger(
        { service: "t", release: "r", env: "test", level: "error" },
        new Writable({ write: (_c, _e, cb) => cb() }),
      ),
      now: () => new Date("2026-11-03T12:00:00Z"),
    });
  });
  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("the artifact's model call is billed to the body's conversation", async () => {
    takeUnscopedFakeCalls();
    const res = await routes.request("/api/verify/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic_list: ["gems"], conversation_id: conversation }),
    });
    expect(res.status).toBe(200);
    expect(lastPayer()).toEqual({ ref: "conversation", id: conversation });
  });
});
