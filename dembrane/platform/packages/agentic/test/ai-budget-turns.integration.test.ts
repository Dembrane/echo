import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { Writable } from "node:stream";
import { Access, DrizzleAccessStore } from "@dembrane/access";
import { AI_SPEND_KEY, invalidateFreeLimits } from "@dembrane/allowance";
import { chatsStorage, freeChats } from "@dembrane/chats";
import { newId } from "@dembrane/core";
import { connect, createDb } from "@dembrane/db";
import { countingDb } from "@dembrane/db/testing";
import type { Signed } from "@dembrane/http";
import { createLogger } from "@dembrane/observability";
import type postgres from "postgres";
import { appendMessage, createRun, type RunsDeps } from "../src/runs/service";
import { runsStorage } from "../src/runs/storage";
import { prepareDb } from "./fixtures/runs-db";

// Assistant runs refuse at a used-up AI budget; a run no longer needs a chat on free.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `agentic_ai_budget_turns_${process.pid}`;
const now = new Date("2026-10-20T10:00:00Z");
const OCT = "2026-10-01T00:00:00Z";
const LIMIT = 5_000_000;

type Person = Signed & { appUserId: string; directusUserId: string };

const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

const rejection = (p: Promise<unknown>) =>
  Promise.resolve(p).then(
    () => null,
    (e) => e,
  );

