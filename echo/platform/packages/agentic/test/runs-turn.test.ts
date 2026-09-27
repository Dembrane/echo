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
import { APICallError } from "@ai-sdk/provider";
import { createDb } from "@echo/db";
import type { Emit } from "@echo/notifications";
import { createLogger } from "@echo/observability";
import type { AgentData } from "../src/agent/data";
import type { Agent } from "../src/agent/types";
import { watchers, watchRun } from "../src/runs/live";
import { runsStorage } from "../src/runs/storage";
import { runTurn, type TurnDeps } from "../src/runs/turn";
import { fakeAgent } from "./fixtures/fake-agent";
import { ids, prepareDb, seedRun } from "./fixtures/runs-db";

const admin = process.env.TEST_DATABASE_ADMIN_URL;
const run = admin ? describe : describe.skip;
const logger = createLogger(
  { service: "test", release: "r", env: "test", level: "error" },
  new Writable({ write: (_c, _e, cb) => cb() }),
);

run("turn workflow on a fake model", () => {
  setDefaultTimeout(60_000);
  let database: ReturnType<typeof createDb>;
  let url = "";
  const captured: { event: string; props: Record<string, unknown> }[] = [];
  const notified: Emit[] = [];
  const deps = (agent: Agent): TurnDeps => ({
    store: runsStorage(database.db),
    logger,
    models: { model: () => ({}) as never, embedding: () => ({}) as never },
    config: {
      agentic: { enableCanvas: false, modelGroup: "multi_modal_pro", runTimeoutSeconds: 600 },
      http: { dashboardUrl: "http://localhost:5173", portalUrl: "http://localhost:5174" },
    },
    agent,
    bindData: () => ({}) as AgentData,
    capture: async (_id, event, props) => {
      captured.push({ event, props });
    },
    notify: async (e) => {
      notified.push(e);
    },
    now: () => new Date(),
    cancelPollMs: 50,
  });
  const direct = <T>(_name: string, fn: () => Promise<T>) => fn();
  const args = {
    runId: ids.run,
    turnSeq: 1,
    projectId: ids.project,
    userMessage: "User Message: What did people say about parking?",
    hostUserMessage: "What did people say about parking?",
  };
  const events = async () =>
    (await database.db.$client`
      select seq, event_type, payload from project_agentic_run_event
      where project_agentic_run_id = ${ids.run} order by seq`) as unknown as {
      seq: number;
      event_type: string;
      payload: Record<string, unknown>;
    }[];
  const runRow = async () =>
    (
      await database.db.$client`select * from project_agentic_run where id = ${ids.run}`
    )[0] as Record<string, unknown>;

  beforeAll(async () => {
    url = await prepareDb(admin as string, "chat_turn_test");
    database = createDb({ url, poolMax: 4 });
  });
  afterAll(async () => {
    await database.close();
  });
  beforeEach(async () => {
    await seedRun(url);
    await database.db.$client`delete from project_chat_message where project_chat_id = ${ids.chat}`;
    captured.length = 0;
    notified.length = 0;
  });

  test("a turn stores the dashboard's events, the chat messages and completes", async () => {
    await runTurn(deps(fakeAgent()), args, direct);
    const ev = await events();
    expect(ev.map((e) => e.event_type)).toEqual([
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
    const ack = ev[4]?.payload as Record<string, unknown>;
    expect(ack.content).toBe("I'll look through the conversations.");
    // The ack message takes the id of the model call that made it, so its draft resolves into it.
    expect(ack.message_id).toBe(ack.persisted_message_id);
    const toolEnd = ev[3]?.payload as {
      data: { output: { kwargs: { content: string } } };
      name: string;
    };
    expect(toolEnd.name).toBe("ack");
    expect(JSON.parse(toolEnd.data.output.kwargs.content).kind).toBe("progress_update");
    const r = await runRow();
    expect(r.status).toBe("completed");
    expect(r.latest_output).toBe("People mostly want more parking near the station.");
    expect(r.completed_at).not.toBeNull();
    const msgs = await database.db.$client`
      select id, message_from, text from project_chat_message where project_chat_id = ${ids.chat} order by date_created`;
    expect(msgs.map((m) => m.text)).toEqual([
      "I'll look through the conversations.",
      "People mostly want more parking near the station.",
    ]);
    expect(captured.map((c) => c.event)).toEqual(["server_chat_response_received"]);
    expect(captured[0]?.props).toMatchObject({ has_output: true, mode: "agentic" });
    expect(notified[0]).toMatchObject({
      eventCode: "AGENTIC_RUN_FINISHED",
      title: "Your answer is ready",
      refChatId: ids.chat,
    });
  });

  test("a replayed step clears what its dead attempt wrote", async () => {
    const d = deps(fakeAgent());
    let crashed = false;
    await runTurn(d, args, async (name, fn) => {
      if (name === "agent-1" && !crashed) {
        crashed = true;
        // First attempt writes its events and then the process "dies" before checkpointing.
        await fn();
      }
      return fn();
    });
    const types = (await events()).map((e) => e.event_type);
    expect(types.filter((t) => t === "on_tool_start")).toHaveLength(2);
    expect(types.filter((t) => t === "assistant.message")).toHaveLength(2);
  });

  test("a newer host message queues the run again instead of completing it", async () => {
    const agent = fakeAgent({
      inLookup: async () => {
        await database.db.$client`
          insert into project_agentic_run_event (project_agentic_run_id, seq, event_type, payload, timestamp)
          values (${ids.run}, 999, 'user.message', ${JSON.stringify({ content: "and bikes?" })}::json, now())`;
      },
    });
    await runTurn(deps(agent), args, direct);
    expect((await runRow()).status).toBe("queued");
    expect(notified).toHaveLength(0);
  });

  test("Stop wins: the turn ends quietly and never overwrites the failed status", async () => {
    const agent = fakeAgent({
      inLookup: async () => {
        await database.db
          .$client`update project_agentic_run set status = 'failed' where id = ${ids.run}`;
        await Bun.sleep(200);
      },
    });
    await runTurn(deps(agent), args, direct);
    const r = await runRow();
    expect(r.status).toBe("failed");
    const types = (await events()).map((e) => e.event_type);
    expect(types).not.toContain("run.failed");
    expect(captured.map((c) => c.props.error_code)).toEqual(["AGENT_CANCELLED"]);
  });

  test("upstream failures end the run with the error code only", async () => {
    const agent: Agent = {
      step: async () => {
        throw new APICallError({
          message: "429 Resource exhausted",
          url: "u",
          requestBodyValues: {},
          statusCode: 429,
        });
      },
    };
    await runTurn(deps(agent), args, direct);
    const ev = await events();
    expect(ev.at(-1)).toMatchObject({
      event_type: "run.failed",
      payload: { error_code: "AGENT_UPSTREAM_429", status_code: 429 },
    });
    const r = await runRow();
    expect(r.status).toBe("failed");
    expect(r.latest_error_code).toBe("AGENT_UPSTREAM_429");
    expect(notified[0]).toMatchObject({ eventCode: "AGENTIC_RUN_STOPPED" });
  });

  test("a transient failure before any output is retried once", async () => {
    const inner = fakeAgent();
    let failed = false;
    const agent: Agent = {
      step: async (input, emit) => {
        if (!failed) {
          failed = true;
          throw new APICallError({
            message: "unavailable",
            url: "u",
            requestBodyValues: {},
            statusCode: 503,
          });
        }
        return inner.step(input, emit);
      },
    };
    await runTurn(deps(agent), args, direct);
    expect((await runRow()).status).toBe("completed");
  });

  test("the per-turn tool limit ends the turn with one honest message", async () => {
    const agent: Agent = {
      step: async (input, emit) => {
        await emit({
          type: "model-end",
          messageId: `m${input.stepIndex}`,
          content: "",
          toolCalls: [],
          model: "fake",
        });
        for (let i = 0; ; i++)
          await emit({
            type: "tool-start",
            runId: `t${input.stepIndex}-${i}`,
            toolCallId: `c${i}`,
            name: "grepDocs",
            input: { patterns: [String(i)] },
          });
      },
    };
    await runTurn(deps(agent), args, direct);
    const ev = await events();
    expect(ev.filter((e) => e.event_type === "on_tool_start")).toHaveLength(149);
    expect(ev.filter((e) => e.event_type === "agent.nudge").length).toBeGreaterThan(0);
    const last = ev.filter((e) => e.event_type === "assistant.message").at(-1);
    expect(String(last?.payload.content)).toContain(
      'I need to pause this pass on your request: "What did people say about parking?"',
    );
    expect((await runRow()).status).toBe("completed");
  });

  test("a turn that is no longer the latest does not start", async () => {
    await database.db.$client`
      insert into project_agentic_run_event (project_agentic_run_id, seq, event_type, payload, timestamp)
      values (${ids.run}, 2, 'user.message', ${JSON.stringify({ content: "newer" })}::json, now())`;
    const seen: unknown[] = [];
    await runTurn(deps(fakeAgent({ seen: seen as never })), args, direct);
    expect(seen).toHaveLength(0);
    expect((await runRow()).status).toBe("queued");
  });

  test("an open stream marks the run watched, so no inbox notification is sent", async () => {
    const sql = database.db.$client;
    const end = await watchRun(sql, ids.run);
    expect(await watchers(sql, ids.run)).toBe(1);
    await runTurn(deps(fakeAgent()), args, direct);
    expect(notified).toHaveLength(0);
    await end();
    expect(await watchers(sql, ids.run)).toBe(0);
  });
});
