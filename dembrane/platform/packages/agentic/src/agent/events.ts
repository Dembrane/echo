/**
 * The run event payloads the dashboard reads, in the shape the LangGraph agent streamed and
 * the Python worker stored: LangChain `astream_events` records with serialised messages.
 * The dashboard (AgenticChatPanel, agenticToolActivity) parses `data.input`,
 * `data.output.kwargs.content` (a JSON string for dict results), `name` and `run_id`; UI
 * cards read the tool result keys. Only the events something reads are stored:
 * on_chat_model_end (the worker's text and tool-call bookkeeping), on_tool_start,
 * on_tool_end and on_tool_error. The LangGraph noise (on_chain_*, on_chat_model_start,
 * on_copilotkit_state_sync), each of which carried the whole message history, is not.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

const lc = (kind: string, kwargs: Record<string, unknown>) => ({
  lc: 1,
  type: "constructor",
  id: ["langchain", "schema", "messages", kind],
  kwargs,
});

/** Python's json.dumps with default separators and ensure_ascii=False, as LangChain wrote tool results. */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : value < 0 ? "-Infinity" : "NaN";
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((v) => pyJson(v)).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`);
    return `{${parts.join(", ")}}`;
  }
  return JSON.stringify(String(value));
}

/** A tool result as LangChain's ToolMessage content: strings verbatim, everything else JSON. */
export function toolContent(output: unknown): string {
  return typeof output === "string" ? output : pyJson(output);
}

const meta = (threadId: string) => ({ thread_id: threadId });

/** The end of one model call: its text and the tool calls it asked for. */
export function chatModelEnd(o: {
  runId: string;
  threadId: string;
  content: string;
  toolCalls: readonly ToolCall[];
  model: string;
  usage?: { input: number; output: number } | undefined;
}) {
  return {
    event: "on_chat_model_end",
    data: {
      output: lc("AIMessage", {
        content: o.content,
        additional_kwargs: {},
        response_metadata: { model_provider: "google_vertexai", model_name: o.model },
        type: "ai",
        id: `lc_run--${o.runId}`,
        tool_calls: o.toolCalls.map((c) => ({
          name: c.name,
          args: c.args,
          id: c.id,
          type: "tool_call",
        })),
        ...(o.usage && {
          usage_metadata: {
            input_tokens: o.usage.input,
            output_tokens: o.usage.output,
            total_tokens: o.usage.input + o.usage.output,
          },
        }),
        invalid_tool_calls: [],
      }),
    },
    run_id: o.runId,
    name: "ChatVertexAI",
    tags: [],
    metadata: meta(o.threadId),
    parent_ids: [],
  };
}

export function toolStart(o: {
  runId: string;
  threadId: string;
  name: string;
  input: Record<string, unknown>;
}) {
  return {
    event: "on_tool_start",
    data: { input: o.input },
    name: o.name,
    tags: [],
    run_id: o.runId,
    metadata: meta(o.threadId),
    parent_ids: [],
  };
}

export function toolEnd(o: {
  runId: string;
  threadId: string;
  name: string;
  input: Record<string, unknown>;
  toolCallId: string;
  output: unknown;
  messageId: string;
  status?: "success" | "error";
}) {
  return {
    event: "on_tool_end",
    data: {
      output: lc("ToolMessage", {
        content: toolContent(o.output),
        type: "tool",
        name: o.name,
        id: o.messageId,
        tool_call_id: o.toolCallId,
        status: o.status ?? "success",
      }),
      input: o.input,
    },
    run_id: o.runId,
    name: o.name,
    tags: [],
    metadata: meta(o.threadId),
    parent_ids: [],
  };
}

export function toolError(o: {
  runId: string;
  threadId: string;
  name: string;
  input: Record<string, unknown>;
  error: string;
}) {
  return {
    event: "on_tool_error",
    data: { error: o.error, input: o.input },
    run_id: o.runId,
    name: o.name,
    tags: [],
    metadata: meta(o.threadId),
    parent_ids: [],
  };
}
