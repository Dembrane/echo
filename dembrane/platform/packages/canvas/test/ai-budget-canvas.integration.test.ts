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
import {
  AI_SPEND_KEY,
  aiBudgetForProject,
  allowanceForProject,
  invalidateFreeLimits,
  requireAiBudget,
} from "@dembrane/allowance";
import { createDb, migrate } from "@dembrane/db";
import { FakeCompleter } from "@dembrane/llm";
import { createLogger, withPayer } from "@dembrane/observability";
import { MemoryRateCounter, RateLimiter } from "@dembrane/ratelimit";
import postgres from "postgres";
import { tickDeps } from "../src/jobs";
import { type CanvasDeps, previewCanvas, refreshCanvas } from "../src/service";
import { canvasStore, client } from "../src/storage";
import { runTick } from "../src/ticks";
import { EXTRACTION, freshDatabase, GUIDE, ids, seed } from "./fixtures/seed";

// Canvas refresh and preview refuse at a used-up AI budget; scheduled ticks skip and resume.
const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const LIMIT = 5_000_000;
const who = { appUserId: ids.appUser, directusUserId: ids.user, isStaff: false };
const quiet = createLogger(
  { service: "t", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

function fake() {
  return new FakeCompleter()
    .on("You update a dembrane tabbed living canvas", EXTRACTION)
    .on("Open questions tab", GUIDE);
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e,
  );

run("canvas and the AI budget", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let raw: postgres.Sql;
  const billing = "b1000000-0000-4000-8000-000000000001";

  beforeAll(async () => {
    const url = await freshDatabase(admin as string, "canvas_ai_budget_test");
    await migrate(url, { appEnv: "test" });
    database = createDb({ url, poolMax: 4 });
    raw = postgres(url, { max: 2, onnotice: () => {} });
    await seed(raw);
    // The fixture's project moves into a free workspace its user owns.
    const [org, ws] = [
      "0a100000-0000-4000-8000-000000000001",
      "0b100000-0000-4000-8000-000000000001",
    ];
    await raw`insert into org (id, name) values (${org}, 'Org')`;
    await raw`insert into billing_account (id, org_id, tier) values (${billing}, ${org}, 'free')`;
    await raw`insert into workspace (id, name, org_id, billing_account_id) values (${ws}, 'W', ${org}, ${billing})`;
    await raw`insert into workspace_membership (id, workspace_id, user_id, role)
      values ('0c100000-0000-4000-8000-000000000001', ${ws}, ${ids.appUser}, 'owner')`;
    await raw`update project set workspace_id = ${ws} where id = ${ids.project}`;
  });
  beforeEach(() => invalidateFreeLimits());
  afterAll(async () => {
    invalidateFreeLimits();
    await raw?.end();
    await database?.close();
  });

  async function spend(amount: number, now = new Date()) {
    const a = await allowanceForProject(database.db, ids.project, now);
    if (!a) throw new Error("expected a free account");
    await raw`insert into free_usage (billing_account_id, period_start, key, amount)
      values (${a.accountId}, ${a.periodStart.toISOString()}, ${AI_SPEND_KEY}, ${amount})
      on conflict (billing_account_id, period_start, key) do update set amount = excluded.amount`;
  }

  function serviceDeps(completer: FakeCompleter, started: string[]): CanvasDeps {
    return {
      access: new Access(new DrizzleAccessStore(database.db)),
      accessStore: new DrizzleAccessStore(database.db),
      store: canvasStore(client(database.db)),
      canvasEnabled: true,
      completer,
      limiter: new RateLimiter(new MemoryRateCounter()),
      now: () => new Date(),
      requireAiBudget: (projectId, now) => requireAiBudget(database.db, projectId, now),
      startTick: async (loopId) => {
        started.push(loopId);
      },
      nudge: async () => {},
    };
  }

  const preview = (d: CanvasDeps) =>
    previewCanvas(d, who, {
      project_id: ids.project,
      brief: "Show the mood",
      gather_spec: null,
      tabs: null,
    });

  test("refresh at zero budget is refused with ai_budget and starts no tick", async () => {
    await spend(LIMIT);
    const started: string[] = [];
    const err = await rejection(refreshCanvas(serviceDeps(fake(), started), who, ids.report));
    expect(err).toMatchObject({ status: 402, details: { limit: "ai_budget" } });
    expect(started).toEqual([]);
  });

  test("preview at zero budget is refused with ai_budget and calls no model", async () => {
    await spend(LIMIT);
    const completer = fake();
    const err = await rejection(preview(serviceDeps(completer, [])));
    expect(err).toMatchObject({ status: 402, details: { limit: "ai_budget" } });
    expect(completer.calls.length).toBe(0);
  });

  test("refresh and preview below the limit still work", async () => {
    await spend(LIMIT - 1);
    const started: string[] = [];
    const completer = fake();
    expect(await refreshCanvas(serviceDeps(completer, started), who, ids.report)).toEqual({
      generation: "pending",
    });
    expect(started).toEqual([ids.loop]);
    const out = await preview(serviceDeps(completer, []));
    expect(out.content_html).toContain("Where should the next chargers go?");
    expect(completer.calls.length).toBe(2);
  });

  test("a scheduled tick at zero records a skip, keeps the schedule, and the next tick after the reset runs", async () => {
    const t0 = new Date();
    await spend(LIMIT, t0);
    let now = t0;
    const completer = fake();
    const deps = (label: string) =>
      tickDeps(
        { db: database.db, logger: quiet, completer, canvasEnabled: true, now: () => now },
        label,
      );
    const tick = (label: string) =>
      withPayer({ ref: "canvas", id: ids.loop }, () => runTick(deps(label), ids.loop, "scheduled"));

    expect(await tick("budget-1")).toBe("budget");
    expect(completer.calls.length).toBe(0);
    const runs = await raw`select status, detail from agent_loop_run where loop_id = ${ids.loop}`;
    expect([...runs]).toEqual([{ status: "no_op", detail: "Skipped: the AI budget is used up" }]);
    const [next] =
      await raw`select payload, status from scheduled_task where task_type = 'canvas_tick' and status = 'scheduled'`;
    expect(next?.payload).toEqual({ loop_id: ids.loop, tick_kind: "scheduled" });

    await raw`delete from free_usage where billing_account_id = ${billing}`;
    now = new Date(t0.getTime() + 5 * 60_000);
    expect(await tick("budget-2")).toBe("ok");
    expect(completer.calls.length).toBe(2);
  });

  const tickAt = (now: Date, completer: FakeCompleter, label: string, kind = "scheduled") => {
    let reads = 0;
    const base = tickDeps(
      { db: database.db, logger: quiet, completer, canvasEnabled: true, now: () => now },
      label,
    );
    const d = {
      ...base,
      budgetLeft: (projectId: string) => {
        reads++;
        return base.budgetLeft(projectId);
      },
    };
    return withPayer({ ref: "canvas", id: ids.loop }, () => runTick(d, ids.loop, kind)).then(
      (outcome) => ({ outcome, reads }),
    );
  };

  test("an idle scheduled tick with nothing new reads no budget", async () => {
    // Its own good generation first, so the idle tick does not lean on an earlier test.
    await spend(0);
    const first = await tickAt(new Date(Date.now() + 20 * 60_000), fake(), "idle-0", "manual");
    expect(first.outcome).toBe("ok");
    await spend(LIMIT);
    const completer = fake();
    const got = await tickAt(new Date(Date.now() + 25 * 60_000), completer, "idle-1");
    expect(got).toEqual({ outcome: "no_op", reads: 0 });
    expect(completer.calls.length).toBe(0);
  });

  test("a failed budget read lets the tick run and keeps the schedule", async () => {
    await spend(LIMIT);
    await raw`alter table billing_account rename column ai_budget_micro_eur to ai_budget_off`;
    try {
      expect(
        await rejection(aiBudgetForProject(database.db, ids.project, new Date())),
      ).toBeTruthy();
      await raw`delete from scheduled_task where task_type = 'canvas_tick'`;
      const completer = fake();
      const got = await tickAt(new Date(Date.now() + 30 * 60_000), completer, "broken-1", "manual");
      expect(got).toEqual({ outcome: "ok", reads: 1 });
      expect(completer.calls.length).toBe(2);
      const next =
        await raw`select status from scheduled_task where task_type = 'canvas_tick' and status = 'scheduled'`;
      expect(next).toHaveLength(1);
    } finally {
      await raw`alter table billing_account rename column ai_budget_off to ai_budget_micro_eur`;
    }
  });
});
