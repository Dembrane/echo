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
import { AI_SPEND_KEY, allowanceForProject, invalidateFreeLimits } from "@dembrane/allowance";
import { newId } from "@dembrane/core";
import { connect, createDb, migrate } from "@dembrane/db";
import { type CompletionRequest, FakeCompleter } from "@dembrane/llm";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import type postgres from "postgres";
import { finishReads } from "../src/finish";
import { popcornAllowance, withAiBudget } from "../src/free";
import type { Json } from "../src/py";
import { popcornRoutes } from "../src/routes";
import { finishReadState, goLive, type PopcornDeps, popcornDeps } from "../src/service";
import { client, popcornStore } from "../src/storage";
import { enqueueNextIfDue, STUCK_RUN_MS, settleStuckRuns, type TickDeps } from "../src/tick/run";
import { tickDeps } from "../src/worker";
import { NO_ANALYSIS } from "./fixtures/tick/analysis";
import { runPopcornTick } from "./fixtures/tick/scoped";
import { freshDatabase } from "./fixtures/tick/seed";

// Popcorn on a free account's AI budget: refused or paused at zero, never counted.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const DB = `popcorn_ai_budget_${process.pid}`;
const LIMIT = 5_000_000;

run("popcorn on the AI budget", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let sql: postgres.Sql;
  const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

  // No phrases, so no second pass is owed; every other call answered empty.
  const fake = () =>
    new FakeCompleter().on(
      () => true,
      (r: CompletionRequest) => {
        const required = ((r.jsonSchema as { required?: string[] })?.required ?? []).join(",");
        return JSON.stringify(required === "items" ? { items: [] } : {});
      },
    );

  const deps = (completer: FakeCompleter): TickDeps => ({
    ...tickDeps(
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
      newId(),
      NO_ANALYSIS,
    ),
    heartbeatMs: 1000,
  });

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, DB);
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 8 });
    sql = connect(url, { max: 2, onnotice: () => {} });
  });
  beforeEach(() => invalidateFreeLimits());
  afterAll(async () => {
    invalidateFreeLimits();
    await sql?.end();
    await database?.close();
    const a = connect(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database if exists ${DB} with (force)`);
    await a.end();
  });

  let chunkN = 0;
  async function say(conversationId: string, text: string) {
    const at = new Date(Date.now() - 60_000 + chunkN++).toISOString();
    await sql`insert into conversation_chunk (id, conversation_id, transcript, timestamp, created_at)
      values (${newId()}, ${conversationId}, ${text}, ${at}, ${at})`;
  }

  async function seed(
    tier: string,
    opts: { status?: string; blocks?: string[]; translateTo?: string; sample?: boolean } = {},
  ) {
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
      is_canvas_enabled, anonymize_transcripts, visibility, is_sample)
      values (${projectId}, 'P', 'en', ${ws}, true, true, false, 'workspace', ${opts.sample === true})`;
    await sql`insert into project_report (id, project_id, kind, status, user_instructions, content, public_token, date_created)
      values (${reportId}, ${projectId}, 'popcorn', 'published', '', '', ${newId()}, now())`;
    const settings: Json = {
      title: "P",
      presentation: { blocks: opts.blocks ?? ["popcorn"] },
      ...(opts.translateTo && { language: { translate_to: opts.translateTo } }),
    };
    await sql`insert into canvas_config_revision (id, report_id, popcorn_settings, created_at, cadence_minutes)
      values (${newId()}, ${reportId}, ${sql.json(settings as never)}, now(), 2)`;
    const live = opts.status === "active";
    await sql`insert into agent_loop (id, project_id, report_id, name, status, expires_at, cadence_minutes,
      acting_directus_user_id, failure_count, caps, popcorn_state, created_at)
      values (${loopId}, ${projectId}, ${reportId}, 'P', ${opts.status ?? "paused"},
        ${live ? new Date(Date.now() + 3_600_000).toISOString() : "2026-09-01T09:00:00Z"}, 2,
        ${user}, 0, ${sql.json({ kind: "popcorn" })}, ${sql.json({})}, now())`;
    await sql`insert into conversation (id, project_id, participant_name, created_at, duration)
      values (${conv}, ${projectId}, 'Table 1', now() - interval '1 hour', 600)`;
    await say(conv, "Table 1 says the ferry should run all night.");
    return { billing, projectId, loopId, conv, reportId, user };
  }

  async function spend(billing: string, projectId: string, amount: number) {
    const a = await allowanceForProject(database.db, projectId, new Date());
    const period = (a?.periodStart ?? new Date()).toISOString();
    await sql`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${billing}, ${period}, ${AI_SPEND_KEY}, ${amount})
      on conflict (billing_account_id, period_start, key) do update set amount = excluded.amount`;
  }
  const useAll = (s: { billing: string; projectId: string }) =>
    spend(s.billing, s.projectId, LIMIT);

  const usageKeys = async (billing: string) =>
    (await sql`select key from free_usage where billing_account_id = ${billing} order by key`).map(
      (r) => String(r.key),
    );

  const pendingTicks = async (loopId: string) =>
    sql`select id from scheduled_task where task_type = 'popcorn_tick'
      and status = 'scheduled' and payload->>'loop_id' = ${loopId}`;

  test("the allowance reads the AI budget", async () => {
    const s = await seed("free");
    const pop = popcornAllowance(database.db);
    const now = new Date();
    await spend(s.billing, s.projectId, LIMIT - 1);
    expect(await pop.admit(s.projectId, now)).toBe(true);
    expect(await pop.status(s.projectId, now)).toEqual({ exhausted: false });
    await pop.requireRoom(s.projectId, now);
    await useAll(s);
    expect(await pop.admit(s.projectId, now)).toBe(false);
    expect(await pop.status(s.projectId, now)).toEqual({ exhausted: true });
    const err = await pop.requireRoom(s.projectId, now).then(
      () => null,
      (e) => e,
    );
    expect(err).toMatchObject({ status: 402, details: { limit: "ai_budget" } });
    expect(await withAiBudget(database.db, { a: 1 }, s.projectId, now)).toEqual({
      a: 1,
      ai_budget: { exhausted: true },
    });
  });

  test("paid and sample projects past the budget are never refused", async () => {
    const pop = popcornAllowance(database.db);
    const now = new Date();
    for (const s of [await seed("guardian"), await seed("free", { sample: true })]) {
      await useAll(s);
      expect(await pop.admit(s.projectId, now)).toBe(true);
      expect(await pop.status(s.projectId, now)).toBeNull();
      await pop.requireRoom(s.projectId, now);
      expect(await withAiBudget(database.db, {}, s.projectId, now)).toEqual({ ai_budget: null });
    }
  });

  test("at zero a scheduled live tick goes back to manual with no model call", async () => {
    const s = await seed("free", { status: "active" });
    expect((await runPopcornTick(deps(fake()), s.loopId, "manual", newId())).status).toBe("ok");
    await useAll(s);
    await say(s.conv, "Table 1 says the bridge needs a cycle lane.");
    const [before] = await sql`select popcorn_state from agent_loop where id = ${s.loopId}`;
    const completer = fake();
    const got = await runPopcornTick(deps(completer), s.loopId, "scheduled");
    expect(got.status).toBe("no_op");
    expect(got.run.detail).toBe("AI budget used up");
    expect(completer.calls.length).toBe(0);
    const [loop] = await sql`select status, popcorn_state from agent_loop where id = ${s.loopId}`;
    expect(loop?.status).toBe("paused");
    expect(loop?.popcorn_state).toEqual(before?.popcorn_state);
    expect((await pendingTicks(s.loopId)).length).toBe(0);
    const [row] =
      await sql`select free_period_start from agent_loop_run where id = ${String(got.run.id)}`;
    expect(row?.free_period_start).toBeNull();

    // A new month does not turn it back on: the host goes live again.
    await spend(s.billing, s.projectId, 0);
    const later = await runPopcornTick(deps(fake()), s.loopId, "scheduled");
    expect(later.run.detail).toBe("Loop is paused");
    const [after] = await sql`select status from agent_loop where id = ${s.loopId}`;
    expect(after?.status).toBe("paused");
  });

  test("at zero a re-run, a prepare and a finish read make no model call", async () => {
    const s = await seed("free", { status: "active", blocks: ["popcorn", "stakeholders"] });
    await useAll(s);
    for (const [kind, finished] of [
      ["rerun", null],
      ["prepare:stakeholders", null],
      ["finish", [s.conv]],
    ] as const) {
      await sql`update agent_loop set status = 'active', expires_at = now() + interval '1 hour'
        where id = ${s.loopId}`;
      const completer = fake();
      const got = await runPopcornTick(deps(completer), s.loopId, kind, newId(), finished);
      expect({ kind, detail: got.run.detail, calls: completer.calls.length }).toEqual({
        kind,
        detail: "AI budget used up",
        calls: 0,
      });
    }
  });

  // A live session with one phrase on the deck to translate.
  const translated = async () => {
    const s = await seed("free", { status: "active", translateTo: "nl" });
    await say(s.conv, "Table 1 says the bridge needs a cycle lane.");
    broken.on = false;
    expect(
      (await runPopcornTick(deps(failingWithSlide()), s.loopId, "manual", newId())).status,
    ).toBe("ok");
    return s;
  };
  const forgetTranslations = (loopId: string) =>
    sql`update agent_loop set popcorn_state = popcorn_state::jsonb - 'translations'
      where id = ${loopId}`;

  test("at zero a translation tick makes no model call", async () => {
    const s = await translated();
    // Below the limit the same tick reaches the model.
    await forgetTranslations(s.loopId);
    const below = fake();
    await runPopcornTick(deps(below), s.loopId, "translation", newId());
    expect(below.calls.length).toBeGreaterThan(0);
    await forgetTranslations(s.loopId);
    await useAll(s);
    const completer = fake();
    const got = await runPopcornTick(deps(completer), s.loopId, "translation", newId());
    expect(got.status).toBe("no_op");
    expect(got.run.detail).toBe("AI budget used up");
    expect(completer.calls.length).toBe(0);
    const [loop] = await sql`select status from agent_loop where id = ${s.loopId}`;
    expect(loop?.status).toBe("paused");
  });

  test("at zero a live tick with nothing new translates nothing", async () => {
    const s = await translated();
    // Below the limit the same tick reaches the model.
    await forgetTranslations(s.loopId);
    const below = fake();
    await runPopcornTick(deps(below), s.loopId, "scheduled");
    expect(below.calls.length).toBeGreaterThan(0);
    await forgetTranslations(s.loopId);
    await useAll(s);
    const completer = fake();
    const got = await runPopcornTick(deps(completer), s.loopId, "scheduled");
    expect(got.status).toBe("no_op");
    expect(completer.calls.length).toBe(0);
  });

  test("an idle live tick with no translation target reads no budget", async () => {
    const s = await seed("free", { status: "active" });
    expect((await runPopcornTick(deps(fake()), s.loopId, "manual", newId())).status).toBe("ok");
    let reads = 0;
    const counting = (c: FakeCompleter): TickDeps => {
      const base = deps(c);
      const free = base.free as NonNullable<TickDeps["free"]>;
      return {
        ...base,
        free: {
          ...free,
          admit: (projectId, at) => {
            reads++;
            return free.admit(projectId, at);
          },
        },
      };
    };
    const completer = fake();
    const got = await runPopcornTick(counting(completer), s.loopId, "scheduled");
    expect({ status: got.status, reads, calls: completer.calls.length }).toEqual({
      status: "no_op",
      reads: 0,
      calls: 0,
    });
  });

  test("at zero a map-only read translates nothing", async () => {
    const s = await seed("free", {
      status: "active",
      translateTo: "nl",
      blocks: ["popcorn", "map"],
    });
    await say(s.conv, "Table 1 says the bridge needs a cycle lane.");
    broken.on = false;
    const maps: string[] = [];
    const withMap = (c: FakeCompleter): TickDeps => ({
      ...deps(c),
      requestMap: async (projectId) => {
        maps.push(projectId);
        return true;
      },
    });
    expect(
      (await runPopcornTick(withMap(failingWithSlide()), s.loopId, "manual", newId())).status,
    ).toBe("ok");
    // Only the map is behind; translations are owed again.
    const behind = () =>
      sql`update agent_loop set popcorn_state = jsonb_set(popcorn_state::jsonb - 'translations',
        '{map_fingerprint}', '"older"')::json where id = ${s.loopId}`;
    await behind();
    const below = fake();
    await runPopcornTick(withMap(below), s.loopId, "scheduled");
    expect(below.calls.length).toBeGreaterThan(0);
    await behind();
    await useAll(s);
    const completer = fake();
    const got = await runPopcornTick(withMap(completer), s.loopId, "scheduled");
    expect(got.status).toBe("ok");
    expect(maps.length).toBe(3);
    expect(completer.calls.length).toBe(0);
  });

  test("a map refused for the AI budget stays owed and is asked for after the reset", async () => {
    const s = await seed("free", { status: "active", blocks: ["popcorn", "map"] });
    await say(s.conv, "Table 1 says the bridge needs a cycle lane.");
    broken.on = false;
    const maps: string[] = [];
    let refused = false;
    const withMap = (c: FakeCompleter): TickDeps => ({
      ...deps(c),
      requestMap: async (projectId) => {
        maps.push(projectId);
        return !refused;
      },
    });
    const fingerprint = async () =>
      (
        await sql`select popcorn_state->>'map_fingerprint' as f from agent_loop where id = ${s.loopId}`
      )[0]?.f;
    await runPopcornTick(withMap(failingWithSlide()), s.loopId, "manual", newId());
    const current = await fingerprint();
    expect(current).toBeTruthy();
    await sql`update agent_loop set popcorn_state = jsonb_set(popcorn_state::jsonb,
      '{map_fingerprint}', '"older"')::json where id = ${s.loopId}`;
    await useAll(s);
    refused = true;
    await runPopcornTick(withMap(fake()), s.loopId, "scheduled");
    expect(maps.length).toBe(2);
    expect(await fingerprint()).toBe("older");
    // The month resets: the next read asks again without any new transcript.
    await spend(s.billing, s.projectId, 0);
    refused = false;
    await runPopcornTick(withMap(fake()), s.loopId, "scheduled");
    expect(maps.length).toBe(3);
    expect(await fingerprint()).toBe(current);
  });

  test("below the limit a 13th analysis runs and nothing is counted", async () => {
    const s = await seed("free");
    await spend(s.billing, s.projectId, LIMIT - 1);
    for (let i = 0; i < 13; i++) {
      await say(s.conv, `Table 1 says point number ${i} matters.`);
      const got = await runPopcornTick(deps(fake()), s.loopId, "manual", newId());
      expect({ i, status: got.status }).toEqual({ i, status: "ok" });
    }
    const stamped = await sql`select id from agent_loop_run
      where loop_id = ${s.loopId} and (free_period_start is not null or status = 'running')`;
    expect(stamped.length).toBe(0);
    expect(await usageKeys(s.billing)).toEqual([AI_SPEND_KEY]);
  });

  test("paid sessions past the budget are untouched", async () => {
    const s = await seed("guardian", { status: "active" });
    await useAll(s);
    await say(s.conv, "Table 1 says the harbour needs a ferry.");
    const got = await runPopcornTick(deps(fake()), s.loopId, "scheduled");
    expect(got.status).toBe("ok");
    const [loop] = await sql`select status from agent_loop where id = ${s.loopId}`;
    expect(loop?.status).toBe("active");
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
      await useAll(s);
      const got = await runPopcornTick(deps(fake()), s.loopId, "scheduled");
      expect(got.run.detail).toBe("AI budget used up");
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
    await useAll(s);
    await say(s.conv, "Table 1 says the library should open late.");
    const got = await runPopcornTick(deps(fake()), s.loopId, "manual", newId());
    expect(got.run.detail).toBe("AI budget used up");
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
      const [loop] = await sql`select * from agent_loop where id = ${s.loopId}`;
      const before = Date.now();
      await enqueueNextIfDue(deps(fake()), loop as Json);
      const [task] =
        await sql`select scheduled_at from scheduled_task where task_type = 'popcorn_tick'
        and status = 'scheduled' and payload->>'loop_id' = ${s.loopId}`;
      const ahead = (new Date(task?.scheduled_at as string).getTime() - before) / 60_000;
      expect(Math.round(ahead)).toBe(minutes);
    }
  });

  // Extraction of "BROKEN" fails while `broken.on`; the stakeholders view always answers.
  const broken = { on: true, reads: 0 };
  const failingWithSlide = () =>
    new FakeCompleter().on(
      () => true,
      (r: CompletionRequest) => {
        const required = ((r.jsonSchema as { required?: string[] })?.required ?? []).join(",");
        const user = typeof r.user === "string" ? r.user : r.user.join("\n");
        if (required === "items" && user.includes("BROKEN")) {
          broken.reads++;
          if (broken.on) throw new Error("model refused");
        }
        if (required === "stakeholders,relations")
          return JSON.stringify({
            stakeholders: [
              {
                name: "Ferry riders",
                role: "People who ride the night ferry",
                stake: "Getting home after late shifts",
                rung: "voiced",
                stakeWeight: 0.8,
                mentionsWeight: 0.6,
                quotes: [],
              },
            ],
            relations: [],
          });
        if (required === "items" && user.includes("bridge needs a cycle lane"))
          return JSON.stringify({ items: [{ phrase: "the bridge needs a cycle lane" }] });
        if (required === "items") return JSON.stringify({ items: [] });
        // The second pass: rooted, with a kind.
        return JSON.stringify({
          grounded: true,
          quote: "the bridge needs a cycle lane",
          reason: "",
          kind: "need",
          qualifiers: [],
          question_form: false,
          target: "",
        });
      },
    );

  async function addConversation(projectId: string, text: string) {
    const conv = newId();
    await sql`insert into conversation (id, project_id, participant_name, created_at, duration)
      values (${conv}, ${projectId}, 'Table 2', now() - interval '1 hour', 600)`;
    await say(conv, text);
    return conv;
  }

  const entryOf = async (loopId: string, conv: string) => {
    const [loop] = await sql`select popcorn_state from agent_loop where id = ${loopId}`;
    const state = loop?.popcorn_state as { conversations: Record<string, Json> } | undefined;
    return state?.conversations[conv];
  };

  test("free live ticks retry a failing conversation 3 times, then only a host read or new content does", async () => {
    broken.on = true;
    broken.reads = 0;
    const s = await seed("free", { status: "active", blocks: ["popcorn", "stakeholders"] });
    const conv = await addConversation(s.projectId, "BROKEN");
    for (let i = 0; i < 6; i++)
      await runPopcornTick(deps(failingWithSlide()), s.loopId, "scheduled");
    expect(broken.reads).toBe(3);

    // The host's own read retries it.
    await runPopcornTick(deps(failingWithSlide()), s.loopId, "manual", newId());
    expect(broken.reads).toBe(4);
    await runPopcornTick(deps(failingWithSlide()), s.loopId, "prepare:popcorn", newId());
    expect(broken.reads).toBe(5);

    // New content: read again, and once the model answers, the error clears.
    await say(conv, "BROKEN and the bridge needs a cycle lane.");
    broken.on = false;
    const got = await runPopcornTick(deps(failingWithSlide()), s.loopId, "scheduled");
    expect(got.status).toBe("ok");
    expect(broken.reads).toBe(6);
    const entry = await entryOf(s.loopId, conv);
    expect(entry?.error ?? null).toBeNull();
    expect(entry?.failed_reads).toBeUndefined();
  });

  test("paid live ticks retry a failing conversation every time", async () => {
    broken.on = true;
    broken.reads = 0;
    const s = await seed("guardian", { status: "active", blocks: ["popcorn", "stakeholders"] });
    await addConversation(s.projectId, "BROKEN");
    for (let i = 0; i < 5; i++)
      await runPopcornTick(deps(failingWithSlide()), s.loopId, "scheduled");
    expect(broken.reads).toBe(5);
  });

  test("a conversation read before that now keeps failing leaves free ticks with nothing to do", async () => {
    broken.on = false;
    broken.reads = 0;
    const s = await seed("free", { status: "active", blocks: ["popcorn", "stakeholders"] });
    const conv = await addConversation(s.projectId, "BROKEN the bridge needs a cycle lane.");
    await runPopcornTick(deps(failingWithSlide()), s.loopId, "scheduled");
    expect(((await entryOf(s.loopId, conv))?.items as unknown[] | undefined)?.length).toBe(1);
    await say(conv, "BROKEN again, the ferry should run all night.");
    broken.on = true;
    for (let i = 0; i < 3; i++)
      await runPopcornTick(deps(failingWithSlide()), s.loopId, "scheduled");
    const got = await runPopcornTick(deps(failingWithSlide()), s.loopId, "scheduled");
    expect(got.status).toBe("no_op");
    expect(broken.reads).toBe(4);
  });

  // A run a pre-deploy tick stamped and left running.
  const legacyRun = async (loopId: string, stamped: boolean) => {
    const id = newId();
    const period = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await sql`insert into agent_loop_run (id, loop_id, status, detail, started_at, finished_at, free_period_start)
      values (${id}, ${loopId}, 'running', 'old read',
        now() - make_interval(secs => ${STUCK_RUN_MS / 1000 + 60}), now(),
        ${stamped ? period.toISOString() : null})`;
    return id;
  };

  test("the sweep closes a legacy stamped run and gives nothing back", async () => {
    const s = await seed("free", { status: "active" });
    await spend(s.billing, s.projectId, 1234);
    const id = await legacyRun(s.loopId, true);
    expect(await settleStuckRuns(deps(fake()))).toBe(1);
    const [row] = await sql`select status, detail from agent_loop_run where id = ${id}`;
    expect(row).toEqual({ status: "error", detail: "Interrupted" });
    const usage =
      await sql`select key, amount from free_usage where billing_account_id = ${s.billing}`;
    expect(usage.map((r) => [r.key, Number(r.amount)])).toEqual([[AI_SPEND_KEY, 1234]]);
    expect(await settleStuckRuns(deps(fake()))).toBe(0);
  });

  test("the sweep leaves a stuck paid (unstamped) run exactly as it was", async () => {
    const s = await seed("guardian", { status: "active" });
    const id = await legacyRun(s.loopId, false);
    const row = async () => [...(await sql`select * from agent_loop_run where id = ${id}`)];
    const before = await row();
    await settleStuckRuns(deps(fake()));
    expect(await row()).toEqual(before);
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
      const latest = await store.latestRun(s.loopId);
      return { latest, finish: await finishReadState(store, s.loopId, latest, new Date()) };
    };
    const before = await view();
    await book(s.projectId, s.conv);
    expect(await finishTasks(s.loopId)).toBe(0);
    expect(await view()).toEqual(before);
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

  test("a finish read while live or booked runs on free", async () => {
    const live = await seed("free", { status: "active" });
    const a = await runPopcornTick(deps(fake()), live.loopId, "finish", newId(), [live.conv]);
    expect(a.status).toBe("ok");
    const booked = await seed("free");
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await sql`update agent_loop set caps = ${sql.json({ kind: "popcorn", ready_by: later, starts_at: later })}
      where id = ${booked.loopId}`;
    const b = await runPopcornTick(deps(fake()), booked.loopId, "finish", newId(), [booked.conv]);
    expect(b.status).toBe("ok");
  });

  test("paid finish reads outside live still run", async () => {
    const s = await seed("guardian");
    const got = await runPopcornTick(deps(fake()), s.loopId, "finish", newId(), [s.conv]);
    expect(got.status).toBe("ok");
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
  const controls = [
    ["POST", "refresh", undefined],
    ["POST", "rerun", undefined],
    ["POST", "live", { hours: 1 }],
    ["POST", "loop/resume", undefined],
    ["POST", "loop/go-live", undefined],
    ["PATCH", "loop", { expires_at: new Date(Date.now() + 3_600_000).toISOString() }],
  ] as const;

  test("at zero refresh, re-run, live and resume are refused with ai_budget", async () => {
    const s = await seed("free");
    await useAll(s);
    for (const [method, path, body] of controls) {
      const res = await call(method, `${s.reportId}/${path}`, body);
      expect({ path, status: res.status, limit: (res.body.details as Json)?.limit }).toEqual({
        path,
        status: 402,
        limit: "ai_budget",
      });
    }
    const [loop] = await sql`select status from agent_loop where id = ${s.loopId}`;
    expect(loop?.status).toBe("paused");
    const got = await call("GET", String(s.reportId));
    expect(got.body.ai_budget).toEqual({ exhausted: true });
    expect(got.body.free_popcorn).toBeUndefined();
    // Stopping live is never refused.
    expect((await call("POST", `${s.reportId}/live/stop`)).status).toBe(200);
  });

  test("below the limit, and on paid past it, the controls work", async () => {
    const free = await seed("free");
    await spend(free.billing, free.projectId, LIMIT - 1);
    const paid = await seed("guardian");
    await useAll(paid);
    for (const s of [free, paid])
      for (const [method, path, body] of controls) {
        const res = await call(method, `${s.reportId}/${path}`, body);
        expect({ path, ok: res.status < 300 }).toEqual({ path, ok: true });
      }
    expect((await call("GET", String(free.reportId))).body.ai_budget).toEqual({
      exhausted: false,
    });
    expect((await call("GET", String(paid.reportId))).body.ai_budget).toBeNull();
  });
});
