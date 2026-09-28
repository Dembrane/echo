import type { ModelMessage } from "ai";
import {
  AUTOMATIC_NUDGE_TEMPLATE,
  IDENTICAL_RESULTS_NOTE,
  REPEATED_CALL_MESSAGE,
  REPEATED_CALL_STOP_MESSAGE,
} from "./text";

/**
 * Per-turn bookkeeping of the loop guard, derived from the turn's messages instead of
 * kept in memory: a step replayed after a worker crash sees exactly the messages the
 * crashed attempt saw, so it makes the same decisions.
 */

/** Tools that report to the host; never repeats, and their calls reset the silent-work count. */
export const HOST_UPDATE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "sendProgressUpdate",
  "ack",
  "updatePlan",
]);
export const IDENTICAL_RESULTS_BEFORE_NOTE = 3;
export const REPEAT_CALLS_BEFORE_STOP = 3;
export const AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL = 6;

export interface CallRecord {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

/** Keys objects in sorted order at every depth, as json.dumps(sort_keys=True) did. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export const callKey = (name: string, args: unknown) =>
  new Bun.CryptoHasher("sha256").update(`${name}\u0000${canonical(args)}`).digest("hex");
export const resultDigest = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

export const identicalResultsNote = () =>
  IDENTICAL_RESULTS_NOTE.replace("{count}", String(IDENTICAL_RESULTS_BEFORE_NOTE));

type Part = { type: string; [k: string]: unknown };
const partsOf = (m: ModelMessage): Part[] =>
  typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Part[]);

export const messageText = (m: ModelMessage): string =>
  partsOf(m)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => (p.text as string).trim())
    .filter(Boolean)
    .join("\n")
    .trim();

export const toolCallsOf = (m: ModelMessage): CallRecord[] =>
  m.role !== "assistant"
    ? []
    : partsOf(m)
        .filter((p) => p.type === "tool-call")
        .map((p) => ({ id: String(p.toolCallId), name: String(p.toolName), args: p.input }));

/** The text the model saw for each tool result, by call id. */
function resultTexts(messages: readonly ModelMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const p of partsOf(m)) {
      if (p.type !== "tool-result") continue;
      const o = p.output as { type?: string; value?: unknown } | undefined;
      const text =
        o?.type === "text"
          ? String(o.value)
          : o?.value === undefined
            ? ""
            : JSON.stringify(o.value);
      out.set(String(p.toolCallId), text);
    }
  }
  return out;
}

/** Index of the first message of the current turn: the one after the last user message. */
export function turnStart(messages: readonly ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return i + 1;
  return 0;
}

export interface GuardState {
  readonly seenKeys: Set<string>;
  skippedRepeats: number;
  readonly recentDigests: string[];
}

export const isSkippedRepeat = (text: string) =>
  text === REPEATED_CALL_MESSAGE || text === REPEATED_CALL_STOP_MESSAGE;

export function guardState(messages: readonly ModelMessage[]): GuardState {
  const turn = messages.slice(turnStart(messages));
  const results = resultTexts(turn);
  const state: GuardState = { seenKeys: new Set(), skippedRepeats: 0, recentDigests: [] };
  const note = identicalResultsNote();
  for (const m of turn) {
    for (const call of toolCallsOf(m)) {
      if (HOST_UPDATE_TOOL_NAMES.has(call.name)) continue;
      state.seenKeys.add(callKey(call.name, call.args));
      const text = results.get(call.id);
      if (text === undefined) continue;
      if (isSkippedRepeat(text)) state.skippedRepeats++;
      else
        state.recentDigests.push(
          resultDigest(text.endsWith(note) ? text.slice(0, -note.length) : text),
        );
    }
  }
  return state;
}

/** Tool calls since the host last saw anything (text, or a progress or plan call). */
export function toolCallsSinceUpdate(messages: readonly ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const calls = toolCallsOf(m);
    if (calls.length) {
      if (messageText(m)) n = 0;
      if (calls.some((c) => HOST_UPDATE_TOOL_NAMES.has(c.name))) {
        n = 0;
        continue;
      }
      n += calls.length;
      continue;
    }
    if (messageText(m)) n = 0;
  }
  return n;
}

/**
 * The automatic nudge for the model call about to happen, or null. Each multiple of the
 * interval fires once per stretch of silent work; the fired set is rebuilt by replaying
 * the decision at every earlier model call of the turn.
 */
export function automaticNudge(
  messages: readonly ModelMessage[],
): { note: string; milestone: number } | null {
  const start = turnStart(messages);
  const fired = new Set<number>();
  let last = 0;
  let current: { note: string; milestone: number } | null = null;
  const decide = (prefix: readonly ModelMessage[]) => {
    const n = toolCallsSinceUpdate(prefix);
    if (n < last || n === 0) fired.clear();
    last = n;
    if (n < AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL) return null;
    const milestone =
      Math.floor(n / AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL) * AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL;
    if (fired.has(milestone)) return null;
    fired.add(milestone);
    return {
      note: AUTOMATIC_NUDGE_TEMPLATE.replace("{tool_call_count}", String(milestone)),
      milestone,
    };
  };
  for (let i = start; i < messages.length; i++)
    if (messages[i]?.role === "assistant") decide(messages.slice(0, i));
  current = decide(messages);
  return current;
}
