import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { chatsStorage, freeChats, generateTitle } from "@dembrane/chats";
import { createDb } from "@dembrane/db";
import { fakeCalls, fakeModels, lastPayer, takeUnscopedFakeCalls } from "@dembrane/llm";
import { createLogger } from "@dembrane/observability";
import postgres from "postgres";
import { createRun, type RunsDeps } from "../src/runs/service";
import { runsStorage } from "../src/runs/storage";
import { ids, prepareDb, seedRun } from "./fixtures/runs-db";

// POST /api/agentic/runs names its project in the body, out of the middleware's sight.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `agentic_payer_${process.pid}`;

setDefaultTimeout(60_000);

run("agentic run payer", () => {
  let database: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const url = await prepareDb(admin as string, dbName);
    await seedRun(url);
    database = createDb({ url, poolMax: 4 });
  });
  afterAll(async () => {
    await database?.close();
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  test("the chat title a new run asks for is billed to the body's project", async () => {
    const models = fakeModels({ text: "Parking" });
    const d: RunsDeps = {
      db: database.db,
      store: runsStorage(database.db),
      chats: chatsStorage(database.db),
      access: new Access(new DrizzleAccessStore(database.db)),
      freeChats: freeChats(database.db),
      queue: { enqueue: async () => "job" } as unknown as RunsDeps["queue"],
      logger: createLogger(
        { service: "t", release: "r", env: "test", level: "error" },
        new Writable({ write: (_c, _e, cb) => cb() }),
      ),
      now: () => new Date(),
      generateTitle: (text, language) => generateTitle(models, text, language),
    };
    takeUnscopedFakeCalls();
    await createRun(
      d,
      { appUserId: ids.appUser, directusUserId: ids.user, isStaff: false },
      { project_id: ids.project, project_chat_id: ids.chat, message: "Parking?", language: "en" },
    );
    // The title is generated after the response, in a detached promise.
    const end = Date.now() + 5_000;
    while (!(await d.chats.chat(ids.chat))?.name && Date.now() < end) await Bun.sleep(10);
    expect(fakeCalls()).toHaveLength(1);
    expect(lastPayer()).toEqual({ ref: "project", id: ids.project });
  });
});
