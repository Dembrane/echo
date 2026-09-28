import { describe, expect, test } from "bun:test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { createAgent, stepMessageId } from "../src/agent/agent";
import type { AgentData, Json, TurnContext } from "../src/agent/data";
import { NO_DOCS, safePattern } from "../src/agent/knowledge";
import { systemPromptFor } from "../src/agent/prompt";
import { REPEATED_CALL_MESSAGE, REPEATED_CALL_STOP_MESSAGE } from "../src/agent/text";
import { CANVAS_TOOL_NAMES, TOOLS, toolsFor } from "../src/agent/tools";
import type { StepEvent, StepInput } from "../src/agent/types";

const P = "f0000000-0000-4000-8000-000000000001";
const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({
  projectId: P,
  threadId: "11111111-1111-4111-8111-111111111111",
  chatId: "c3000000-0000-4000-8000-000000000001",
  appUserId: "a0000000-0000-4000-8000-000000000002",
  messageId: "42",
  canvasEnabled: true,
  docsBaseUrl: "",
  portalUrl: "http://localhost:5174",
  ...over,
});

type Calls = { method: string; args: unknown[] }[];

/** Canned answers shaped like the /api/agentic routes; records every call. */
function fakeData(calls: Calls, over: Partial<Record<keyof AgentData, unknown>> = {}): AgentData {
  const conv = {
    conversation_id: "c1",
    participant_name: "Alice",
    status: "done",
    summary: "About buses",
    started_at: "2026-09-01T09:00:00.000Z",
    last_chunk_at: "2026-09-01T09:30:00.000Z",
    matches: [{ chunk_id: "k1", snippet: "bus stop" }],
  };
  const canned: Record<keyof AgentData, unknown> = {
    projectSettings: {
      name: "P",
      language: "nl",
      context: "",
      default_conversation_ask_for_participant_name: null,
    },
    projectTags: [
      { id: "t1", text: "Energy" },
      { id: "t2", text: "Mobility" },
    ],
    editProjectTags: {},
    projectGoal: { project_id: P, current: null, revisions: [] },
    methodologies: { project_id: P, methodologies: [{ id: "m1", name: "dembrane" }] },
    reports: [{ id: 7, status: "published" }],
    report: { id: 7, content: "# Title", title: "Title" },
    monitor: { summary: { live: 1 }, conversations: [] },
    conversations: { project_id: P, count: 1, offset: 0, has_more: false, conversations: [conv] },
    focusedConversations: {
      total: 1,
      count: 1,
      has_more: false,
      conversations: [{ id: "c1", name: "Alice" }],
    },
    transcript: "Alice: hello",
    searchHome: { conversations: [], transcripts: [] },
    chats: [{ id: "chat1", name: "Earlier" }],
    chatMessages: [{ message_from: "user", text: "hi", date_created: "x" }],
    memory: {
      project_id: P,
      count: 1,
      memories: [
        { id: "mem1", scope: "project", content: "Spell it Akshita", updated_at: "2026-09-01" },
      ],
    },
    writeMemory: { id: "mem2", scope: "project", action: "created" },
    amendMemory: { id: "mem1", scope: "project", action: "amended" },
    forgetMemory: { id: "mem1", deleted: true },
    supportRequest: { id: "sr1", status: "new" },
    noteInsight: { id: "i1", status: "new" },
    editInsight: {
      id: "i1",
      kind: "wish",
      content: "Needs X",
      suggested_capability: null,
      status: "new",
    },
    retractInsight: {
      id: "i1",
      kind: "wish",
      content: "Needs X",
      suggested_capability: null,
      status: "retracted",
    },
    canvases: [
      { id: "cv1", name: "The wall" },
      { id: "cv2", name: "Pulse" },
    ],
    canvasActivity: {
      canvases: [
        {
          id: "cv1",
          name: "The wall",
          recent_runs: [{ status: "ok", detail: "added 2", started_at: "t" }],
        },
      ],
    },
    canvas: { id: "cv1", latest_generation: { id: "g1", content_html: "<p>x</p>" } },
    canvasHistory: { id: "cv1", name: "The wall", history: [{ kind: "edit" }] },
    editCanvas: { id: "cv1", status: "edited", generation: { id: "g2" } },
    addCanvasHostItem: { status: "added", host_item: { id: "h1" } },
    removeCanvasHostItem: { status: "removed", item: { id: "h1" } },
    canvasLoop: { status: "paused", expires_at: null, cadence_minutes: 5 },
    ...over,
  };
  return new Proxy({} as AgentData, {
    get:
      (_t, method: string) =>
      async (...args: unknown[]) => {
        calls.push({ method, args });
        const v = canned[method as keyof AgentData];
        if (v instanceof Error) throw v;
        return typeof v === "function"
          ? (v as (...a: unknown[]) => unknown)(...args)
          : structuredClone(v);
      },
  });
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = (tools: boolean): LanguageModelV4StreamPart => ({
  type: "finish",
  usage,
  finishReason: { unified: tools ? "tool-calls" : "stop", raw: undefined },
});
const text = (t: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "t" },
  ...t.split(" ").map((w, i) => ({ type: "text-delta" as const, id: "t", delta: i ? ` ${w}` : w })),
  { type: "text-end", id: "t" },
];
const call = (id: string, name: string, input: unknown): LanguageModelV4StreamPart => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(input),
});
const turn = (...parts: LanguageModelV4StreamPart[]) => ({
  stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
    { type: "stream-start", warnings: [] },
    ...parts,
    finish(parts.some((p) => p.type === "tool-call")),
  ]),
});

