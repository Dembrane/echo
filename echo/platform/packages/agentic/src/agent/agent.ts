import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  type AssistantModelMessage,
  jsonSchema,
  type ModelMessage,
  streamText,
  type Tool,
  type ToolModelMessage,
} from "ai";
import { z } from "zod";
import type { AgentData, Json, TurnContext } from "./data";
import { toolContent } from "./events";
import {
  automaticNudge,
  callKey,
  guardState,
  HOST_UPDATE_TOOL_NAMES,
  IDENTICAL_RESULTS_BEFORE_NOTE,
  identicalResultsNote,
  messageText,
  REPEAT_CALLS_BEFORE_STOP,
  resultDigest,
  toolCallsOf,
  turnStart,
} from "./guard";
import { createKnowledge, type Knowledge } from "./knowledge";
import {
  formatCanvasActivitySection,
  formatMemorySection,
  MAX_CANVAS_ACTIVITY_RUNS,
  systemPromptFor,
  withRuntimeNote,
} from "./prompt";
import {
  POST_NUDGE_CONTINUATION_SYSTEM_PROMPT,
  REPEATED_CALL_MESSAGE,
  REPEATED_CALL_STOP_MESSAGE,
} from "./text";
import {
  keywordCacheKey,
  normalizeKeywordArgs,
  TOOL_NAME_RENAMES,
  type ToolDef,
  type ToolEnv,
  type TurnMemory,
  toolsFor,
} from "./tools";
import type { Agent, StepEvent, StepInput, StepResult } from "./types";

export interface AgentOptions {
  readonly now?: () => Date;
  readonly logger?: { warn(obj: unknown, msg?: string): void };
}

/**
 * A stable uuid for a name, so a step replayed after a crash reuses its message ids
 * (the streamed draft id is also the chat message row id).
 */
