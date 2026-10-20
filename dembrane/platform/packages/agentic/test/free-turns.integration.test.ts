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
import { allowanceForProject, invalidateFreeLimits, usedThisPeriod } from "@dembrane/allowance";
import { chatsStorage, freeChats } from "@dembrane/chats";
import { newId } from "@dembrane/core";
import { connect, createDb } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { createLogger } from "@dembrane/observability";
import type postgres from "postgres";
import { appendMessage, createRun, type RunsDeps } from "../src/runs/service";
import { runsStorage } from "../src/runs/storage";
import { prepareDb } from "./fixtures/runs-db";

// Agentic turns spend the same free chat slots and per-chat turns as the classic chat.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `agentic_free_turns_${process.pid}`;
const now = new Date("2026-10-20T10:00:00Z");
const OCT = "2026-10-01T00:00:00.000Z";

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

run("agentic turns spend the same allowance", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let access: Access;

  beforeAll(async () => {
    const url = await prepareDb(admin as string, dbName);
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

  async function seed(tier = "free") {
    const owner = { appUserId: newId(), directusUserId: newId(), isStaff: false } as Person;
    await sql`insert into directus_users (id) values (${owner.directusUserId})`;
    await sql`insert into app_user (id, directus_user_id) values (${owner.appUserId}, ${owner.directusUserId})`;
    const [org, billing, ws, project] = [newId(), newId(), newId(), newId()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, ${tier})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role) values (${newId()}, ${ws}, ${owner.appUserId}, 'owner')`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, directus_user_id)
      values (${project}, 'P', ${ws}, true, ${owner.directusUserId})`;
    return { owner, project };
  }

  async function chat(projectId: string, stamp: string | null = null) {
    const id = newId();
    await sql`insert into project_chat (id, project_id, chat_mode, free_period_start)
      values (${id}, ${projectId}, 'agentic', ${stamp})`;
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

  async function stamp(chatId: string): Promise<string | null> {
    const [row] = await sql`select free_period_start from project_chat where id = ${chatId}`;
    return row?.free_period_start ? (row.free_period_start as Date).toISOString() : null;
  }

  const count = async (q: postgres.PendingQuery<postgres.Row[]>) => Number((await q)[0]?.n);
  const userMessages = (chatId: string) =>
    count(sql`select count(*) as n from project_chat_message
      where project_chat_id = ${chatId} and message_from = 'user'`);
  const userEvents = (runId: string) =>
    count(sql`select count(*) as n from project_agentic_run_event
      where project_agentic_run_id = ${runId} and event_type = 'user.message'`);
  const runs = (projectId: string) =>
    count(sql`select count(*) as n from project_agentic_run where project_id = ${projectId}`);

  async function chatsUsed(projectId: string) {
    const a = await allowanceForProject(database.db, projectId, now);
    if (!a) throw new Error("expected a free account");
    return (await usedThisPeriod(database.db, a)).chats;
  }

  test("a run claims a slot and its chat gets 20 turns", async () => {
    const { owner, project } = await seed();
    const d = deps();
    const a = await chat(project);
    const r = await start(d, owner, project, a);
    const runId = String(r.id);
    expect(await stamp(a)).toBe(OCT);
    expect(await chatsUsed(project)).toBe(1);
    for (let i = 1; i < 20; i++) await append(d, owner, runId, i);
    expect(await userMessages(a)).toBe(20);
    const before = await userEvents(runId);
    const err = await rejection(append(d, owner, runId, 20));
    expect(err).toMatchObject({ status: 402, details: { limit: "chat_turns" } });
    expect(await userEvents(runId)).toBe(before);
    expect(await userMessages(a)).toBe(20);
  });

  test("classic and agentic chats share the monthly slots", async () => {
    const { owner, project } = await seed();
    const d = deps();
    const fc = freeChats(database.db);
    const a = await chat(project);
    await start(d, owner, project, a);
    const b = await chat(project);
    for (let i = 0; i < 20; i++)
      await fc.admitTurn({ projectId: project, chatId: b, messageId: newId(), text: "q", now });
    const full = await rejection(start(d, owner, project, b));
    expect(full).toMatchObject({ status: 402, details: { limit: "chat_turns" } });
    const c = await chat(project);
    const third = await rejection(start(d, owner, project, c));
    expect(third).toMatchObject({ status: 402, details: { limit: "chats" } });
    expect(await userMessages(c)).toBe(0);
    expect(await runs(project)).toBe(1);
  });

  test("a run without a chat is refused on free", async () => {
    const { owner, project } = await seed();
    const err = await rejection(start(deps(), owner, project, null));
    expect(err).toMatchObject({ status: 402, details: { limit: "chats" } });
    expect(await runs(project)).toBe(0);
    const legacy = newId();
    await runsStorage(database.db).create({
      id: legacy,
      projectId: project,
      chatId: null,
      directusUserId: owner.directusUserId,
      now,
    });
    const more = await rejection(append(deps(), owner, legacy, 1));
    expect(more).toMatchObject({ status: 402, details: { limit: "chats" } });
    expect(await userEvents(legacy)).toBe(0);
  });

  test("a chat from an earlier period is frozen", async () => {
    const { owner, project } = await seed();
    const old = await chat(project, "2026-09-01T00:00:00Z");
    const runId = newId();
    await runsStorage(database.db).create({
      id: runId,
      projectId: project,
      chatId: old,
      directusUserId: owner.directusUserId,
      now,
    });
    const err = await rejection(append(deps(), owner, runId, 1));
    expect(err).toMatchObject({ status: 402, details: { limit: "chat_turns" } });
    expect(await userMessages(old)).toBe(0);
  });

  test("a failed run gives the turn and the slot back", async () => {
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
    expect(await stamp(a)).toBeNull();
    expect(await chatsUsed(project)).toBe(0);
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
    expect(await stamp(a)).toBe(OCT);
    expect(await chatsUsed(project)).toBe(1);
  });

  test("paid projects are untouched", async () => {
    const { owner, project } = await seed("changemaker");
    const d = deps();
    const a = await chat(project);
    const r = await start(d, owner, project, a);
    for (let i = 1; i <= 25; i++) await append(d, owner, String(r.id), i);
    expect(await userMessages(a)).toBe(26);
    expect(await stamp(a)).toBeNull();
    const rows = await sql`select fu.key from free_usage fu
      join workspace w on w.billing_account_id = fu.billing_account_id
      join project p on p.workspace_id = w.id where p.id = ${project}`;
    expect(rows.length).toBe(0);
    const solo = await start(d, owner, project, null);
    await append(d, owner, String(solo.id), 1);
    expect(await userEvents(String(solo.id))).toBe(2);
  });
});
