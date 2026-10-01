import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createModels } from "@dembrane/llm";
import { jsonSchema, type ModelMessage, streamText } from "ai";
import { createAgent } from "../src/agent/agent";
import type { AgentData, TurnContext } from "../src/agent/data";
import type { StepEvent } from "../src/agent/types";

/**
 * Live replay through Vertex's EU residency endpoint (aiplatform.eu.rep.googleapis.com).
 * Runs only with credentials: `set -a; . legacy/parity/.env.parity; set +a; bun test
 * packages/agentic/test/agent.gemini.test.ts`. It proves the history a durable turn
 * replays is accepted: tool calls with their thought signatures after a JSON round trip
 * (the checkpoint), tool-call turns with no text, and earlier turns as text.
 */
const live = process.env.GOOGLE_APPLICATION_CREDENTIALS ? describe : describe.skip;
const vertexModel = (process.env.LLM__MULTI_MODAL_PRO__MODEL ?? "gemini-3.8-flash").replace(
  /^vertex_ai\//,
  "",
);

function buildModel(): LanguageModelV4 {
  const models = createModels({
    vertexProject: process.env.LLM__MULTI_MODAL_PRO__VERTEX_PROJECT ?? "dembrane-sameer-cli",
    vertexLocation: process.env.LLM__MULTI_MODAL_PRO__VERTEX_LOCATION ?? "eu",
    groups: {
      text_fast: [vertexModel],
      multi_modal_fast: [vertexModel],
      multi_modal_pro: [vertexModel],
    },
    embeddingModel: "text-embedding-004",
    embeddingLocation: "europe-west4",
    embeddingDimensions: 768,
  });
  return models.model("multi_modal_pro");
}

const P = "f0000000-0000-4000-8000-000000000001";
const ctx: TurnContext = {
  projectId: P,
  threadId: "22222222-2222-4222-8222-222222222222",
  chatId: null,
  appUserId: null,
  messageId: "1",
  canvasEnabled: false,
  docsBaseUrl: "",
  portalUrl: "http://localhost:5174",
};

const conversation = (id: string, name: string, summary: string) => ({
  conversation_id: id,
  participant_name: name,
  status: "done",
  summary,
  started_at: "2026-09-01T09:00:00.000Z",
  last_chunk_at: "2026-09-01T09:30:00.000Z",
});

const data: AgentData = new Proxy({} as AgentData, {
  get: (_t, method: string) => async () => {
    switch (method) {
      case "memory":
        return { project_id: P, count: 0, memories: [] };
      case "reports":
        return [{ id: 3, status: "published", user_instructions: "Focus on transport" }];
      case "projectGoal":
        return {
          project_id: P,
          current: { content: "Understand how residents get to work" },
          revisions: [],
        };
      case "conversations":
        return {
          project_id: P,
          count: 2,
          offset: 0,
          has_more: false,
          conversations: [
            conversation("c1", "Alice", "Alice takes the bus and finds it late every morning."),
            conversation("c2", "Bram", "Bram cycles and wants safer crossings."),
          ],
        };
      case "transcript":
        return "Alice: The number 8 bus is always ten minutes late.";
      default:
        return {};
    }
  },
});

async function runTurn(messages: ModelMessage[], model: LanguageModelV4, turnId: string) {
  const agent = createAgent();
  const events: StepEvent[] = [];
  let history = messages;
  for (let step = 0; step < 8; step++) {
    const r = await agent.step(
      {
        ctx: { ...ctx, messageId: turnId },
        data,
        model,
        messages: history,
        stepIndex: step,
        signal: AbortSignal.timeout(120_000),
      },
      async (e) => {
        events.push(e);
      },
    );
    // The workflow checkpoints each step as JSON; replay the round-tripped copy.
    history = JSON.parse(JSON.stringify([...history, ...r.responseMessages]));
    if (r.done) break;
  }
  const ends = events.filter((e) => e.type === "model-end") as Extract<
    StepEvent,
    { type: "model-end" }
  >[];
  return { history, events, answer: ends.at(-1)?.content ?? "" };
}

live("Gemini replay on Vertex EU", () => {
  setDefaultTimeout(300_000);

  test("multi-turn conversation with tool calls replays without a 400", async () => {
    const model = buildModel();
    const first = await runTurn(
      [
        {
          role: "user",
          content:
            "Project Name: Commute\nUser Message: Read the project goal and list the reports, then answer in one short sentence what the project is about.",
        },
      ],
      model,
      "1",
    );
    const toolEnds = first.events
      .filter((e) => e.type === "tool-end")
      .map((e) => ("name" in e ? e.name : ""));
    expect(toolEnds.length).toBeGreaterThan(0);
    expect(first.answer.length).toBeGreaterThan(10);

    // Tool calls replayed in later steps carried Gemini's thought signature.
    const signed = first.history.some(
      (m) =>
        m.role === "assistant" &&
        typeof m.content !== "string" &&
        m.content.some(
          (p) =>
            p.type === "tool-call" &&
            JSON.stringify(p.providerOptions ?? {}).includes("thoughtSignature"),
        ),
    );
    expect(signed).toBe(true);

    // The next turn replays the first as text, as the worker rebuilds history, then works again.
    const second = await runTurn(
      [
        first.history[0] as ModelMessage,
        { role: "assistant", content: first.answer },
        {
          role: "user",
          content:
            "User Message: Which participant talks about the bus? Look at the conversations and quote them.",
        },
      ],
      model,
      "2",
    );
    expect(second.events.some((e) => e.type === "tool-end")).toBe(true);
    expect(second.answer).toMatch(/Alice/);
  });

  test("a tool-call turn with no text and an unsigned call replay without a placeholder", async () => {
    // History a crash could leave: a text-free tool-call turn whose signature was lost,
    // naming a tool that is not declared in this request. Gemini 3 accepts it: the SDK
    // injects the documented skip-signature sentinel, and undeclared names in history
    // are not validated against the declarations.
    const result = streamText({
      model: buildModel(),
      maxRetries: 0,
      system: "You are a helpful assistant.",
      tools: {
        listReports: {
          description: "List reports.",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
        },
      },
      messages: [
        { role: "user", content: "What reports exist?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "a",
              toolName: "findConvosByKeywords",
              input: { keywords: "bus" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "a",
              toolName: "findConvosByKeywords",
              output: { type: "text", value: '{"count": 0, "conversations": []}' },
            },
          ],
        },
      ],
    });
    let text = "";
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error;
      if (part.type === "text-delta") text += part.text;
    }
    const calls = await result.toolCalls;
    expect(text.length + calls.length).toBeGreaterThan(0);
  });
});