export function stableUuid(name: string): string {
  const h = new Bun.CryptoHasher("sha256").update(name).digest("hex");
  const variant = ((Number.parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const stepMessageId = (ctx: TurnContext, stepIndex: number) =>
  stableUuid(`agentic:${ctx.threadId}:${ctx.messageId ?? ""}:${stepIndex}`);

const toolErrorText = (err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  const cls = e.name && e.name !== "Error" ? e.name : e.constructor?.name || "Error";
  return (
    `Tool error: ${cls}: ${e.message}. ` +
    "Continue with available evidence, avoid repeating failing calls, and summarize constraints."
  );
};

class ValidationError extends Error {
  override readonly name = "ValidationError";
}

/** Splits a tool name Gemini fused from several (listDocsreadDoc) into registered names. */
export function splitFusedName(name: string, names: ReadonlySet<string>): string[] | null {
  if (names.has(name)) return null;
  const candidates = [...names].sort((a, b) => b.length - a.length);
  const memo = new Map<number, string[] | null>();
  const match = (i: number): string[] | null => {
    if (i === name.length) return [];
    if (memo.has(i)) return memo.get(i) ?? null;
    for (const c of candidates) {
      if (!name.startsWith(c, i)) continue;
      const rest = match(i + c.length);
      if (rest) {
        memo.set(i, [c, ...rest]);
        return [c, ...rest];
      }
    }
    memo.set(i, null);
    return null;
  };
  const parts = match(0);
  return parts && parts.length > 1 ? parts : null;
}

/** Arguments of a fused call: concatenated JSON objects, or an array of them. */
function splitArgs(args: unknown, count: number): unknown[] | null {
  if (Array.isArray(args)) return args.length === count ? args : null;
  if (typeof args !== "string") return null;
  const values: unknown[] = [];
  let i = 0;
  while (i < args.length) {
    while (i < args.length && /\s/.test(args[i] as string)) i++;
    if (i >= args.length) break;
    let depth = 0;
    let inStr = false;
    let j = i;
    for (; j < args.length; j++) {
      const ch = args[j];
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    try {
      values.push(JSON.parse(args.slice(i, j + 1)));
    } catch {
      return null;
    }
    i = j + 1;
  }
  return values.length === count ? values : null;
}

type Part = { type: string; [k: string]: unknown };

/**
 * Rewrites the model's tool calls to registered tools: fused names split into their
 * parts (the thought signature stays on the first), old names renamed. Unsplittable
 * fused calls are dropped, as before. The rewritten message is what history replays, so
 * Vertex never sees a function name it does not declare.
 */
function normalizeToolCalls(
  message: AssistantModelMessage,
  names: ReadonlySet<string>,
  rawInputs: ReadonlyMap<string, unknown>,
): AssistantModelMessage {
  if (typeof message.content === "string") return message;
  const out: Part[] = [];
  for (const part of message.content as Part[]) {
    if (part.type !== "tool-call") {
      out.push(part);
      continue;
    }
    const name = String(part.toolName);
    const split = splitFusedName(name, names);
    if (!split) {
      const renamed = TOOL_NAME_RENAMES[name];
      out.push(renamed ? { ...part, toolName: renamed } : part);
      continue;
    }
    // The SDK replaces input it cannot parse with {}; the fused arguments are in the raw text.
    const args = splitArgs(rawInputs.get(String(part.toolCallId)) ?? part.input, split.length);
    if (!args) continue;
    split.forEach((n, i) => {
      const piece: Part = {
        ...part,
        toolCallId: `${String(part.toolCallId)}-${i}`,
        toolName: TOOL_NAME_RENAMES[n] ?? n,
        input: args[i] && typeof args[i] === "object" && !Array.isArray(args[i]) ? args[i] : {},
      };
      if (i > 0) delete piece.providerOptions;
      out.push(piece);
    });
  }
  return { ...message, content: out as AssistantModelMessage["content"] };
}

/** A turn with no text and no tool calls: Vertex rejects replaying it (zero parts). */
const isEmptyAssistantTurn = (m: ModelMessage) =>
  m.role === "assistant" && !toolCallsOf(m).length && !messageText(m);

/** Rebuilds the keyword search cache of the turn from its earlier findConversationsByKeywords results. */
function turnMemory(messages: readonly ModelMessage[]): TurnMemory {
  const memory: TurnMemory = {
    keywordCache: new Map(),
    consecutiveEmptyKeywordSearches: 0,
    conversations: new Map(),
  };
  const turn = messages.slice(turnStart(messages));
  const results = new Map<string, string>();
  for (const m of turn)
    if (m.role === "tool")
      for (const p of m.content as Part[])
        if (p.type === "tool-result") {
          const o = p.output as { type?: string; value?: unknown };
          if (o?.type === "text") results.set(String(p.toolCallId), String(o.value));
        }
  for (const m of turn)
    for (const call of toolCallsOf(m)) {
      if (call.name !== "findConversationsByKeywords") continue;
      const text = results.get(call.id);
      if (!text) continue;
      let parsed: Json;
      try {
        parsed = JSON.parse(text.split("\n\n(Note:")[0] as string);
      } catch {
        continue;
      }
      if (parsed.cached) continue;
      const guard = parsed.guardrail as { code?: string } | undefined;
      if (guard?.code === "LOW_SIGNAL_QUERY") continue;
      const { keywords, limit } = normalizeKeywordArgs((call.args ?? {}) as Json);
      const conversations = Array.isArray(parsed.conversations) ? parsed.conversations : [];
      memory.keywordCache.set(keywordCacheKey(keywords, limit), {
        project_id: parsed.project_id,
        query: keywords,
        count: conversations.length,
        conversations,
      });
      if (conversations.length) memory.consecutiveEmptyKeywordSearches = 0;
      else memory.consecutiveEmptyKeywordSearches++;
    }
  return memory;
}

interface ModelCall {
  message: AssistantModelMessage | null;
  rawInputs: Map<string, unknown>;
  text: string;
  model: string;
  usage?: { input: number; output: number };
}

export function createAgent(opts: AgentOptions = {}): Agent {
  const knowledge: Knowledge = createKnowledge();
  const now = opts.now ?? (() => new Date());
  // Memory and canvas activity load once per turn; a replayed step reloads them.
  const sections = new Map<string, Promise<string>>();

  const ambient = (ctx: TurnContext, data: AgentData): Promise<string> => {
    const key = `${ctx.threadId}:${ctx.messageId ?? ""}`;
    let p = sections.get(key);
    if (!p) {
      p = (async () => {
        const memory = await data.memory().then(
          (m) => formatMemorySection(Array.isArray(m.memories) ? m.memories : []),
          (err) => {
            opts.logger?.warn({ err }, "ambient memory unavailable");
            return "";
          },
        );
        const canvas =
          ctx.canvasEnabled && ctx.chatId
            ? await data
                .canvasActivity(MAX_CANVAS_ACTIVITY_RUNS)
                .then(formatCanvasActivitySection, (err) => {
                  opts.logger?.warn({ err }, "canvas activity unavailable");
                  return "";
                })
            : "";
        return JSON.stringify([memory, canvas]);
      })();
      sections.set(key, p);
      if (sections.size > 200) sections.delete(sections.keys().next().value as string);
    }
    return p;
  };

  async function callModel(
    input: StepInput,
    tools: readonly ToolDef[],
    system: string,
    messages: ModelMessage[],
    messageId: string,
    emit: (e: StepEvent) => Promise<void>,
  ): Promise<ModelCall> {
    // Arguments are validated by the tool runner, not by the SDK: the model's raw input is
    // what the dashboard shows and what history replays.
    const toolSet: Record<string, Tool> = {};
    for (const t of tools)
      toolSet[t.name] = {
        description: t.description,
        inputSchema: jsonSchema(
          z.toJSONSchema(t.schema, { io: "input", target: "draft-7" }) as never,
        ),
      } as Tool;
    const result = streamText({
      model: input.model as LanguageModelV4,
      system,
      messages,
      tools: toolSet,
      maxRetries: 0,
      abortSignal: input.signal,
    });
    let text = "";
    const rawInputs = new Map<string, unknown>();
    for await (const part of result.fullStream) {
      if (part.type === "tool-call") rawInputs.set(part.toolCallId, part.input);
      else if (part.type === "text-delta") {
        text += part.text;
        if (part.text) await emit({ type: "text-delta", messageId, delta: part.text });
      } else if (part.type === "error") {
        throw part.error;
      }
    }
    const response = await result.response;
    const assistant = response.messages.find((m) => m.role === "assistant") as
      | AssistantModelMessage
      | undefined;
    const usage = await result.usage;
    return {
      message: assistant ?? null,
      rawInputs,
      text,
      model: response.modelId,
      ...(usage.inputTokens !== undefined && {
        usage: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 },
      }),
    };
  }

  return {
    async step(input, emit): Promise<StepResult> {
      const { ctx, data } = input;
      const tools = toolsFor(ctx.canvasEnabled);
      const names = new Set(tools.map((t) => t.name));
      const byName = new Map(tools.map((t) => [t.name, t]));
      const messageId = stepMessageId(ctx, input.stepIndex);

      const [memory, canvas] = JSON.parse(await ambient(ctx, data)) as [string, string];
      const base = [
        systemPromptFor(ctx.canvasEnabled) + knowledge.promptSection(ctx.docsBaseUrl),
        memory,
        canvas,
      ]
        .filter(Boolean)
        .join("\n\n");
      const raw = [...input.messages];
      const history = raw.filter((m) => !isEmptyAssistantTurn(m));

      const nudge = automaticNudge(raw);
      let call = await callModel(
        input,
        tools,
        nudge ? withRuntimeNote(base, nudge.note) : base,
        history,
        messageId,
        emit,
      );
      if (nudge && (!call.message || isEmptyAssistantTurn(call.message))) {
        // Only an empty reply is retried: a written answer is the answer. The retry does
        // not replay the empty turn, so the request still ends where the conversation does.
        call = await callModel(
          input,
          tools,
          withRuntimeNote(base, `${nudge.note}\n${POST_NUDGE_CONTINUATION_SYSTEM_PROMPT}`),
          history,
          messageId,
          emit,
        );
      }

      const assistant = call.message
        ? normalizeToolCalls(call.message, names, call.rawInputs)
        : null;
      const calls = assistant ? toolCallsOf(assistant) : [];
      await emit({
        type: "model-end",
        messageId,
        content: call.text,
        toolCalls: calls.map((c) => ({
          id: c.id,
          name: c.name,
          args: (c.args && typeof c.args === "object" ? c.args : {}) as Record<string, unknown>,
        })),
        model: call.model,
        ...(call.usage && { usage: call.usage }),
      });

      if (!assistant || isEmptyAssistantTurn(assistant))
        return { responseMessages: [], done: true };
      if (!calls.length) return { responseMessages: [assistant], done: true };

      // Repetition guard: an identical call already made this turn is answered with a note
      // instead of running again; after a few, the model is told to answer.
      const guard = guardState(raw);
      const plan = calls.map((c) => {
        if (HOST_UPDATE_TOOL_NAMES.has(c.name)) return { call: c, skip: null as string | null };
        const key = callKey(c.name, c.args);
        if (guard.seenKeys.has(key)) {
          guard.skippedRepeats++;
          return {
            call: c,
            skip:
              guard.skippedRepeats >= REPEAT_CALLS_BEFORE_STOP
                ? REPEATED_CALL_STOP_MESSAGE
                : REPEATED_CALL_MESSAGE,
          };
        }
        guard.seenKeys.add(key);
        return { call: c, skip: null as string | null };
      });

      const env: ToolEnv = { ctx, data, knowledge, now, turn: turnMemory(raw) };
      let queue = Promise.resolve();
      const emitInOrder = (e: StepEvent) => {
        queue = queue.then(() => emit(e));
        return queue;
      };
      const results = await Promise.all(
        plan.map(async ({ call: c, skip }): Promise<string> => {
          if (skip) return skip;
          const tool = byName.get(c.name);
          if (!tool)
            return `Error: ${c.name} is not a valid tool, try one of [${[...names].join(", ")}].`;
          const inputArgs = (c.args && typeof c.args === "object" ? c.args : {}) as Record<
            string,
            unknown
          >;
          const runId = stableUuid(`${messageId}:${c.id}:run`);
          await emitInOrder({
            type: "tool-start",
            runId,
            toolCallId: c.id,
            name: c.name,
            input: inputArgs,
          });
          try {
            const parsed = tool.schema.safeParse(c.args ?? {});
            if (!parsed.success)
              throw new ValidationError(
                parsed.error.issues
                  .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
                  .join("; "),
              );
            const output = await tool.run(parsed.data as Record<string, unknown>, env);
            await emitInOrder({
              type: "tool-end",
              runId,
              toolCallId: c.id,
              name: c.name,
              input: inputArgs,
              output,
            });
            return toolContent(output);
          } catch (err) {
            const text = toolErrorText(err);
            await emitInOrder({
              type: "tool-error",
              runId,
              toolCallId: c.id,
              name: c.name,
              input: inputArgs,
              error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            });
            return text;
          }
        }),
      );
      await queue;

      // The same result three lookups in a row is pointed out to the model.
      const note = identicalResultsNote();
      const texts = results.map((text, i) => {
        const { call: c, skip } = plan[i] as (typeof plan)[number];
        if (skip || HOST_UPDATE_TOOL_NAMES.has(c.name)) return text;
        guard.recentDigests.push(resultDigest(text));
        const window = guard.recentDigests.slice(-IDENTICAL_RESULTS_BEFORE_NOTE);
        return window.length === IDENTICAL_RESULTS_BEFORE_NOTE && new Set(window).size === 1
          ? text + note
          : text;
      });

      const toolMessage: ToolModelMessage = {
        role: "tool",
        content: calls.map((c, i) => ({
          type: "tool-result" as const,
          toolCallId: c.id,
          toolName: c.name,
          output: { type: "text" as const, value: texts[i] as string },
        })),
      };
      return { responseMessages: [assistant, toolMessage], done: false };
    },
  };
}