run("agentic turns and the AI budget", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let access: Access;
  let url: string;

  beforeAll(async () => {
    url = await prepareDb(admin as string, dbName);
    database = createDb({ url, poolMax: 12 });
    sql = connect(url, { max: 2, onnotice: () => {} });
    access = new Access(new DrizzleAccessStore(database.db));
  });
  beforeEach(() => invalidateFreeLimits());
  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  const deps = (over: Partial<RunsDeps> = {}): RunsDeps => ({
    db: database.db,
    store: runsStorage(database.db),
    chats: chatsStorage(database.db),
    access,
    freeChats: freeChats(database.db),
    queue: { enqueue: async () => "job" } as unknown as RunsDeps["queue"],
    logger: quiet,
    now: () => now,
    generateTitle: async () => null,
    ...over,
  });

  async function seed(tier = "free", opts: { sample?: boolean } = {}) {
    const owner = { appUserId: newId(), directusUserId: newId(), isStaff: false } as Person;
    await sql`insert into directus_users (id) values (${owner.directusUserId})`;
    await sql`insert into app_user (id, directus_user_id) values (${owner.appUserId}, ${owner.directusUserId})`;
    const [org, billing, ws, project] = [newId(), newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, ${tier})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.appUserId}, 'owner')`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample, directus_user_id)
      values (${project}, 'P', ${ws}, true, ${opts.sample ?? false}, ${owner.directusUserId})`;
    return { owner, billing, project };
  }

  async function spend(billing: string, amount: number) {
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${billing}, ${OCT}, ${AI_SPEND_KEY}, ${amount})
      on conflict (billing_account_id, period_start, key) do update set amount = excluded.amount`;
  }

  async function chat(projectId: string) {
    const id = newId();
    await sql`insert into project_chat (id, project_id, chat_mode) values (${id}, ${projectId}, 'agentic')`;
    return id;
  }

  const start = (d: RunsDeps, who: Person, projectId: string, chatId: string | null) =>
    createRun(d, who, {
      project_id: projectId,
      project_chat_id: chatId,
      message: "hello",
      language: "en",
    });

  const append = (d: RunsDeps, who: Person, runId: string, n: number) =>
    appendMessage(d, who, runId, { message: `turn ${n}`, language: "en" });

  const count = async (q: postgres.PendingQuery<postgres.Row[]>) => Number((await q)[0]?.n);
  const userMessages = (chatId: string) =>
    count(sql`select count(*) as n from project_chat_message
      where project_chat_id = ${chatId} and message_from = 'user'`);
  const userEvents = (runId: string) =>
    count(sql`select count(*) as n from project_agentic_run_event
      where project_agentic_run_id = ${runId} and event_type = 'user.message'`);
  const runs = (projectId: string) =>
    count(sql`select count(*) as n from project_agentic_run where project_id = ${projectId}`);

  test("creating a run at zero budget is refused with ai_budget", async () => {
    const { owner, billing, project } = await seed();
    await spend(billing, LIMIT);
    const a = await chat(project);
    const err = await rejection(start(deps(), owner, project, a));
    expect(err).toMatchObject({ status: 402, details: { limit: "ai_budget" } });
    expect(await runs(project)).toBe(0);
    expect(await userMessages(a)).toBe(0);
    const solo = await rejection(start(deps(), owner, project, null));
    expect(solo).toMatchObject({ status: 402, details: { limit: "ai_budget" } });
    expect(await runs(project)).toBe(0);
  });

  test("a follow-up at zero budget is refused and stores nothing", async () => {
    const { owner, billing, project } = await seed();
    const a = await chat(project);
    const r = await start(deps(), owner, project, a);
    await spend(billing, LIMIT);
    const err = await rejection(append(deps(), owner, String(r.id), 1));
    expect(err).toMatchObject({ status: 402, details: { limit: "ai_budget" } });
    expect(await userEvents(String(r.id))).toBe(1);
    expect(await userMessages(a)).toBe(1);
  });

  test("a run with no chat below the limit is created", async () => {
    const { owner, billing, project } = await seed();
    await spend(billing, LIMIT - 1);
    const d = deps();
    const r = await start(d, owner, project, null);
    expect(await runs(project)).toBe(1);
    await append(d, owner, String(r.id), 1);
    expect(await userEvents(String(r.id))).toBe(2);
  });

  test("a failed run gives the turn back", async () => {
    const { owner, project } = await seed();
    const store = runsStorage(database.db);
    let fail = true;
    const d = deps({
      store: {
        ...store,
        create: async (v: Parameters<typeof store.create>[0]) => {
          if (fail) {
            fail = false;
            throw new Error("boom");
          }
          return store.create(v);
        },
      },
    });
    const a = await chat(project);
    const err = await rejection(start(d, owner, project, a));
    expect((err as Error).message).toBe("boom");
    expect(await userMessages(a)).toBe(0);
    expect(await runs(project)).toBe(0);
  });

  test("a failed status write after the event keeps the turn", async () => {
    const { owner, project } = await seed();
    const a = await chat(project);
    const r = await start(deps(), owner, project, a);
    const store = runsStorage(database.db);
    const d = deps({
      store: {
        ...store,
        setStatus: async () => {
          throw new Error("status down");
        },
      },
    });
    const err = await rejection(append(d, owner, String(r.id), 1));
    expect((err as Error).message).toBe("status down");
    expect(await userEvents(String(r.id))).toBe(2);
    expect(await userMessages(a)).toBe(2);
  });

  test("a sample project in a free account at zero still runs", async () => {
    const { owner, billing, project } = await seed("free", { sample: true });
    await spend(billing, LIMIT);
    const a = await chat(project);
    const r = await start(deps(), owner, project, a);
    await append(deps(), owner, String(r.id), 1);
    expect(await userMessages(a)).toBe(2);
    await start(deps(), owner, project, null);
    expect(await runs(project)).toBe(2);
  });

  test("create and append with a chat read the budget once; a paid account reads no account", async () => {
    const c = countingDb(url, 4);
    const counted = (over: Partial<RunsDeps> = {}) =>
      deps({
        db: c.db,
        store: runsStorage(c.db),
        chats: chatsStorage(c.db),
        access: new Access(new DrizzleAccessStore(c.db)),
        freeChats: freeChats(c.db),
        ...over,
      });
    const reads = async (f: () => Promise<unknown>) => {
      c.log.length = 0;
      await f();
      const n = (s: string) => c.log.filter((l) => l.q.includes(s)).length;
      return { usage: n('from "free_usage"'), resolve: n("as own_id") };
    };
    try {
      const free = await seed();
      const fa = await chat(free.project);
      let runId = "";
      const created = await reads(async () => {
        runId = String((await start(counted(), free.owner, free.project, fa)).id);
      });
      expect(created).toMatchObject({ usage: 1, resolve: 1 });
      expect(await reads(() => append(counted(), free.owner, runId, 1))).toMatchObject({
        usage: 1,
        resolve: 1,
      });
      const paid = await seed("changemaker");
      const pa = await chat(paid.project);
      const pr = await reads(async () => {
        runId = String((await start(counted(), paid.owner, paid.project, pa)).id);
      });
      expect(pr).toMatchObject({ usage: 0, resolve: 0 });
      expect(await reads(() => append(counted(), paid.owner, runId, 1))).toMatchObject({
        usage: 0,
        resolve: 0,
      });
    } finally {
      await c.close();
    }
  });

  test("a run on a deleted chat is not found and stores nothing", async () => {
    const { owner, project } = await seed();
    const a = await chat(project);
    await sql`update project_chat set deleted_at = now() where id = ${a}`;
    expect(await rejection(start(deps(), owner, project, a))).toMatchObject({ status: 404 });
    expect(await runs(project)).toBe(0);
    expect(await userMessages(a)).toBe(0);
  });

  test("paid projects are untouched", async () => {
    const { owner, billing, project } = await seed("changemaker");
    await spend(billing, LIMIT * 2);
    const d = deps();
    const a = await chat(project);
    const r = await start(d, owner, project, a);
    for (let i = 1; i <= 25; i++) await append(d, owner, String(r.id), i);
    expect(await userMessages(a)).toBe(26);
    const solo = await start(d, owner, project, null);
    await append(d, owner, String(solo.id), 1);
    expect(await userEvents(String(solo.id))).toBe(2);
  });
});
