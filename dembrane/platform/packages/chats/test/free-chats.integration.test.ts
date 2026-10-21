import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  allowanceForProject,
  invalidateFreeLimits,
  setFreeLimit,
  usedThisPeriod,
} from "@dembrane/allowance";
import { connect, createDb, migrate } from "@dembrane/db";
import type postgres from "postgres";
import { freeChats, type UserTurn } from "../src/free";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `chats_free_chats_${process.pid}`;
const now = new Date("2026-10-20T10:00:00Z");
const OCT = "2026-10-01T00:00:00.000Z";

const rejection = (p: Promise<unknown>) =>
  Promise.resolve(p).then(
    () => null,
    (e) => e,
  );

run("free chat slots and turns", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 12 });
    sql = connect(url, { max: 2, onnotice: () => {} });
  });
  beforeEach(() => invalidateFreeLimits());
  afterAll(async () => {
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.end();
  });

  // An org with one pooled account, a workspace, an own project and a sample project.
  async function seed(opts: { tier?: string; downgradedAt?: string; noWorkspace?: boolean } = {}) {
    const id = () => crypto.randomUUID() as string;
    const [org, billing, ws, own, sample] = [id(), id(), id(), id(), id()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier, downgraded_at)
      values (${billing}, ${org}, ${opts.tier ?? "free"}, ${opts.downgradedAt ?? null})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed)
      values (${own}, 'Mine', ${opts.noWorkspace ? null : ws}, true)`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed, is_sample)
      values (${sample}, 'Sample', ${ws}, false, true)`;
    return { billing, own, sample };
  }

  async function chat(projectId: string) {
    const id = crypto.randomUUID();
    await sql`insert into project_chat (id, project_id) values (${id}, ${projectId})`;
    return id;
  }

  const turn = (projectId: string, chatId: string, n: number): UserTurn => ({
    projectId,
    chatId,
    messageId: crypto.randomUUID(),
    text: `turn ${n}`,
    now,
  });

  async function turns(projectId: string, chatId: string, n: number) {
    const fc = freeChats(database.db);
    for (let i = 0; i < n; i++) await fc.admitTurn(turn(projectId, chatId, i));
  }

  async function stamp(chatId: string): Promise<string | null> {
    const [row] = await sql`select free_period_start from project_chat where id = ${chatId}`;
    return row?.free_period_start ? (row.free_period_start as Date).toISOString() : null;
  }

  const messages = async (chatId: string) =>
    Number(
      (
        await sql`select count(*) as n from project_chat_message where project_chat_id = ${chatId}`
      )[0]?.n,
    );

  async function used(projectId: string) {
    const a = await allowanceForProject(database.db, projectId, now);
    if (!a) throw new Error("expected a free account");
    return usedThisPeriod(database.db, a);
  }

  async function seedMessage(chatId: string, at: string) {
    await sql`insert into project_chat_message (id, project_chat_id, message_from, text, date_created)
      values (${crypto.randomUUID()}, ${chatId}, 'user', 'old', ${at})`;
  }

  test("each chat gets 20 turns", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    for (const c of [await chat(own), await chat(own)]) {
      for (let i = 0; i < 20; i++) {
        const admitted = await fc.admitTurn(turn(own, c, i));
        expect(admitted.claimed).toBe(i === 0);
        expect(admitted.account).not.toBeNull();
      }
      const err = await rejection(fc.admitTurn(turn(own, c, 20)));
      expect(err).toMatchObject({
        status: 402,
        details: { limit: "chat_turns", used: 20, cap: 20 },
      });
      expect(await messages(c)).toBe(20);
      expect(await stamp(c)).toBe(OCT);
    }
    expect((await used(own)).chats).toBe(2);
  });

  test("a stored turn leaves date_updated empty, as Directus does", async () => {
    const { own, sample } = await seed();
    const c = await chat(own);
    const s = await chat(sample);
    await turns(own, c, 1);
    await turns(sample, s, 1);
    const rows = await sql`select date_updated from project_chat_message
      where project_chat_id in (${c}, ${s})`;
    expect(rows.map((r) => r.date_updated)).toEqual([null, null]);
  });

  test("a third chat is refused", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    await turns(own, await chat(own), 1);
    await turns(own, await chat(own), 1);
    const c = await chat(own);
    const err = await rejection(fc.admitTurn(turn(own, c, 0)));
    expect(err).toMatchObject({ status: 402, details: { limit: "chats", used: 2, cap: 2 } });
    expect(await messages(c)).toBe(0);
    expect(await stamp(c)).toBeNull();
    expect(await rejection(fc.canStartChat(own, now))).toMatchObject({
      details: { limit: "chats" },
    });
    expect((await used(own)).chats).toBe(2);
  });

  test("staff turns apply to every chat at once", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    const a = await chat(own);
    await turns(own, a, 20);
    await setFreeLimit(database.db, "chat_turns_per_chat", 5, null);
    try {
      expect(await rejection(fc.admitTurn(turn(own, a, 20)))).toMatchObject({
        details: { limit: "chat_turns", used: 20, cap: 5 },
      });
      const b = await chat(own);
      await turns(own, b, 5);
      expect(await rejection(fc.admitTurn(turn(own, b, 5)))).toMatchObject({
        details: { limit: "chat_turns", used: 5, cap: 5 },
      });
    } finally {
      await setFreeLimit(database.db, "chat_turns_per_chat", 20, null);
    }
  });

  test("deleting a chat does not refill", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    const a = await chat(own);
    await turns(own, a, 1);
    await sql`update project_chat set deleted_at = now() where id = ${a}`;
    await turns(own, await chat(own), 1);
    expect(await rejection(fc.admitTurn(turn(own, await chat(own), 0)))).toMatchObject({
      details: { limit: "chats" },
    });
  });

  test("a chat from last month is frozen", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    const c = await chat(own);
    await sql`update project_chat set free_period_start = '2026-09-01T00:00:00Z' where id = ${c}`;
    await seedMessage(c, "2026-09-10T10:00:00Z");
    await seedMessage(c, "2026-09-11T10:00:00Z");
    expect(await rejection(fc.admitTurn(turn(own, c, 2)))).toMatchObject({
      status: 402,
      details: { limit: "chat_turns", reason: "frozen" },
    });
    expect(await fc.turnStatus(c, own, now)).toEqual({ limit: 20, used: 0, frozen: true });
    expect((await used(own)).chats).toBe(0);
    expect(await messages(c)).toBe(2);
  });

  test("turns before the period do not count", async () => {
    const { own } = await seed({ downgradedAt: "2026-10-20T08:00:00Z" });
    const fc = freeChats(database.db);
    const c = await chat(own);
    for (let i = 0; i < 5; i++) await seedMessage(c, "2026-10-19T12:00:00Z");
    const admitted = await fc.admitTurn(turn(own, c, 5));
    expect(admitted.claimed).toBe(true);
    expect(await stamp(c)).toBe("2026-10-20T08:00:00.000Z");
    expect(await fc.turnStatus(c, own, now)).toEqual({ limit: 20, used: 1, frozen: false });
  });

  test("undoTurn gives the slot back once", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    const other = await chat(own);
    await turns(own, other, 1);
    const a = await chat(own);
    const first = turn(own, a, 0);
    const admitted = await fc.admitTurn(first);
    expect(admitted.claimed).toBe(true);
    expect((await used(own)).chats).toBe(2);
    await fc.undoTurn(first, admitted);
    await fc.undoTurn(first, admitted);
    expect(await messages(a)).toBe(0);
    expect(await stamp(a)).toBeNull();
    expect((await used(own)).chats).toBe(1);

    const second = turn(own, other, 1);
    const plain = await fc.admitTurn(second);
    expect(plain.claimed).toBe(false);
    await fc.undoTurn(second, plain);
    expect(await messages(other)).toBe(1);
    expect(await stamp(other)).toBe(OCT);
    expect((await used(own)).chats).toBe(1);
  });

  test("two chats race for the last slot", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    await turns(own, await chat(own), 1);
    const chats = await Promise.all(Array.from({ length: 10 }, () => chat(own)));
    const results = await Promise.allSettled(chats.map((c) => fc.admitTurn(turn(own, c, 0))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await used(own)).chats).toBe(2);
  });

  test("concurrent turns stop at the limit", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    const c = await chat(own);
    await turns(own, c, 19);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => fc.admitTurn(turn(own, c, 19 + i))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await messages(c)).toBe(20);
  });

  test("unlimited accounts skip every rule", async () => {
    const fc = freeChats(database.db);
    const projects = [
      ...(await Promise.all(["innovator", "pioneer", "mystery"].map((tier) => seed({ tier })))),
      await seed({ noWorkspace: true }),
    ];
    for (const { own, billing } of projects) {
      const first = await chat(own);
      await turns(own, first, 25);
      for (let i = 0; i < 4; i++) await turns(own, await chat(own), 1);
      expect(await stamp(first)).toBeNull();
      expect(await fc.turnStatus(first, own, now)).toBeNull();
      await fc.canStartChat(own, now);
      const rows = await sql`select 1 from free_usage where billing_account_id = ${billing}`;
      expect(rows).toHaveLength(0);
    }
  });

  test("a sample project keeps its shared ten turns and spends no slot", async () => {
    const { own, sample, billing } = await seed();
    const fc = freeChats(database.db);
    const [a, b] = [await chat(sample), await chat(sample)];
    await turns(sample, a, 5);
    await turns(sample, b, 5);
    expect(await rejection(fc.admitTurn(turn(sample, a, 5)))).toMatchObject({
      status: 402,
      details: { limit: "chat_turns" },
    });
    expect(await messages(a)).toBe(5);
    expect(await stamp(a)).toBeNull();
    expect(await stamp(b)).toBeNull();
    expect(await fc.turnStatus(a, sample, now)).toBeNull();
    await fc.canStartChat(sample, now);
    expect(await sql`select 1 from free_usage where billing_account_id = ${billing}`).toHaveLength(
      0,
    );
    expect((await used(own)).chats).toBe(0);
  });

  test("a retried message id is a no-op and keeps its conversation links", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    const c = await chat(own);
    const conv = crypto.randomUUID();
    await sql`insert into conversation (id, project_id) values (${conv}, ${own})`;
    const first = { ...turn(own, c, 0), templateKey: "summarize", usedConversationIds: [conv] };
    expect((await fc.admitTurn(first)).claimed).toBe(true);
    expect((await fc.admitTurn(first)).claimed).toBe(false);
    expect(await messages(c)).toBe(1);
    const [row] =
      await sql`select template_key from project_chat_message where id = ${first.messageId}`;
    expect(row?.template_key).toBe("summarize");
    const links = await sql`select conversation_id from project_chat_message_conversation
      where project_chat_message_id = ${first.messageId}`;
    expect(links.map((l) => l.conversation_id)).toEqual([conv]);
    expect((await used(own)).chats).toBe(1);
  });

  test("a chat from another project or a deleted chat is not found", async () => {
    const { own } = await seed();
    const other = await seed();
    const fc = freeChats(database.db);
    const foreign = await chat(other.own);
    expect(await rejection(fc.admitTurn(turn(own, foreign, 0)))).toMatchObject({ status: 404 });
    const gone = await chat(own);
    await sql`update project_chat set deleted_at = now() where id = ${gone}`;
    expect(await rejection(fc.admitTurn(turn(own, gone, 0)))).toMatchObject({ status: 404 });
    expect(await messages(foreign)).toBe(0);
    expect(await messages(gone)).toBe(0);
    expect(await stamp(foreign)).toBeNull();
    expect((await used(own)).chats).toBe(0);
    expect((await used(other.own)).chats).toBe(0);
  });

  test("a retry at the cap is a no-op", async () => {
    const { own, sample } = await seed();
    const fc = freeChats(database.db);
    const c = await chat(own);
    await turns(own, c, 19);
    const last = turn(own, c, 19);
    await fc.admitTurn(last);
    expect(await fc.admitTurn(last)).toMatchObject({ claimed: false, inserted: false });
    expect(await messages(c)).toBe(20);
    const s = await chat(sample);
    await turns(sample, s, 9);
    const tenth = turn(sample, s, 9);
    await fc.admitTurn(tenth);
    expect(await fc.admitTurn(tenth)).toMatchObject({ claimed: false, inserted: false });
    expect(await messages(s)).toBe(10);
  });

  test("a message id from another chat is refused with no slot taken", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    const a = await chat(own);
    const first = turn(own, a, 0);
    await fc.admitTurn(first);
    const b = await chat(own);
    const err = await rejection(fc.admitTurn({ ...first, chatId: b }));
    expect(err).toMatchObject({ status: 400 });
    expect(await stamp(b)).toBeNull();
    expect(await messages(b)).toBe(0);
    expect((await used(own)).chats).toBe(1);
  });

  test("undo after a no-op retry keeps the original message", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    const c = await chat(own);
    const first = turn(own, c, 0);
    await fc.admitTurn(first);
    const retry = await fc.admitTurn(first);
    expect(retry.inserted).toBe(false);
    await fc.undoTurn(first, retry);
    expect(await messages(c)).toBe(1);
    expect(await stamp(c)).toBe(OCT);
    expect((await used(own)).chats).toBe(1);
  });
});
