import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import type { Access, Policy } from "@dembrane/access";
import { allowanceForProject, invalidateFreeLimits, usedThisPeriod } from "@dembrane/allowance";
import { newId } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import { type CompletionRequest, FakeCompleter } from "@dembrane/llm";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import type postgres from "postgres";
import { finishReads } from "../src/finish";
import { popcornAllowance } from "../src/free";
import type { Json } from "../src/py";
import { popcornRoutes } from "../src/routes";
import { finishReadState, goLive, type PopcornDeps, popcornDeps } from "../src/service";
import { client, popcornStore } from "../src/storage";
import { enqueueNextIfDue, runPopcornTick, type TickDeps } from "../src/tick/run";
import { tickDeps } from "../src/worker";
import { NO_ANALYSIS } from "./fixtures/tick/analysis";
import { freshDatabase } from "./fixtures/tick/seed";

// The tick, the live cadence and the host routes on a free account's 12 analyses.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;

run("free popcorn in the tick", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
  let failExtraction = false;

  // No phrases, so no second pass is owed; every other call answered empty.
  const fake = () =>
    new FakeCompleter().on(
      () => true,
      (r: CompletionRequest) => {
        const required = ((r.jsonSchema as { required?: string[] })?.required ?? []).join(",");
        return JSON.stringify(required === "items" ? { items: [] } : {});
      },
    );

  // crash: the process dies after admitting, so nothing after it is written or given back.
  const deps = (
    completer: FakeCompleter,
    o: { workflowId?: string; failErrorRow?: boolean; crash?: boolean } = {},
  ): TickDeps => {
    const base = tickDeps(
      {
        db: database.db,
        logger: quiet,
        completer,
        flags: { present: true, canvas: true },
        participantBaseUrl: "http://localhost:5174",
        adminBaseUrl: "http://localhost:5173",
        databaseUrl: "unused",
        analysis: () => NO_ANALYSIS,
      },
      o.workflowId ?? newId(),
      NO_ANALYSIS,
    );
    const failDeck = failExtraction || o.crash;
    const failRow = o.failErrorRow || o.crash;
    // A deck write that fails after the read was admitted fails the whole tick.
    const store = {
      ...base.store,
      updateLoop: (id: string, patch: Json, now: string) => {
        if (failDeck && patch.popcorn_state) throw new Error("deck write failed");
        return base.store.updateLoop(id, patch, now);
      },
    } as TickDeps["store"];
    const ticks = {
      ...base.ticks,
      insertRun: (v: Parameters<TickDeps["ticks"]["insertRun"]>[0]) => {
        if (failRow && v.status === "error") throw new Error("run write failed");
        return base.ticks.insertRun(v);
      },
      replaceRun: (v: Parameters<TickDeps["ticks"]["replaceRun"]>[0]) => {
        if (failRow && v.status === "error") throw new Error("run write failed");
        return base.ticks.replaceRun(v);
      },
    } as TickDeps["ticks"];
    const allowance = popcornAllowance(database.db);
    const free = o.crash
      ? {
          ...allowance,
          refund: async () => {
            throw new Error("worker gone");
          },
        }
      : allowance;
    return { ...base, store, ticks, free, heartbeatMs: 1000 };
  };

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, `popcorn_free_tick_${process.pid}`);
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 8 });
    sql = connect(url, { max: 2, onnotice: () => {} });
  });
  beforeEach(() => {
    invalidateFreeLimits();
    failExtraction = false;
  });
  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists popcorn_free_tick_${process.pid} with (force)`);
    await a.end();
  });

  let chunkN = 0;
  async function say(conversationId: string, text: string) {
    const at = new Date(Date.now() - 60_000 + chunkN++).toISOString();
    await sql`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
      values (${newId()}, ${conversationId}, ${text}, ${at}, ${at})`;
  }

  async function seed(tier: string, opts: { status?: string; blocks?: string[] } = {}) {
    const [org, billing, ws, user, appUser, projectId, loopId, conv] = [
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
    ];
    const reportId = Math.floor(Math.random() * 1_000_000_000);
    await sql`insert into directus_users (id, email) values (${user}, ${`${user}@example.com`})`;
    await sql`insert into app_user (id, directus_user_id) values (${appUser}, ${user})`;
    await sql`insert into org (id, name) values (${org}, 'Org')`;
    await sql`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, ${tier})`;
    await sql`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await sql`insert into workspace_membership (id, workspace_id, user_id, role)
      values (${newId()}, ${ws}, ${appUser}, 'owner')`;
    await sql`insert into project (id, name, language, workspace_id, is_conversation_allowed,
      is_canvas_enabled, anonymize_transcripts, visibility)
      values (${projectId}, 'P', 'en', ${ws}, true, true, false, 'workspace')`;
    await sql`insert into project_report (id, project_id, kind, status, user_instructions, content, public_token, date_created)
      values (${reportId}, ${projectId}, 'popcorn', 'published', '', '', ${newId()}, now())`;
    await sql`insert into canvas_config_revision (id, report_id, popcorn_settings, created_at, cadence_minutes)
      values (${newId()}, ${reportId}, ${sql.json({ title: "P", presentation: { blocks: opts.blocks ?? ["popcorn"] } })}, now(), 2)`;
    const live = opts.status === "active";
    await sql`insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes,
      acting_directus_user_id, failure_count, caps, popcorn_state, created_at)
      values (${loopId}, ${projectId}, ${reportId}, 'P', ${opts.status ?? "paused"},
        ${live ? new Date(Date.now() + 3_600_000).toISOString() : "2026-09-01T09:00:00Z"}, 2,
        ${user}, 0, ${sql.json({ kind: "popcorn" })}, ${sql.json({})}, now())`;
    await sql`insert into conversation (id, project_id, participant_name, created_at, duration)
      values (${conv}, ${projectId}, 'Table 1', now() - interval '1 hour', 600)`;
    await say(conv, "Table 1 says the ferry should run all night.");
    return { projectId, loopId, conv, reportId, user };
  }

  async function ledger(projectId: string) {
    const a = await allowanceForProject(database.db, projectId, new Date());
    if (!a) return null;
    return (await usedThisPeriod(database.db, a)).popcorn_analyses;
  }

  async function useAll(projectId: string) {
    const pop = popcornAllowance(database.db);
    for (let i = 0; i < 12; i++) await pop.admit(projectId, new Date());
  }

  const stampOf = async (runId: unknown) =>
    (await sql`select free_period_start from agent_loop_run where id = ${String(runId)}`)[0]
      ?.free_period_start ?? null;

  const period = () => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).getTime();
  };

  test("an analysis counts one and stamps its run", async () => {
    const s = await seed("free");
    const got = await runPopcornTick(deps(fake()), s.loopId, "manual", newId());
    expect(got.status).toBe("ok");
    expect(await ledger(s.projectId)).toBe(1);
    expect((await stampOf(got.run.id))?.getTime()).toBe(period());
  });

  test("translation and nothing-to-do ticks are free", async () => {
    const s = await seed("free");
    expect((await runPopcornTick(deps(fake()), s.loopId, "manual", newId())).status).toBe("ok");
    const again = await runPopcornTick(deps(fake()), s.loopId, "manual", newId());
    expect(again.status).toBe("no_op");
    const translation = await runPopcornTick(deps(fake()), s.loopId, "translation", newId());
    expect(await ledger(s.projectId)).toBe(1);
    expect(await stampOf(again.run.id)).toBeNull();
    expect(await stampOf(translation.run.id)).toBeNull();
  });

  test("outcomes count as analyses", async () => {
    const s = await seed("free");
    await runPopcornTick(deps(fake()), s.loopId, "manual", newId());
    const before = await ledger(s.projectId);
    const t = await runPopcornTick(deps(fake()), s.loopId, "prepare:tensions", newId());
    const k = await runPopcornTick(deps(fake()), s.loopId, "prepare:stakeholders", newId());
    expect([t.status, k.status]).toEqual(["ok", "ok"]);
    expect(await ledger(s.projectId)).toBe((before ?? 0) + 2);
  });

  test("when the 12 are used analysis pauses", async () => {
    const s = await seed("free", { status: "active" });
    expect((await runPopcornTick(deps(fake()), s.loopId, "manual", newId())).status).toBe("ok");
    await useAll(s.projectId);
    await say(s.conv, "Table 1 says the bridge needs a cycle lane.");
    const [before] = await sql`select popcorn_state from agent_loop where id = ${s.loopId}`;
    const completer = fake();
    const got = await runPopcornTick(deps(completer), s.loopId, "scheduled");
    expect(got.status).toBe("no_op");
    expect(got.run.detail).toBe("Free analyses used up");
    expect(completer.calls.length).toBe(0);
    const [loop] = await sql`select status, popcorn_state from agent_loop where id = ${s.loopId}`;
    expect(loop?.status).toBe("paused");
    expect(loop?.popcorn_state).toEqual(before?.popcorn_state);
    const pending = await sql`select id from scheduled_task where task_type = 'popcorn_tick'
      and status = 'scheduled' and payload->>'loop_id' = ${s.loopId}`;
    expect(pending.length).toBe(0);
    expect(await ledger(s.projectId)).toBe(12);
  });

  test("a failing analysis gives its count back", async () => {
    const s = await seed("free");
    failExtraction = true;
    const got = await runPopcornTick(deps(fake()), s.loopId, "manual", newId());
    expect(got.status).toBe("error");
    expect(await ledger(s.projectId)).toBe(0);
    expect(await stampOf(got.run.id)).toBeNull();
  });

  // Extraction of any transcript saying "BROKEN" fails; everything else answers empty.
  const breaking = () =>
    new FakeCompleter().on(
      () => true,
      (r: CompletionRequest) => {
        const required = ((r.jsonSchema as { required?: string[] })?.required ?? []).join(",");
        const user = typeof r.user === "string" ? r.user : r.user.join("\n");
        if (required === "items" && user.includes("BROKEN")) throw new Error("model down");
        return JSON.stringify(required === "items" ? { items: [] } : {});
      },
    );

  async function addConversation(projectId: string, text: string) {
    const conv = newId();
    await sql`insert into conversation (id, project_id, participant_name, created_at, duration)
      values (${conv}, ${projectId}, 'Table 2', now() - interval '1 hour', 600)`;
    await say(conv, text);
    return conv;
  }

  test("an analysis that read nothing gives its count back", async () => {
    const s = await seed("free");
    await say(s.conv, "BROKEN");
    const got = await runPopcornTick(deps(breaking()), s.loopId, "manual", newId());
    expect(got.status).toBe("ok");
    expect(String(got.run.detail)).toContain("FAILED");
    expect(await ledger(s.projectId)).toBe(0);
    expect(await stampOf(got.run.id)).toBeNull();
  });

  test("a finish read whose only conversation failed gives its count back", async () => {
    const s = await seed("free", { status: "active" });
    await runPopcornTick(deps(fake()), s.loopId, "manual", newId());
    expect(await ledger(s.projectId)).toBe(1);
    const conv = await addConversation(s.projectId, "BROKEN");
    const got = await runPopcornTick(deps(breaking()), s.loopId, "finish", newId(), [conv]);
    expect(got.status).toBe("ok");
    expect(await ledger(s.projectId)).toBe(1);
    expect(await stampOf(got.run.id)).toBeNull();
  });

  test("an analysis that read one of two conversations still counts", async () => {
    const s = await seed("free");
    await addConversation(s.projectId, "BROKEN");
    const got = await runPopcornTick(deps(breaking()), s.loopId, "manual", newId());
    expect(got.status).toBe("ok");
    expect(String(got.run.detail)).toContain("FAILED");
    expect(await ledger(s.projectId)).toBe(1);
    expect((await stampOf(got.run.id))?.getTime()).toBe(period());
  });

  test("paid analyses that read nothing are unchanged", async () => {
    const s = await seed("guardian");
    await say(s.conv, "BROKEN");
    const got = await runPopcornTick(deps(breaking()), s.loopId, "manual", newId());
    expect(got.status).toBe("ok");
    expect(String(got.run.detail)).toContain("FAILED");
    expect(await ledger(s.projectId)).toBeNull();
    expect(await stampOf(got.run.id)).toBeNull();
  });

  test("a crash after admitting is counted once when the step runs again", async () => {
    const s = await seed("free", { status: "active" });
    await say(s.conv, "Table 1 says the square needs trees.");
    const workflowId = `popcorn-tick-task:${newId()}`;
    const crashed = await Promise.resolve(
      runPopcornTick(deps(fake(), { workflowId, crash: true }), s.loopId, "scheduled"),
    ).then(
      () => null,
      (e) => e,
    );
    expect(crashed).toBeInstanceOf(Error);
    expect(await ledger(s.projectId)).toBe(1);
    // The row the crash left is in progress, never shown as the latest run.
    const store = popcornStore(sql);
    expect((await store.latestRun(s.loopId))?.status).not.toBe("running");
    const again = await runPopcornTick(deps(fake(), { workflowId }), s.loopId, "scheduled");
    expect(again.status).toBe("ok");
    expect(await ledger(s.projectId)).toBe(1);
    expect((await stampOf(again.run.id))?.getTime()).toBe(period());
    const rows = await sql`select status from agent_loop_run where id = ${String(again.run.id)}`;
    expect(rows.map((r) => r.status)).toEqual(["ok"]);
  });

  test("a crash then a paused loop gives the count back and closes the row", async () => {
    const s = await seed("free", { status: "active" });
    await say(s.conv, "Table 1 says the market should stay.");
    const workflowId = `popcorn-tick-task:${newId()}`;
    const crashed = await Promise.resolve(
      runPopcornTick(deps(fake(), { workflowId, crash: true }), s.loopId, "scheduled"),
    ).then(
      () => null,
      (e) => e,
    );
    expect(crashed).toBeInstanceOf(Error);
    expect(await ledger(s.projectId)).toBe(1);
    await sql`update agent_loop set status = 'paused' where id = ${s.loopId}`;
    const again = await runPopcornTick(deps(fake(), { workflowId }), s.loopId, "scheduled");
    expect(again.run.detail).toBe("Loop is paused");
    expect(await ledger(s.projectId)).toBe(0);
    const running = await sql`select id from agent_loop_run
      where loop_id = ${s.loopId} and status = 'running'`;
    expect(running.length).toBe(0);
  });

  test("a failure whose error row cannot be written still gives the count back", async () => {
    const s = await seed("free");
    failExtraction = true;
    const err = await Promise.resolve(
      runPopcornTick(deps(fake(), { failErrorRow: true }), s.loopId, "manual", newId()),
    ).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(await ledger(s.projectId)).toBe(0);
  });

  test("used up: pending reads are cancelled and the loop paused in one transaction", async () => {
    const s = await seed("free", { status: "active" });
    await sql`create table if not exists tx_log (tbl text, txid bigint)`;
    await sql.unsafe(`create or replace function log_tx() returns trigger language plpgsql as $$
      begin insert into tx_log values (tg_table_name, txid_current()); return new; end $$`);
    await sql.unsafe(`create trigger log_cancel after update on scheduled_task for each row
      when (new.status = 'cancelled' and new.payload->>'loop_id' = '${s.loopId}') execute function log_tx()`);
    await sql.unsafe(`create trigger log_pause after update on agent_loop for each row
      when (new.status = 'paused' and new.id = '${s.loopId}') execute function log_tx()`);
    try {
      await useAll(s.projectId);
      const got = await runPopcornTick(deps(fake()), s.loopId, "scheduled");
      expect(got.run.detail).toBe("Free analyses used up");
      const pause = await sql`select txid from tx_log where tbl = 'agent_loop'`;
      const cancel = await sql`select txid from tx_log where tbl = 'scheduled_task'`;
      expect(pause.length).toBe(1);
      expect(cancel.map((r) => r.txid)).toContain(pause[0]?.txid);
    } finally {
      await sql.unsafe("drop trigger if exists log_cancel on scheduled_task");
      await sql.unsafe("drop trigger if exists log_pause on agent_loop");
    }
  });

  test("used up keeps a live session booked for later", async () => {
    const s = await seed("free");
    const now = new Date();
    const [loop] = await sql`select * from agent_loop where id = ${s.loopId}`;
    const readyBy = new Date(now.getTime() + 3 * 86_400_000);
    await goLive(
      { db: database.db, now: () => now, dispatchTick: async () => {} } as unknown as PopcornDeps,
      loop as Json,
      1,
      readyBy,
    );
    const [booked] = await sql`select caps, expires_at from agent_loop where id = ${s.loopId}`;
    await useAll(s.projectId);
    await say(s.conv, "Table 1 says the library should open late.");
    const got = await runPopcornTick(deps(fake()), s.loopId, "manual", newId());
    expect(got.run.detail).toBe("Free analyses used up");
    const [after] =
      await sql`select status, caps, expires_at from agent_loop where id = ${s.loopId}`;
    expect(after?.status).toBe("paused");
    expect(after?.caps).toEqual(booked?.caps);
    expect(after?.expires_at).toEqual(booked?.expires_at);
    const starts = await sql`select id from scheduled_task where task_type = 'popcorn_tick'
      and status = 'scheduled' and payload->>'loop_id' = ${s.loopId} and payload->>'tick_kind' = 'start'`;
    expect(starts.length).toBe(1);
  });

  test("live is booked at the free cadence", async () => {
    for (const [tier, minutes] of [
      ["free", 5],
      ["changemaker", 2],
    ] as const) {
      const s = await seed(tier, { status: "active" });
      const d = deps(fake());
      const [loop] = await sql`select * from agent_loop where id = ${s.loopId}`;
      const before = Date.now();
      await enqueueNextIfDue(d, loop as Json);
      const [task] =
        await sql`select scheduled_at from scheduled_task where task_type = 'popcorn_tick'
        and status = 'scheduled' and payload->>'loop_id' = ${s.loopId}`;
      const ahead = (new Date(task?.scheduled_at as string).getTime() - before) / 60_000;
      expect(Math.round(ahead)).toBe(minutes);
    }
  });

  const routes = () => {
    const access = {
      project: async (_who: unknown, _projectId: string, _policy: Policy) => ({
        tier: "free",
        role: "owner",
        source: "workspace",
        extra: [],
        project: {},
      }),
    } as unknown as Access;
    const d = popcornDeps({
      db: database.db,
      deck: NO_ANALYSIS.deck,
      flags: { present: true, canvas: true },
      participantBaseUrl: "http://portal.test",
      adminBaseUrl: "http://dashboard.test",
      showFlow: false,
      dispatchTick: async () => {},
      limiter: new RateLimiter(new MemoryRateCounter()),
      logger: quiet,
    });
    const a = new Hono();
    a.use(async (c, next) => {
      c.set("principal" as never, { appUserId: newId(), directusUserId: newId() } as never);
      await next();
    });
    a.onError((err, c) =>
      c.json(
        { code: (err as { code?: string }).code, details: (err as { details?: unknown }).details },
        ((err as { status?: number }).status ?? 500) as 402,
      ),
    );
    a.route(
      "/",
      popcornRoutes({
        ...d,
        access,
        hub: async () => ({}) as never,
        capture: (() => {}) as never,
      }),
    );
    return a;
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await routes().request(`/api/v2/bff/popcorn/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };

  test("Analyse now, rerun and live are refused when used up", async () => {
    const s = await seed("free");
    await useAll(s.projectId);
    for (const [path, body] of [
      ["refresh", undefined],
      ["rerun", undefined],
      ["live", { hours: 1 }],
    ] as const) {
      const res = await call("POST", `${s.reportId}/${path}`, body);
      expect(res.status).toBe(402);
      expect((res.body.details as Json).limit).toBe("popcorn");
    }
    const got = await call("GET", String(s.reportId));
    expect(got.body.free_popcorn).toEqual({ used: 12, limit: 12, exhausted: true });
  });

  const book = (projectId: string, conv: string) =>
    client(database.db).begin((tx) =>
      finishReads({
        flags: { present: true, canvas: true },
        logger: quiet,
        free: popcornAllowance(database.db),
      })(tx, projectId, conv),
    );
  const finishTasks = async (loopId: string) =>
    Number(
      (
        await sql`select count(*)::int as n from scheduled_task where task_type = 'popcorn_tick'
        and payload->>'loop_id' = ${loopId} and payload->>'tick_kind' = 'finish'`
      )[0]?.n,
    );

  test("a finished conversation outside live books no read on free, so the deck shows nothing new", async () => {
    const s = await seed("free");
    await runPopcornTick(deps(fake()), s.loopId, "manual", newId());
    const store = popcornStore(sql);
    const view = async () => {
      const run = await store.latestRun(s.loopId);
      return { run, finish: await finishReadState(store, s.loopId, run, new Date()) };
    };
    const before = await view();
    await book(s.projectId, s.conv);
    expect(await finishTasks(s.loopId)).toBe(0);
    expect(await view()).toEqual(before);
    expect(await ledger(s.projectId)).toBe(1);
  });

  test("a finished conversation books a read on free while live or booked, and on paid", async () => {
    const live = await seed("free", { status: "active" });
    await book(live.projectId, live.conv);
    expect(await finishTasks(live.loopId)).toBe(1);
    const booked = await seed("free");
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await sql`update agent_loop set caps = ${sql.json({ kind: "popcorn", ready_by: later, starts_at: later })}
      where id = ${booked.loopId}`;
    await book(booked.projectId, booked.conv);
    expect(await finishTasks(booked.loopId)).toBe(1);
    const paid = await seed("guardian");
    await book(paid.projectId, paid.conv);
    expect(await finishTasks(paid.loopId)).toBe(1);
  });

  test("a finish read while live or booked runs and counts on free", async () => {
    const live = await seed("free", { status: "active" });
    const a = await runPopcornTick(deps(fake()), live.loopId, "finish", newId(), [live.conv]);
    expect(a.status).toBe("ok");
    expect(await ledger(live.projectId)).toBe(1);
    const booked = await seed("free");
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await sql`update agent_loop set caps = ${sql.json({ kind: "popcorn", ready_by: later, starts_at: later })}
      where id = ${booked.loopId}`;
    const b = await runPopcornTick(deps(fake()), booked.loopId, "finish", newId(), [booked.conv]);
    expect(b.status).toBe("ok");
    expect(await ledger(booked.projectId)).toBe(1);
  });

  test("paid finish reads outside live still run", async () => {
    const s = await seed("guardian");
    const got = await runPopcornTick(deps(fake()), s.loopId, "finish", newId(), [s.conv]);
    expect(got.status).toBe("ok");
  });

  test("paid sessions are untouched", async () => {
    const s = await seed("guardian");
    for (let i = 0; i < 15; i++) {
      await say(s.conv, `Table 1 says point number ${i} matters.`);
      const got = await runPopcornTick(deps(fake()), s.loopId, "manual", newId());
      expect(got.status).toBe("ok");
    }
    expect(await ledger(s.projectId)).toBeNull();
    const own = await sql`select count(*)::int as n from free_usage u
      join workspace w on w.billing_account_id = u.billing_account_id
      join project p on p.workspace_id = w.id where p.id = ${s.projectId}`;
    expect(own[0]?.n).toBe(0);
    expect((await call("GET", String(s.reportId))).body.free_popcorn).toBeNull();
  });
});
