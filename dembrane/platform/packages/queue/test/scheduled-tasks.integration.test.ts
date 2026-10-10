import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { migrate } from "@dembrane/db";
import postgres from "postgres";
import { runDueTasks, scheduledTasks } from "../src/scheduled-tasks";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const url = admin ? `${admin.slice(0, admin.lastIndexOf("/"))}/queue_scheduled_tasks_test` : "";
const NOW = "2026-10-09T12:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

run("scheduled tasks", () => {
  setDefaultTimeout(60_000);
  let sql: postgres.Sql;
  beforeAll(async () => {
    const a = postgres(admin as string, { max: 1, onnotice: () => {} });
    await a.unsafe("drop database if exists queue_scheduled_tasks_test with (force)");
    await a.unsafe("create database queue_scheduled_tasks_test");
    await a.end();
    await migrate(url, { appEnv: "test" });
    sql = postgres(url, { max: 2, onnotice: () => {} });
  });
  beforeEach(async () => {
    await sql`delete from scheduled_task`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  test("only due tasks of the asked types are claimed, oldest first, and never twice", async () => {
    const tasks = scheduledTasks(sql);
    const late = await tasks.book({ taskType: "a", payload: { n: 2 }, at: at(-1), now: NOW });
    const early = await tasks.book({ taskType: "a", payload: { n: 1 }, at: at(-5), now: NOW });
    await tasks.book({ taskType: "a", payload: { n: 3 }, at: at(5), now: NOW });
    await tasks.book({ taskType: "b", payload: {}, at: at(-5), now: NOW });

    const claimed = await tasks.claimDue(["a"], NOW);
    expect(claimed.map((t) => t.id)).toEqual([early, late]);
    expect(claimed.map((t) => t.payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(claimed.every((t) => t.status === "processing" && t.attempts === 1)).toBe(true);
    expect(await tasks.claimDue(["a"], NOW)).toEqual([]);
    expect((await tasks.claimDue(["a", "b"], NOW)).map((t) => t.task_type)).toEqual(["b"]);
  });

  test("cancel takes the booked tasks that match and leaves the kept kinds and the claimed", async () => {
    const tasks = scheduledTasks(sql);
    const book = (payload: Record<string, unknown>, minutes: number) =>
      tasks.book({ taskType: "tick", payload, at: at(minutes), now: NOW });
    const chain = await book({ loop_id: "one", tick_kind: "scheduled" }, 2);
    const bare = await book({ loop_id: "one" }, 3);
    const start = await book({ loop_id: "one", tick_kind: "start" }, 4);
    const other = await book({ loop_id: "two", tick_kind: "scheduled" }, 2);
    const running = await book({ loop_id: "one", tick_kind: "scheduled" }, -1);
    await tasks.claimDue(["tick"], NOW);

    const n = await tasks.cancel("tick", NOW, {
      match: { loop_id: "one" },
      keep: { key: "tick_kind", values: ["start"] },
    });
    expect(n).toBe(2);
    const status = Object.fromEntries(
      (await sql`select id, status from scheduled_task`).map((r) => [r.id, r.status]),
    );
    expect(status).toEqual({
      [chain]: "cancelled",
      [bare]: "cancelled",
      [start]: "scheduled",
      [other]: "scheduled",
      [running]: "processing",
    });
    // Without kept kinds every booked match goes.
    expect(await tasks.cancel("tick", NOW, { match: { loop_id: "one" } })).toBe(1);
    expect((await tasks.pending("tick")).map((t) => t.id).sort()).toEqual([other, running].sort());
  });

  test("a claim left processing too long is booked again", async () => {
    const tasks = scheduledTasks(sql);
    const id = await tasks.book({ taskType: "a", payload: {}, at: at(-30), now: at(-30) });
    await tasks.claimDue(["a"], at(-20));
    expect(await tasks.resetStaleClaims(["a"], NOW, at(-25))).toBe(0);
    expect(await tasks.resetStaleClaims(["b"], NOW, at(-15))).toBe(0);
    expect(await tasks.resetStaleClaims(["a"], NOW, at(-15))).toBe(1);
    const [again] = await tasks.claimDue(["a"], NOW);
    expect(again).toMatchObject({ id, attempts: 2 });
  });

  test("a pass runs each due task, and one that throws is settled as failed", async () => {
    const tasks = scheduledTasks(sql);
    const good = await tasks.book({ taskType: "a", payload: { ok: true }, at: at(-2), now: NOW });
    const bad = await tasks.book({ taskType: "a", payload: { ok: false }, at: at(-1), now: NOW });
    const seen: string[] = [];
    const out = await runDueTasks(
      tasks,
      { taskTypes: ["a"], now: () => new Date(NOW), iso: (d) => d.toISOString() },
      async (task) => {
        seen.push(task.id);
        if (!task.payload.ok) throw new Error("no such loop");
      },
    );
    expect(out).toEqual({ ran: 2, failed: 1 });
    expect(seen).toEqual([good, bad]);
    const rows = await sql`select id, status, error from scheduled_task order by scheduled_at`;
    expect([...rows]).toEqual([
      { id: good, status: "completed", error: null },
      { id: bad, status: "failed", error: "no such loop" },
    ]);
  });
});
