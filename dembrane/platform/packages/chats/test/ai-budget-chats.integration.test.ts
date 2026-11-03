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
import { connect, createDb, migrate } from "@dembrane/db";
import type { Env, Signed } from "@dembrane/http";
import { fakeModels } from "@dembrane/llm";
import { createLogger, withPayer } from "@dembrane/observability";
import { Hono } from "hono";
import type postgres from "postgres";
import { freeChats, type UserTurn } from "../src/free";
import { chatRoutes } from "../src/routes";

// Chats refuse at a used-up AI budget; no chat slots, turn caps or frozen chats any more.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const dbName = `chats_ai_budget_${process.pid}`;
const now = new Date("2026-10-20T10:00:00Z");
const OCT = "2026-10-01T00:00:00Z";
const LIMIT = 5_000_000;

const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

const rejection = (p: Promise<unknown>) =>
  Promise.resolve(p).then(
    () => null,
    (e) => e,
  );

run("chats and the AI budget", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  let access: Access;

  beforeAll(async () => {
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${dbName} with (force)`);
    await a.unsafe(`create database ${dbName}`);
    await a.end();
    const url = `${(admin as string).slice(0, (admin as string).lastIndexOf("/"))}/${dbName}`;
    await migrate(url, { appEnv: "test" });
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

  const id = () => crypto.randomUUID() as string;

  // An owner, an org with one account, a workspace, an own project and a sample project.
  async function seed(tier = "free") {
    const owner: Signed = { appUserId: id(), directusUserId: id(), isStaff: false };
    await sql`insert into directus_users (id) values (${owner.directusUserId})`;
    await sql`insert into app_user (id, directus_user_id) values (${owner.appUserId}, ${owner.directusUserId})`;
    const [org, billing, ws, own, sample] = [id(), id(), id(), id(), id()];
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, ${tier})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role)
      values (${id()}, ${ws}, ${owner.appUserId}, 'owner')`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, directus_user_id)
      values (${own}, 'Mine', 'en', ${ws}, true, ${owner.directusUserId})`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed, is_sample, directus_user_id)
      values (${sample}, 'Sample', 'en', ${ws}, false, true, ${owner.directusUserId})`;
    return { owner, billing, own, sample };
  }

  async function spend(billing: string, amount: number) {
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${billing}, ${OCT}, ${AI_SPEND_KEY}, ${amount})
      on conflict (billing_account_id, period_start, key) do update set amount = excluded.amount`;
  }

  // Named, so a reply makes no title call.
  async function chat(projectId: string, mode: string | null = "deep_dive") {
    const c = id();
    await sql`insert into project_chat (id, project_id, name, chat_mode, date_created)
      values (${c}, ${projectId}, 'Existing', ${mode}, ${OCT})`;
    return c;
  }

  async function seedTurns(chatId: string, n: number, at = "2026-10-10T10:00:00Z") {
    for (let i = 0; i < n; i++)
      await sql`insert into project_chat_message (id, project_chat_id, message_from, text, date_created)
        values (${id()}, ${chatId}, 'user', ${`old ${i}`}, ${at})`;
  }

  const count = async (q: postgres.PendingQuery<postgres.Row[]>) => Number((await q)[0]?.n);
  const userMessages = (chatId: string) =>
    count(sql`select count(*) as n from project_chat_message
      where project_chat_id = ${chatId} and message_from = 'user'`);
  const chatsOf = (projectId: string) =>
    count(sql`select count(*) as n from project_chat where project_id = ${projectId}`);
  const ledger = (billing: string) =>
    sql`select key, period_start, amount from free_usage
      where billing_account_id = ${billing} order by key`;
  async function stamp(chatId: string): Promise<string | null> {
    const [row] = await sql`select free_period_start from project_chat where id = ${chatId}`;
    return row?.free_period_start ? (row.free_period_start as Date).toISOString() : null;
  }

  // The chat routes as the API mounts them: a signed-in host, every model call under a payer.
  function app(who: Signed, opts: { fail?: boolean } = {}) {
    const a = new Hono<Env>();
    a.use(async (c, next) => {
      c.set("principal", who);
      await withPayer({ ref: "chat", id: "chat-under-test" }, () => next());
    });
    a.onError((e) => {
      const err = e as { status?: number; details?: unknown };
      return Response.json({ details: err.details ?? null }, { status: err.status ?? 500 });
    });
    a.route(
      "/",
      chatRoutes({
        db: database.db,
        access,
        models: fakeModels(
          opts.fail
            ? { fail: Object.assign(new Error("boom"), { isRetryable: false }) }
            : { stream: ["An ", "answer"] },
        ),
        limiter: { check: async () => {} },
        capture: async () => {},
        logger: quiet,
        now: () => now,
      }),
    );
    const call = (method: string, path: string, body?: unknown) =>
      a.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    return {
      send: (chatId: string, text = "hi", templateKey: string | null = null) =>
        call("POST", `/api/chats/${chatId}?protocol=data`, {
          messages: [{ role: "user", content: text }],
          template_key: templateKey,
        }),
      createChat: (projectId: string) =>
        call("POST", "/api/v2/bff/chats", { project_id: projectId, name: null }),
      suggestions: (chatId: string) => call("GET", `/api/chats/${chatId}/suggestions`),
      initialize: (chatId: string, projectId: string, mode = "overview") =>
        call("POST", `/api/chats/${chatId}/initialize-mode`, { mode, project_id: projectId }),
    };
  }

  const turn = (projectId: string, chatId: string, n: number): UserTurn => ({
    projectId,
    chatId,
    messageId: id(),
    text: `turn ${n}`,
    now,
  });

  async function refusedForBudget(res: Response) {
    expect(res.status).toBe(402);
    expect(((await res.json()) as { details: unknown }).details).toMatchObject({
      limit: "ai_budget",
      used: LIMIT,
      cap: LIMIT,
      resets_at: "2026-11-01T00:00:00.000Z",
    });
  }

  describe("a free project with its budget used up", () => {
    test("a chat message is refused and nothing is stored", async () => {
      const s = await seed();
      await spend(s.billing, LIMIT);
      const c = await chat(s.own);
      await refusedForBudget(await app(s.owner).send(c));
      expect(await userMessages(c)).toBe(0);
    });

    test("a new chat is refused", async () => {
      const s = await seed();
      await spend(s.billing, LIMIT);
      await refusedForBudget(await app(s.owner).createChat(s.own));
      expect(await chatsOf(s.own)).toBe(0);
    });

    test("suggestions are refused", async () => {
      const s = await seed();
      await spend(s.billing, LIMIT);
      await refusedForBudget(await app(s.owner).suggestions(await chat(s.own)));
    });

    test("overview mode, which summarises conversations, is refused", async () => {
      const s = await seed();
      await spend(s.billing, LIMIT);
      const c = await chat(s.own, null);
      await refusedForBudget(await app(s.owner).initialize(c, s.own));
      const [row] = await sql`select chat_mode from project_chat where id = ${c}`;
      expect(row?.chat_mode).toBeNull();
    });

    test("deep dive mode makes no model call and is still set", async () => {
      const s = await seed();
      await spend(s.billing, LIMIT);
      const c = await chat(s.own, null);
      expect((await app(s.owner).initialize(c, s.own, "deep_dive")).status).toBe(200);
    });

    test("one micro-euro under the limit still passes", async () => {
      const s = await seed();
      await spend(s.billing, LIMIT - 1);
      const c = await chat(s.own);
      const res = await app(s.owner).send(c);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("answer");
      expect(await userMessages(c)).toBe(1);
    });
  });

  describe("below the limit", () => {
    test("a 21st turn in one chat succeeds", async () => {
      const s = await seed();
      await spend(s.billing, 1_000_000);
      const c = await chat(s.own);
      await seedTurns(c, 20);
      const res = await app(s.owner).send(c);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("answer");
      expect(await userMessages(c)).toBe(21);
    });

    test("a chat from last month accepts a new turn", async () => {
      const s = await seed();
      const c = await chat(s.own);
      await sql`update project_chat set free_period_start = '2026-09-01T00:00:00Z' where id = ${c}`;
      await seedTurns(c, 2, "2026-09-10T10:00:00Z");
      const res = await app(s.owner).send(c);
      expect(res.status).toBe(200);
      await res.text();
      expect(await userMessages(c)).toBe(3);
      expect(await stamp(c)).toBe("2026-09-01T00:00:00.000Z");
    });

    test("any number of chats; a turn neither stamps the chat nor counts it", async () => {
      const s = await seed();
      const h = app(s.owner);
      for (let i = 0; i < 4; i++) {
        const res = await h.createChat(s.own);
        expect(res.status).toBe(200);
        const c = String(((await res.json()) as { id: string }).id);
        await sql`update project_chat set name = 'Named' where id = ${c}`;
        const sent = await h.send(c);
        expect(sent.status).toBe(200);
        await sent.text();
        expect(await stamp(c)).toBeNull();
      }
      expect(await ledger(s.billing)).toHaveLength(0);
    });
  });

  describe("a sample project in a free account at zero", () => {
    test("turns work up to the shared ten-turn cap, then chat_turns", async () => {
      const s = await seed();
      await spend(s.billing, LIMIT);
      const h = app(s.owner);
      const created = await h.createChat(s.sample);
      expect(created.status).toBe(200);
      const a = String(((await created.json()) as { id: string }).id);
      await sql`update project_chat set name = 'Named' where id = ${a}`;
      const b = await chat(s.sample);
      expect((await h.suggestions(await chat(s.sample, null))).status).toBe(200);
      for (let i = 0; i < 10; i++) {
        const res = await h.send(i % 2 === 0 ? a : b, `q ${i}`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("answer");
      }
      const res = await h.send(a);
      expect(res.status).toBe(402);
      expect(((await res.json()) as { details: unknown }).details).toMatchObject({
        limit: "chat_turns",
        used: 10,
        cap: 10,
      });
      expect((await userMessages(a)) + (await userMessages(b))).toBe(10);
      expect(await stamp(a)).toBeNull();
    });

    test("a paid account's sample has no turn cap", async () => {
      const s = await seed("innovator");
      const c = await chat(s.sample);
      await seedTurns(c, 10);
      const fc = freeChats(database.db);
      expect(await fc.admitTurn(turn(s.sample, c, 10))).toEqual({ inserted: true });
      expect(await userMessages(c)).toBe(11);
    });
  });

  test("a failed reply removes the stored message and changes no ledger row", async () => {
    const s = await seed();
    await spend(s.billing, 1_000_000);
    const before = await ledger(s.billing);
    const c = await chat(s.own);
    await seedTurns(c, 1);
    const res = await app(s.owner, { fail: true }).send(c);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('3:"An error occurred while processing the chat response."\n');
    expect(await userMessages(c)).toBe(1);
    expect(await ledger(s.billing)).toEqual(before);
    expect(await stamp(c)).toBeNull();
  });

  // The column refuses a key over 255; the route cap keeps it from reaching a turn.
  test("the reply route refuses a template_key over 255 before admit", async () => {
    const s = await seed();
    const c = await chat(s.own);
    expect((await app(s.owner).send(c, "hi", "x".repeat(256))).status).toBe(422);
    expect(await userMessages(c)).toBe(0);
    expect(await ledger(s.billing)).toHaveLength(0);
  });

  describe("admitTurn", () => {
    test("a stored turn leaves date_updated empty, as Directus does", async () => {
      const s = await seed();
      const fc = freeChats(database.db);
      const c = await chat(s.own);
      const sc = await chat(s.sample);
      await fc.admitTurn(turn(s.own, c, 0));
      await fc.admitTurn(turn(s.sample, sc, 0));
      const rows = await sql`select date_updated from project_chat_message
        where project_chat_id in (${c}, ${sc})`;
      expect(rows.map((r) => r.date_updated)).toEqual([null, null]);
    });

    test("a retried message id is a no-op and keeps its conversation links", async () => {
      const s = await seed();
      const fc = freeChats(database.db);
      const c = await chat(s.own);
      const conv = id();
      await sql`insert into conversation (id, project_id) values (${conv}, ${s.own})`;
      const first = { ...turn(s.own, c, 0), templateKey: "summarize", usedConversationIds: [conv] };
      expect(await fc.admitTurn(first)).toEqual({ inserted: true });
      expect(await fc.admitTurn(first)).toEqual({ inserted: false });
      expect(await userMessages(c)).toBe(1);
      const [row] =
        await sql`select template_key from project_chat_message where id = ${first.messageId}`;
      expect(row?.template_key).toBe("summarize");
      const links = await sql`select conversation_id from project_chat_message_conversation
        where project_chat_message_id = ${first.messageId}`;
      expect(links.map((l) => l.conversation_id)).toEqual([conv]);
    });

    test("a retry at the sample cap is a no-op", async () => {
      const s = await seed();
      const fc = freeChats(database.db);
      const c = await chat(s.sample);
      await seedTurns(c, 9);
      const tenth = turn(s.sample, c, 9);
      await fc.admitTurn(tenth);
      expect(await fc.admitTurn(tenth)).toEqual({ inserted: false });
      expect(await userMessages(c)).toBe(10);
    });

    test("a message id from another chat is refused", async () => {
      const s = await seed();
      const fc = freeChats(database.db);
      const first = turn(s.own, await chat(s.own), 0);
      await fc.admitTurn(first);
      const b = await chat(s.own);
      expect(await rejection(fc.admitTurn({ ...first, chatId: b }))).toMatchObject({ status: 400 });
      expect(await userMessages(b)).toBe(0);
    });

    test("a chat from another project or a deleted chat is not found", async () => {
      const s = await seed();
      const other = await seed();
      const fc = freeChats(database.db);
      const foreign = await chat(other.own);
      expect(await rejection(fc.admitTurn(turn(s.own, foreign, 0)))).toMatchObject({
        status: 404,
      });
      const gone = await chat(s.own);
      await sql`update project_chat set deleted_at = now() where id = ${gone}`;
      expect(await rejection(fc.admitTurn(turn(s.own, gone, 0)))).toMatchObject({ status: 404 });
      expect(await userMessages(foreign)).toBe(0);
      expect(await userMessages(gone)).toBe(0);
    });

    test("undo deletes the message once; after a no-op retry it keeps the original", async () => {
      const s = await seed();
      const fc = freeChats(database.db);
      const c = await chat(s.own);
      const first = turn(s.own, c, 0);
      const admitted = await fc.admitTurn(first);
      const retry = await fc.admitTurn(first);
      await fc.undoTurn(first, retry);
      expect(await userMessages(c)).toBe(1);
      await fc.undoTurn(first, admitted);
      await fc.undoTurn(first, admitted);
      expect(await userMessages(c)).toBe(0);
      expect(await ledger(s.billing)).toHaveLength(0);
    });
  });
});
