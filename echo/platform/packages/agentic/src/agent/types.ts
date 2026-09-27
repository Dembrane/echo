import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import type { AgentData, TurnContext } from "./data";
import type { ToolCall } from "./events";

/**
 * The seam between the agent (prompt, tools, loop guard) and the turn workflow that runs
 * it durably. A turn is a sequence of steps; one step is one model call plus the tools it
 * called. The workflow checkpoints each step's result, so a crashed worker resumes at the
 * first unfinished step, and a step replayed after a crash sees the same messages.
 */
export interface StepInput {
  readonly ctx: TurnContext;
  readonly data: AgentData;
  readonly model: LanguageModelV4;
  /**
   * The conversation so far, without the system prompt: earlier turns as text, this
   * turn's user message, then the response messages of this turn's finished steps.
   */
  readonly messages: readonly ModelMessage[];
  /** Zero-based index of this step within the turn. */
  readonly stepIndex: number;
  readonly signal: AbortSignal;
}

/** What a step reports while it runs, in order; the workflow persists and streams them. */
export type StepEvent =
  /** Streamed text of the model call identified by messageId (the future assistant message id). */
  | { readonly type: "text-delta"; readonly messageId: string; readonly delta: string }
  /** The model call ended: its full text and the tool calls it made. */
  | {
      readonly type: "model-end";
      readonly messageId: string;
      readonly content: string;
      readonly toolCalls: readonly ToolCall[];
      readonly model: string;
      readonly usage?: { readonly input: number; readonly output: number };
    }
  /** A tool is about to run. Calls the repetition guard answers emit no events. */
  | {
      readonly type: "tool-start";
      readonly runId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: "tool-end";
      readonly runId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
      /** The tool's result as the model sees it (object, or a string for text tools). */
      readonly output: unknown;
    }
  | {
      readonly type: "tool-error";
      readonly runId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
      readonly error: string;
    };

export interface StepResult {
  /** Messages this step added (assistant turn, then tool results); JSON-serialisable. */
  readonly responseMessages: ModelMessage[];
  /** True when the model answered without calling a tool: the turn is over. */
  readonly done: boolean;
}

export interface Agent {
  /** Runs one step. `emit` is awaited, so events are stored in the order they happen. */
  step(input: StepInput, emit: (e: StepEvent) => Promise<void>): Promise<StepResult>;
}
