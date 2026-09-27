import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createLogger, initTracing } from "@echo/observability";
import { Queue } from "@echo/queue";
import postgres from "postgres";
import { startTurn } from "../src/jobs";
import { ids, prepareDb, seedRun } from "./fixtures/runs-db";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const trace = join(tmpdir(), `chat-durability-${Date.now()}.log`);
const fixture = new URL("./fixtures/turn-worker.ts", import.meta.url).pathname;
let url = "";

function spawn(executor: string, env: Record<string, string>) {
  return Bun.spawn(["bun", fixture], {
    env: { ...process.env, QUEUE_URL: url, TRACE_FILE: trace, EXECUTOR: executor, ...env },
    stdout: "ignore",
    stderr: "ignore",
  });
}
const lines = () => readFileSync(trace, "utf8").trim().split("\n");
async function until(check: () => Promise<boolean> | boolean, ms = 45_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out; trace:\n${readFileSync(trace, "utf8")}`);
    await Bun.sleep(200);
  }
}

run("agent turn survives a worker crash", () => {
  setDefaultTimeout(120_000);
  const procs: ReturnType<typeof spawn>[] = [];
  afterAll(() => {
    for (const p of procs) p.kill(9);
  });

  test("a turn on a killed worker resumes on another at its unfinished step, without doubled events", async () => {
    url = await prepareDb(admin as string, "chat_durability_test", { queue: true });
    await seedRun(url);
    writeFileSync(trace, "");
    const sql = postgres(url, { max: 2, onnotice: () => {} });

    const first = spawn("worker-a", { HANG: "1" });
    procs.push(first);
    await until(() => lines().includes("worker-a ready"));

    // The API side: a queue client enqueuing the turn job, twice, as two Stream calls would.
    const logger = createLogger(
      { service: "t", release: "r", env: "test", level: "error" },
      new Writable({ write: (_c, _e, cb) => cb() }),
    );
    const { tracer } = initTracing({ service: "t", release: "r", env: "test", sampleRatio: 0 });
    const api = new Queue(url, logger, tracer, { maxConnections: 2 });
    await api.start([startTurn]);
    const payload = {
      runId: ids.run,
      turnSeq: 1,
      projectId: ids.project,
      userMessage: "User Message: What did people say about parking?",
      hostUserMessage: "What did people say about parking?",
    };
    await api.enqueue(startTurn, payload, { singletonKey: `${ids.run}:1` });
    await api.enqueue(startTurn, payload, { singletonKey: `${ids.run}:1` });

    await until(() => lines().includes("worker-a lookup"));
    const before = await sql`
      select event_type from project_agentic_run_event where project_agentic_run_id = ${ids.run} order by seq`;
    expect(before.map((r) => r.event_type)).toContain("on_tool_start");
    first.kill(9);

    const second = spawn("worker-b", {});
    procs.push(second);
    await until(async () => {
      const [r] = await sql`select status from project_agentic_run where id = ${ids.run}`;
      return r?.status === "completed";
    });

    const events = await sql`
      select event_type, payload from project_agentic_run_event
      where project_agentic_run_id = ${ids.run} order by seq`;
    expect(events.map((e) => e.event_type)).toEqual([
      "user.message",
      "on_chat_model_end",
      "on_tool_start",
      "on_tool_end",
      "assistant.message",
      "on_chat_model_end",
      "on_tool_start",
      "on_tool_end",
      "assistant.message",
      "on_chat_model_end",
    ]);
    // Step 1 (the ack) ran once, on the first worker; only the unfinished step ran again.
    const trail = lines();
    expect(trail.filter((l) => l.endsWith("lookup"))).toEqual([
      "worker-a lookup",
      "worker-b lookup",
    ]);
    expect(trail).toContain("worker-b capture server_chat_response_received");
    const msgs = await sql`
      select text from project_chat_message where project_chat_id = ${ids.chat} and message_from = 'assistant'
      order by date_created`;
    expect(msgs.map((m) => m.text)).toEqual([
      "I'll look through the conversations.",
      "People mostly want more parking near the station.",
    ]);
    const workflows = await sql`
      select workflow_uuid, status from dbos.workflow_status where name = 'agentic.turn.run'`;
    expect(workflows.map((w) => [w.workflow_uuid, w.status])).toEqual([
      [`agentic-turn:${ids.run}:1`, "SUCCESS"],
    ]);
    await api.stop();
    await sql.end();
  });
});