function model(...turns: ReturnType<typeof turn>[]) {
  return new MockLanguageModelV4({ doStream: turns });
}

async function runStep(
  over: Partial<StepInput> & { model: MockLanguageModelV4 },
  data?: AgentData,
) {
  const events: StepEvent[] = [];
  const calls: Calls = [];
  const agent = createAgent({ now: () => new Date("2026-09-27T12:00:00.000Z") });
  const result = await agent.step(
    {
      ctx: ctx(),
      data: data ?? fakeData(calls),
      messages: [{ role: "user", content: "Hello" }],
      stepIndex: 0,
      signal: new AbortController().signal,
      ...over,
    },
    async (e) => {
      events.push(e);
    },
  );
  return { events, result, calls };
}

const outputOf = (events: StepEvent[], name: string) =>
  (events.find((e) => e.type === "tool-end" && e.name === name) as { output: unknown } | undefined)
    ?.output;

describe("agent step", () => {
  test("registers the 46 tools, canvas tools only when canvas is on", () => {
    expect(TOOLS.length).toBe(46);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(46);
    const off = toolsFor(false).map((t) => t.name);
    expect(off.length).toBe(46 - CANVAS_TOOL_NAMES.size);
    for (const n of CANVAS_TOOL_NAMES) expect(off).not.toContain(n);
  });

  test("the model sees only canvas-free tools and prompt when canvas is off", async () => {
    const m = model(turn(...text("Hi there")));
    await runStep({ model: m, ctx: ctx({ canvasEnabled: false }) });
    const sent = m.doStreamCalls[0];
    const names = (sent?.tools ?? []).map((t) => t.name);
    expect(names).not.toContain("proposeCanvas");
    expect(names).toContain("navigateTo");
    const system = sent?.prompt.find((p) => p.role === "system")?.content as string;
    expect(system).not.toContain("## Canvases");
    expect(system).not.toContain("Canvas activity since last turn");
    expect(systemPromptFor(false)).toContain(
      "- Library: conversations, reports, and analysis materials.",
    );
  });

  test("a text answer streams deltas, then ends the turn", async () => {
    const { events, result } = await runStep({ model: model(turn(...text("All good here"))) });
    expect(events.map((e) => e.type)).toEqual([
      "text-delta",
      "text-delta",
      "text-delta",
      "model-end",
    ]);
    const end = events.at(-1) as Extract<StepEvent, { type: "model-end" }>;
    expect(end.content).toBe("All good here");
    expect(end.messageId).toBe(stepMessageId(ctx(), 0));
    expect(result.done).toBe(true);
    expect(result.responseMessages).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(result.responseMessages))).toEqual(result.responseMessages);
  });

  test("message ids are stable per turn and step", () => {
    expect(stepMessageId(ctx(), 1)).toBe(stepMessageId(ctx(), 1));
    expect(stepMessageId(ctx(), 1)).not.toBe(stepMessageId(ctx(), 2));
    expect(stepMessageId(ctx(), 1)).not.toBe(stepMessageId(ctx({ messageId: "43" }), 1));
    expect(stepMessageId(ctx(), 0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("tool calls run and report in order: model-end, tool-start, tool-end", async () => {
    const { events, result } = await runStep({
      model: model(turn(call("a", "listReports", {}), call("b", "readGoal", {}))),
    });
    expect(events.map((e) => `${e.type}:${"name" in e ? e.name : ""}`)).toEqual([
      "model-end:",
      "tool-start:listReports",
      "tool-start:readGoal",
      "tool-end:listReports",
      "tool-end:readGoal",
    ]);
    expect(result.done).toBe(false);
    const toolMsg = result.responseMessages[1] as {
      role: string;
      content: { output: { value: string } }[];
    };
    expect(toolMsg.role).toBe("tool");
    expect(JSON.parse(toolMsg.content[0]?.output.value as string)).toEqual({
      reports: [{ id: 7, status: "published" }],
      count: 1,
    });
  });

  test("tool errors reach the model as Tool error text and the dashboard as on_tool_error", async () => {
    const { events, result } = await runStep({
      model: model(turn(call("a", "readReport", { report_id: "  " }))),
    });
    expect(events.map((e) => e.type)).toEqual(["model-end", "tool-start", "tool-error"]);
    const value = (result.responseMessages[1] as { content: { output: { value: string } }[] })
      .content[0]?.output.value;
    expect(value).toBe(
      "Tool error: ValueError: report_id is required. Continue with available evidence, avoid repeating failing calls, and summarize constraints.",
    );
  });

  test("invalid arguments are a ValidationError, an unknown tool an error without events", async () => {
    const { events, result } = await runStep({
      model: model(turn(call("a", "readReport", { report_id: 5 }), call("b", "noSuchTool", {}))),
    });
    expect(events.map((e) => e.type)).toEqual(["model-end", "tool-start", "tool-error"]);
    const values = (
      result.responseMessages[1] as { content: { output: { value: string } }[] }
    ).content.map((c) => c.output.value);
    expect(values[0]).toStartWith("Tool error: ValidationError: report_id:");
    expect(values[1]).toStartWith(
      "Error: noSuchTool is not a valid tool, try one of [get_project_scope, ",
    );
  });

  test("old tool names run as the renamed tool and history carries the new name", async () => {
    const { events, result } = await runStep({
      model: model(turn(call("a", "findConvosByKeywords", { keywords: "buses and trams" }))),
    });
    expect(events[1]).toMatchObject({ type: "tool-start", name: "findConversationsByKeywords" });
    const assistant = result.responseMessages[0] as {
      content: { type: string; toolName?: string }[];
    };
    expect(assistant.content.find((p) => p.type === "tool-call")?.toolName).toBe(
      "findConversationsByKeywords",
    );
  });

  test("a fused tool name is split into its registered tools", async () => {
    const { events, result } = await runStep({
      model: model(
        turn({
          type: "tool-call",
          toolCallId: "f",
          toolName: "listReportsreadGoal",
          input: "{}{}",
        }),
      ),
    });
    expect(
      events.filter((e) => e.type === "tool-end").map((e) => ("name" in e ? e.name : "")),
    ).toEqual(["listReports", "readGoal"]);
    const parts = (result.responseMessages[0] as { content: { toolCallId?: string }[] }).content;
    expect(parts.map((p) => p.toolCallId)).toEqual(["f-0", "f-1"]);
  });

  test("the repetition guard answers repeats, then tells the model to stop, across replayed steps", async () => {
    const q = { conversation_id: "c1" };
    // Step 0 ran listConversationSummary; step 1 repeats it twice; step 2 repeats once more.
    const first = await runStep({ model: model(turn(call("a", "listConversationSummary", q))) });
    const history: ModelMessage[] = [
      { role: "user", content: "Hello" },
      ...first.result.responseMessages,
    ];
    const second = await runStep({
      model: model(
        turn(call("b", "listConversationSummary", q), call("c", "listConversationSummary", q)),
      ),
      messages: history,
      stepIndex: 1,
    });
    // Skipped repeats never ran: no tool events, as before.
    expect(second.events.map((e) => e.type)).toEqual(["model-end"]);
    const values = (
      second.result.responseMessages[1] as { content: { output: { value: string } }[] }
    ).content.map((c) => c.output.value);
    expect(values).toEqual([REPEATED_CALL_MESSAGE, REPEATED_CALL_MESSAGE]);
    // A replay of step 2 rebuilds the count from the messages alone.
    const third = await runStep({
      model: model(turn(call("d", "listConversationSummary", q))),
      messages: [...history, ...second.result.responseMessages],
      stepIndex: 2,
    });
    expect(
      (third.result.responseMessages[1] as { content: { output: { value: string } }[] }).content[0]
        ?.output.value,
    ).toBe(REPEATED_CALL_STOP_MESSAGE);
  });

  test("a new user turn clears the guard", async () => {
    const q = { conversation_id: "c1" };
    const first = await runStep({ model: model(turn(call("a", "listConversationSummary", q))) });
    const next = await runStep({
      model: model(turn(call("b", "listConversationSummary", q))),
      messages: [
        { role: "user", content: "Hello" },
        ...first.result.responseMessages,
        { role: "assistant", content: "Done." },
        { role: "user", content: "Again please" },
      ],
    });
    expect(next.events.map((e) => e.type)).toEqual(["model-end", "tool-start", "tool-end"]);
  });

  test("three identical results in a row get the note", async () => {
    const steps: ModelMessage[] = [{ role: "user", content: "Hi" }];
    let last = "";
    for (const [i, name] of ["listReports", "listReports", "listReports"].entries()) {
      // Same tool, different arguments each time, same result.
      const r = await runStep({
        model: model(turn(call(`x${i}`, "readReport", { report_id: `${i + 1}` }))),
        messages: steps,
        stepIndex: i,
      });
      void name;
      steps.push(...r.result.responseMessages);
      last = (r.result.responseMessages[1] as { content: { output: { value: string } }[] })
        .content[0]?.output.value as string;
    }
    expect(last).toContain("(Note: your last 3 lookups returned the same result.");
  });

  test("the automatic nudge rides in the system prompt after six silent calls, once", async () => {
    const history: ModelMessage[] = [{ role: "user", content: "Dig in" }];
    for (let i = 0; i < 6; i++) {
      history.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: `t${i}`,
            toolName: "readReport",
            input: { report_id: `${i}` },
          },
        ],
      });
      history.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `t${i}`,
            toolName: "readReport",
            output: { type: "text", value: `r${i}` },
          },
        ],
      });
    }
    const m = model(turn(...text("Here is what I found")));
    await runStep({ model: m, messages: history, stepIndex: 6 });
    const system = m.doStreamCalls[0]?.prompt.find((p) => p.role === "system")?.content as string;
    expect(system).toContain("## Runtime note (from the app, not the host)");
    expect(system).toContain("You have made 6 tool calls without telling the host anything.");

    // The same milestone does not fire again at the next call of the turn.
    history.push({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "t6", toolName: "readReport", input: { report_id: "6" } },
      ],
    });
    history.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "t6",
          toolName: "readReport",
          output: { type: "text", value: "r6" },
        },
      ],
    });
    const m2 = model(turn(...text("Done")));
    await runStep({ model: m2, messages: history, stepIndex: 7 });
    expect(m2.doStreamCalls[0]?.prompt.find((p) => p.role === "system")?.content).not.toContain(
      "Runtime note",
    );
  });

  test("an empty reply after a nudge is retried once with the continuation note", async () => {
    const history: ModelMessage[] = [{ role: "user", content: "Dig in" }];
    for (let i = 0; i < 6; i++) {
      history.push({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: `t${i}`, toolName: "listDocs", input: { i } }],
      });
      history.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `t${i}`,
            toolName: "listDocs",
            output: { type: "text", value: `r${i}` },
          },
        ],
      });
    }
    const m = model(turn(), turn(...text("Final answer")));
    const { events, result } = await runStep({ model: m, messages: history, stepIndex: 6 });
    expect(m.doStreamCalls).toHaveLength(2);
    expect(m.doStreamCalls[1]?.prompt.find((p) => p.role === "system")?.content).toContain(
      "Your last attempt answered nobody",
    );
    expect(result.done).toBe(true);
    expect((events.at(-1) as { content: string }).content).toBe("Final answer");
  });

  test("the system prompt carries remembered notes and canvas activity", async () => {
    const m = model(turn(...text("ok")));
    await runStep({ model: m });
    const system = m.doStreamCalls[0]?.prompt.find((p) => p.role === "system")?.content as string;
    expect(system).toContain("## What you remember\n- project: Spell it Akshita");
    expect(system).toContain(
      "## Canvas activity since last turn\n- The wall (cv1)\n  - ok at t: added 2",
    );
    expect(system).toContain("Available skills (read the body with readSkill when one applies):");
  });
});

