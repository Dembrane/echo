import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { chatRoutes } from "@dembrane/chats";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { fakeModels, type ModelCall } from "@dembrane/llm";
import { createLogger, type Payer, payer } from "@dembrane/observability";
import { Hono } from "hono";
import { payerMiddleware } from "../src/middleware/payer";

// A streamed reply is observed when its stream ends, after the handler has returned and while
// the server pulls the body: the observation must still see the route's payer.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `api_payer_stream_${process.pid}`;
const user = "d5000000-0000-4000-8000-000000000001";
const appUser = "a5000000-0000-4000-8000-000000000001";
const project = "f5000000-0000-4000-8000-000000000001";
const chat = "c5000000-0000-4000-8000-000000000001";

run("a streamed chat reply is billed to its chat", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let server: ReturnType<typeof Bun.serve>;
  const observed: { kind: ModelCall["kind"]; payer: Payer | undefined }[] = [];

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    const sql = connect(url, { max: 1, onnotice: () => {} });
    await sql`insert into directus_users (id, email) values (${user}, 'host@example.com')`;
    await sql`insert into app_user (id, directus_user_id) values (${appUser}, ${user})`;
    await sql`insert into project (id, name, language, directus_user_id, is_conversation_allowed)
      values (${project}, 'City', 'en', ${user}, true)`;
    await sql`insert into project_chat (id, project_id, name, chat_mode, date_created)
      values (${chat}, ${project}, 'Existing', 'deep_dive', now())`;
    await sql.end();
    const app = new Hono<Env>()
      .use(payerMiddleware())
      .use(async (c, next) => {
        c.set("principal", { appUserId: appUser, directusUserId: user, isStaff: false });
        await next();
      })
      .route(
        "/",
        chatRoutes({
          db: database.db,
          access: new Access(new DrizzleAccessStore(database.db)),
          models: fakeModels({
            stream: ["Char", "ging"],
            observe: (call) => observed.push({ kind: call.kind, payer: payer() }),
          }),
          limiter: { check: async () => {} },
          capture: async () => {},
          logger: createLogger(
            { service: "t", release: "r", env: "test", level: "error" },
            new Writable({ write: (_c, _e, cb) => cb() }),
          ),
        }),
      );
    server = Bun.serve({ port: 0, fetch: app.fetch });
  });
  afterAll(async () => {
    server?.stop(true);
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("the stream-end observation sees the chat route's payer", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/chats/${chat}?protocol=data`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What now?" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('0:"Char"\n0:"ging"\n');
    const end = Date.now() + 5_000;
    while (!observed.some((o) => o.kind === "stream") && Date.now() < end) await Bun.sleep(10);
    expect(observed.filter((o) => o.kind === "stream")).toEqual([
      { kind: "stream", payer: { ref: "chat", id: chat } },
    ]);
  });
});
