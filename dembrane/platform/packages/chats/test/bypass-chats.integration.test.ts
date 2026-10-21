import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { allowanceForProject, invalidateFreeLimits, usedThisPeriod } from "@dembrane/allowance";
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env } from "@dembrane/http";
import { Hono } from "hono";
import type postgres from "postgres";
import { freeChats, type UserTurn } from "../src/free";
import { chatRoutes } from "../src/routes";
import { chatsStorage } from "../src/storage";

// Adversarial replays: each test passes only once the bypass is closed.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `chats_bypass_${process.pid}`;
const now = new Date("2026-10-20T10:00:00Z");

const rejection = (p: Promise<unknown>) =>
  Promise.resolve(p).then(
    () => null,
    (e) => e,
  );

run("free chat bypasses", () => {
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

  async function seed() {
    const id = () => crypto.randomUUID() as string;
    const [org, billing, ws, own] = [id(), id(), id(), id()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into project (id, name, workspace_id, is_conversation_allowed)
      values (${own}, 'Mine', ${ws}, true)`;
    return { own };
  }

  async function chat(projectId: string) {
    const id = crypto.randomUUID();
    await sql`insert into project_chat (id, project_id) values (${id}, ${projectId})`;
    return id;
  }

  const turn = (projectId: string, chatId: string, text: string): UserTurn => ({
    projectId,
    chatId,
    messageId: crypto.randomUUID(),
    text,
    now,
  });

  async function used(projectId: string) {
    const a = await allowanceForProject(database.db, projectId, now);
    if (!a) throw new Error("expected a free account");
    return (await usedThisPeriod(database.db, a)).chats;
  }

  const userMessages = async (chatId: string) =>
    Number(
      (
        await sql`select count(*) as n from project_chat_message
          where project_chat_id = ${chatId} and message_from = 'user'`
      )[0]?.n,
    );

  // The column still refuses a key over 255; the route cap keeps it from reaching a turn.
  test("a client-forced failure after admit is real (template_key over 255)", async () => {
    const { own } = await seed();
    const c = await chat(own);
    const t = turn(own, c, "first");
    await freeChats(database.db).admitTurn(t);
    const err = await rejection(
      chatsStorage(database.db).updateMessage(t.messageId, { template_key: "x".repeat(300) }, now),
    );
    expect(err).not.toBeNull();
  });

  // The route refuses the trigger before admit, so nothing is stored or claimed.
  test("the reply route refuses a template_key over 255 before admit", async () => {
    const { own } = await seed();
    const c = await chat(own);
    const app = new Hono<Env>();
    app.use(async (ctx, next) => {
      ctx.set("principal", { appUserId: "a", directusUserId: "d", isStaff: false } as never);
      await next();
    });
    app.onError((e) => Response.json({}, { status: (e as { status?: number }).status ?? 500 }));
    app.route("/", chatRoutes({ db: database.db } as never));
    const post = (key: string) =>
      app.request(`/api/chats/${c}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], template_key: key }),
      });
    expect((await post("x".repeat(256))).status).toBe(422);
    expect(await userMessages(c)).toBe(0);
    expect(await used(own)).toBe(0);
  });

  // Turn A claims the chat's slot, turn B lands in the same chat, then A fails and undoes.
  // The undo clears the stamp and gives the slot back although B was admitted and answered.
  test("undoing the claiming turn keeps the slot while another turn in the chat was admitted", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    const c = await chat(own);
    const a = turn(own, c, "A: fails later (template_key too long)");
    const b = turn(own, c, "B: answered");
    const admittedA = await fc.admitTurn(a);
    expect(admittedA.claimed).toBe(true);
    const admittedB = await fc.admitTurn(b);
    expect(admittedB.claimed).toBe(false);
    await fc.undoTurn(a, admittedA);
    expect(await userMessages(c)).toBe(1);
    // B was served from this chat, so the chat must still hold its slot.
    expect(await used(own)).toBe(1);
  });

  // Repeating the race in fresh chats serves turns in more than 2 chats with no slot spent.
  test("the race serves a third chat in the month", async () => {
    const { own } = await seed();
    const fc = freeChats(database.db);
    let served = 0;
    for (let i = 0; i < 3; i++) {
      const c = await chat(own);
      const a = turn(own, c, "A");
      const b = turn(own, c, "B");
      // Once the slots are spent, A itself is refused and nothing is served.
      const admittedA = await fc.admitTurn(a).catch(() => null);
      if (!admittedA) continue;
      const ok = await rejection(fc.admitTurn(b));
      await fc.undoTurn(a, admittedA);
      if (ok === null) served += 1;
    }
    expect(served).toBe(2);
  });
});