describe("tool results", () => {
  const cases: [string, unknown, (o: Json) => void][] = [
    ["get_project_scope", {}, (o) => expect(o).toEqual({ project_id: P })],
    [
      "findConversationsByKeywords",
      { keywords: "bus stop" },
      (o) => expect(o).toMatchObject({ project_id: P, query: "bus stop", count: 1 }),
    ],
    [
      "findConversationsByKeywords",
      { keywords: "a b" },
      (o) => expect((o.guardrail as Json).code).toBe("LOW_SIGNAL_QUERY"),
    ],
    [
      "listProjectConversations",
      { limit: 500 },
      (o) =>
        expect(o).toEqual({
          project_id: P,
          count: 1,
          offset: 0,
          has_more: false,
          conversations: [
            {
              conversation_id: "c1",
              project_id: P,
              project_name: null,
              participant_name: "Alice",
              status: "done",
              started_at: "2026-09-01T09:00:00.000Z",
              last_chunk_at: "2026-09-01T09:30:00.000Z",
              summary: "About buses",
              matches: [{ chunk_id: "k1", snippet: "bus stop" }],
            },
          ],
        }),
    ],
    [
      "listFocusedConversations",
      {},
      (o) => expect(o).toMatchObject({ total: 1, count: 1, offset: 0 }),
    ],
    [
      "listConversationSummary",
      { conversation_id: "c1" },
      (o) => expect((o.conversation as Json).participant_name).toBe("Alice"),
    ],
    [
      "listConversationFullTranscript",
      { conversation_id: "c1" },
      (o) =>
        expect(o).toEqual({
          project_id: P,
          conversation_id: "c1",
          participant_name: "Alice",
          transcript: "Alice: hello",
        }),
    ],
    [
      "grepConversationSnippets",
      { conversation_id: "c1", query: "bus" },
      (o) => expect(o).toMatchObject({ query: "bus", count: 1 }),
    ],
    ["listDocs", {}, (o) => expect(o).toEqual({ docs: [], note: NO_DOCS })],
    [
      "readDoc",
      { paths: ["../../etc/passwd"] },
      (o) => expect(o).toEqual({ docs: [{ path: "../../etc/passwd", content: NO_DOCS }] }),
    ],
    [
      "grepDocs",
      { patterns: ["portal"] },
      (o) =>
        expect(o).toEqual({ results: [{ pattern: "portal", matches: [] }], note: NO_DOCS }),
    ],
    ["readSkill", { path: "interviewing.md" }, (o) => expect(o.text).toStartWith("---")],
    [
      "listReports",
      {},
      (o) => expect(o).toEqual({ reports: [{ id: 7, status: "published" }], count: 1 }),
    ],
    ["readReport", { report_id: "7" }, (o) => expect(o.title).toBe("Title")],
    [
      "getProjectSettings",
      {},
      (o) =>
        expect(o).toEqual({
          name: "P",
          language: "nl",
          context: "default",
          default_conversation_ask_for_participant_name: "default",
        }),
    ],
    ["getProjectTags", {}, (o) => expect(o).toMatchObject({ project_id: P, count: 2 })],
    [
      "getPortalLink",
      {},
      (o) =>
        expect(o).toEqual({
          project_id: P,
          language: "nl",
          portal_link: `http://localhost:5174/nl/${P}/start`,
          dashboard_locations: ["Overview", "Host guide"],
        }),
    ],
    [
      "navigateTo",
      { page: "host-guide" },
      (o) =>
        expect(o).toEqual({
          type: "navigation_suggestion",
          project_id: P,
          page: "host-guide",
          entity_id: null,
          label: "host guide",
          visible_to_user: true,
        }),
    ],
    [
      "proposeProjectUpdate",
      {
        changes: [{ field: "context", value: "x", reason: " r " }, { field: "nope" }],
        summary: " s ",
      },
      (o) =>
        expect(o).toEqual({
          kind: "project_update_suggestion",
          project_id: P,
          summary: "s",
          changes: [{ field: "context", current: "", proposed: "x", reason: "r" }],
          rejected_fields: ["nope"],
          visible_to_user: true,
        }),
    ],
    [
      "proposeTagsUpdate",
      { add: ["Food", "food"], remove: ["energy", "Ghost"], summary: "why" },
      (o) =>
        expect(o).toEqual({
          kind: "tags_update_suggestion",
          project_id: P,
          summary: "why",
          add: ["Food"],
          remove: ["energy"],
          current_tags: ["Energy", "Mobility"],
          rejected_removals: ["Ghost"],
          visible_to_user: true,
        }),
    ],
    [
      "proposeCustomVerificationTopic",
      { label: "L", prompt: "Check X" },
      (o) =>
        expect(o).toEqual({
          kind: "custom_verification_topic_suggestion",
          project_id: P,
          label: "L",
          prompt: "Check X",
          reason: "",
          visible_to_user: true,
        }),
    ],
    [
      "proposeCanvas",
      { name: "Wall", brief: "Show themes", target_canvas_id: "pulse" },
      (o) =>
        expect(o).toEqual({
          type: "canvas_proposal",
          name: "Wall",
          brief: "Show themes",
          gather_spec: { window_minutes: 60 },
          cadence_minutes: 5,
          expires_at: "2026-09-27T20:00:00.000000+00:00",
          visible_to_user: true,
          target_canvas_id: "cv2",
          target_canvas_name: "Pulse",
        }),
    ],
    [
      "ack",
      { message: " On it ", plan: ["a", " ", "b"] },
      (o) =>
        expect(o).toEqual({
          kind: "progress_update",
          update: "On it",
          plan: ["a", "b"],
          visible_to_user: true,
        }),
    ],
    [
      "updatePlan",
      { steps: ["a", "b"], done: 5, note: "n" },
      (o) =>
        expect(o).toEqual({
          kind: "plan",
          steps: ["a", "b"],
          done: 2,
          note: "n",
          visible_to_user: false,
        }),
    ],
    [
      "sendProgressUpdate",
      { update: "u" },
      (o) =>
        expect(o).toEqual({
          kind: "progress_update",
          update: "u",
          next_steps: "",
          visible_to_user: true,
        }),
    ],
    [
      "listProjectChats",
      {},
      (o) => expect(o).toEqual({ chats: [{ id: "chat1", name: "Earlier" }] }),
    ],
    ["readChat", { chat_id: "chat1" }, (o) => expect((o.messages as Json[]).length).toBe(1)],
    ["getLiveConversationStatus", {}, (o) => expect(o.summary).toEqual({ live: 1 })],
    [
      "reachOutToDembraneSupport",
      { message: "Broken" },
      (o) => expect(o).toEqual({ sent: true, support_request_id: "sr1" }),
    ],
    [
      "noteInsight",
      { kind: "wish", content: "Needs X" },
      (o) =>
        expect(o).toEqual({
          type: "agent_insight_proposal",
          mode: "proposed",
          recorded: false,
          insight_kind: "wish",
          content: "Needs X",
          suggested_capability: null,
          visible_to_user: true,
        }),
    ],
    [
      "editInsight",
      { insight_id: "i1", content: "Needs X" },
      (o) =>
        expect(o).toEqual({
          type: "agent_insight_note",
          mode: "edited",
          recorded: true,
          agent_insight_id: "i1",
          insight_kind: "wish",
          content: "Needs X",
          suggested_capability: null,
          visible_to_user: true,
        }),
    ],
    [
      "retractInsight",
      { insight_id: "i1", reason: "wrong" },
      (o) => expect(o).toMatchObject({ mode: "retracted", reason: "wrong", status: "retracted" }),
    ],
    ["readMemory", {}, (o) => expect((o.memories as Json[]).length).toBe(1)],
    ["readGoal", {}, (o) => expect(o).toEqual({ project_id: P, current: null, revisions: [] })],
    [
      "proposeGoal",
      { content: " Hear everyone " },
      (o) =>
        expect(o).toEqual({
          type: "goal_proposal",
          content: "Hear everyone",
          project_id: P,
          visible_to_user: true,
        }),
    ],
    [
      "listMethodologies",
      {},
      (o) => expect(o).toEqual({ methodologies: [{ id: "m1", name: "dembrane" }] }),
    ],
    ["listCanvases", {}, (o) => expect((o.canvases as Json[]).length).toBe(2)],
    [
      "readCanvasHistory",
      { canvas: "the wall" },
      (o) =>
        expect(o).toEqual({
          canvas_id: "cv1",
          canvas_name: "The wall",
          history: [{ kind: "edit" }],
        }),
    ],
    [
      "editCanvas",
      { canvas: "cv1", instruction: "drop footer" },
      (o) =>
        expect(o).toMatchObject({
          canvas_id: "cv1",
          latest_html: "<p>x</p>",
          requires_edited_html: true,
        }),
    ],
    [
      "editCanvas",
      { canvas: "cv1", instruction: "drop footer", edited_html: "<p>y</p>" },
      (o) =>
        expect(o).toEqual({
          canvas_id: "cv1",
          canvas_name: "The wall",
          status: "edited",
          generation_id: "g2",
        }),
    ],
    [
      "addToCanvas",
      { canvas: "wall", text: "Pin me" },
      (o) =>
        expect(o).toEqual({
          canvas_id: "cv1",
          canvas_name: "The wall",
          status: "added",
          host_item: { id: "h1" },
        }),
    ],
    [
      "removeFromCanvas",
      { canvas: "cv1", item: "h1" },
      (o) =>
        expect(o).toEqual({
          canvas_id: "cv1",
          canvas_name: "The wall",
          status: "removed",
          item: { id: "h1" },
        }),
    ],
    [
      "pauseCanvasLoop",
      { canvas_id: "cv1" },
      (o) => expect(o).toMatchObject({ canvas_id: "cv1", loop: { status: "paused" } }),
    ],
    ["resumeCanvasLoop", { canvas_id: "cv1" }, (o) => expect(o.canvas_name).toBe("The wall")],
    ["stopCanvasLoop", { canvas_id: "cv1" }, (o) => expect(o.canvas_id).toBe("cv1")],
    [
      "remember",
      { content: "Likes tables" },
      (o) =>
        expect(o).toEqual({
          kind: "memory_saved",
          scope: "project",
          memory_key: "",
          action: "created",
          id: "mem2",
          visible_to_user: true,
        }),
    ],
    [
      "amendMemory",
      { memory_id: "mem1", content: "x" },
      (o) =>
        expect(o).toEqual({
          kind: "memory_amended",
          id: "mem1",
          scope: "project",
          action: "amended",
          visible_to_user: true,
        }),
    ],
    [
      "forgetMemory",
      { memory_id: "mem1", reason: "asked" },
      (o) =>
        expect(o).toEqual({
          kind: "memory_forgotten",
          id: "mem1",
          reason: "asked",
          forgotten: true,
          visible_to_user: true,
        }),
    ],
  ];

  test("every tool has a case", () => {
    expect(new Set(cases.map(([n]) => n)).size).toBe(46);
  });

  for (const [name, args, check] of cases) {
    test(`${name} ${JSON.stringify(args)}`, async () => {
      const { events } = await runStep({ model: model(turn(call("a", name, args))) });
      const end = outputOf(events, name);
      expect(events.find((e) => e.type === "tool-error")).toBeUndefined();
      check((typeof end === "string" ? { text: end } : end) as Json);
    });
  }

  test("a path that leaves the knowledge root is refused", async () => {
    const { events } = await runStep({
      model: model(turn(call("a", "readSkill", { path: "../../../etc/passwd" }))),
    });
    const err = events.find((e) => e.type === "tool-error") as { error: string } | undefined;
    expect(err?.error).toContain("escapes the knowledge root");
  });

  test("a failed support request is reported honestly, never as sent", async () => {
    const calls: Calls = [];
    const { events } = await runStep(
      { model: model(turn(call("a", "reachOutToDembraneSupport", { message: "x" }))) },
      fakeData(calls, { supportRequest: new Error("down") }),
    );
    expect(outputOf(events, "reachOutToDembraneSupport")).toMatchObject({ sent: false });
  });

  test("keyword searches stop after three empty results in a turn", async () => {
    const calls: Calls = [];
    const data = fakeData(calls, { conversations: { conversations: [] } });
    const msgs: ModelMessage[] = [{ role: "user", content: "find" }];
    let last: unknown;
    for (const [i, k] of ["alpha beta", "gamma delta", "epsilon zeta"].entries()) {
      const r = await runStep(
        {
          model: model(turn(call(`k${i}`, "findConversationsByKeywords", { keywords: k }))),
          messages: msgs,
          stepIndex: i,
        },
        data,
      );
      msgs.push(...r.result.responseMessages);
      last = outputOf(r.events, "findConversationsByKeywords");
    }
    expect((last as Json).guardrail).toMatchObject({
      code: "NO_MATCHES_AFTER_RETRIES",
      attempts: 3,
      stop_search: true,
    });
  });
});

describe("knowledge", () => {
  test("a catastrophic pattern is searched as literal text", () => {
    const re = safePattern("(a+)+$");
    expect(re.source).toBe("\\(a\\+\\)\\+\\$");
    expect(safePattern("portal link").source).toBe("portal link");
    expect(safePattern("[unclosed").source).toBe("\\[unclosed");
  });
});
