/**
 * What may reach the host from the model's own text, and the host-facing messages the turn
 * writes itself. Everything here is pure so the rules are tested directly.
 */

export const AGENT_CANCELLED_ERROR_CODE = "AGENT_CANCELLED";
export const AGENT_CANCELLED_MESSAGE = "Run cancelled by user";

// A backstop, not a budget: the agent's repetition guard ends runaway calls itself, so a
// long legitimate turn finishes and only a runaway one reaches this.
export const MAX_TOOL_CALLS_PER_TURN = 150;
export const MAX_TOOL_CALLS_PER_RUN = MAX_TOOL_CALLS_PER_TURN * 10;

// ack posts a message the host reads; updatePlan only ticks plan steps.
export const PROGRESS_TOOL_NAMES: ReadonlySet<string> = new Set(["sendProgressUpdate", "ack"]);
export const PLAN_TOOL_NAME = "updatePlan";
export const TOOL_LIMIT_EXEMPT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PROGRESS_TOOL_NAMES,
  PLAN_TOOL_NAME,
]);

// Host-facing, in the agent's own voice: "tool calls" never leak into what the host reads.
export const TOOL_LIMIT_SAFETY_MESSAGE =
  "I need to pause this pass on your request. Send it again and I'll retry with a fresh pass.";
export const RUN_TOOL_LIMIT_SAFETY_MESSAGE =
  "This chat has accumulated too much work in one live session. Please start a new chat " +
  "for the next request.";

export const AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL = 4;
const AUTOMATIC_NUDGE_TEMPLATE = (n: number) =>
  `<Automatic Nudge> You have made ${n} tool calls without sending an assistant update. ` +
  "Call `ack` now with a concise update, then continue research with " +
  "another tool call if evidence is still missing. Only return plain text with no tool call if you " +
  "are concluding.";

export const HISTORY_PAGE_SIZE = 500;
export const OVERFLOW_RETRY_WINDOW_SIZE = 24;

// Full-text snapshots grow quadratically with message length, so drafts are throttled
// harder as the text grows; the model's end always flushes the final snapshot.
export function draftPublishIntervalMs(textLength: number): number {
  if (textLength >= 8_000) return 1_000;
  if (textLength >= 2_000) return 500;
  return 150;
}

// Model-input placeholder for Gemini's empty tool-call turns; never host-visible.
export const INTERNAL_PLACEHOLDER_CONTENTS: ReadonlySet<string> = new Set(["(calling tools)"]);

const TRAILING_CURSOR_ARTIFACT = /([.!?…。！？]["')\]}»”’]*)(?:[_▁▂▃▔|¦]+)$/u;
const LEADING_STRAY_TOKEN_CLUSTER =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stray control tokens are what it removes
  /^[\s﻿\u0000-\u001f一-鿿㐀-䶿]+(?=\s*[([]?[A-Za-z])/u;
const SUCCESSFULLY_AT_START = /^successfully\s+/i;
const SUCCESSFULLY = /\bsuccessfully\s+/gi;
const PARENTHETICAL_PLANNING =
  /^\(\s*(?:i(?:'m| am| will|'ll)|we(?:'re| are| will|'ll)|checking|reading|searching|looking)\b.*\)\s*$/is;
const STATUS_NARRATION_SPLIT = /(?<=[.!?])\s+|\n+/;
const STATUS_NARRATION_SENTENCE = new RegExp(
  "^\\s*(?:" +
    "i\\s*(?:am|'m)\\s+(?:looking|checking|reviewing|reading|searching)\\b.*" +
    "|let\\s+me\\s+(?:look|check|review|read|search)\\b.*" +
    // Bare gerund openers count as narration only without a comma clause: "Looking at
    // your transcripts, three themes stand out." is an answer and must survive.
    "|(?:checking|reviewing|reading|searching|looking)\\b[^,]*" +
    "|to\\s+help\\s+you\\b.*\\bi\\s*(?:will|'ll)\\s+" +
    "(?:start|begin|first|now|help|guide|look|check|review|read|search)\\b.*" +
    ")\\s*$",
  "is",
);
const OPTION_LINE = /^\s*(?:[-*]|\d+[.)])\s+\S+/m;

export function isPureStatusNarration(content: string): boolean {
  if (content.includes("?") || OPTION_LINE.test(content)) return false;
  const sentences = content
    .split(STATUS_NARRATION_SPLIT)
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  if (!sentences.length) return false;
  return sentences.every((s) => STATUS_NARRATION_SENTENCE.test(s));
}

/**
 * Normalises assistant text before a host sees it. Pure status narration ("I'm looking
 * into X") is dropped from free text, where it is filler; an ack is status by design, so
 * its caller keeps it. Null means nothing worth showing.
 */
export function sanitizeHostVisible(
  content: string,
  opts: { keepStatusNarration?: boolean } = {},
): string | null {
  let normalized = content.trim();
  if (!normalized || INTERNAL_PLACEHOLDER_CONTENTS.has(normalized)) return null;
  normalized = normalized.replace(LEADING_STRAY_TOKEN_CLUSTER, "").trim();
  const removedSuccessfully = SUCCESSFULLY_AT_START.test(normalized);
  normalized = normalized.replace(SUCCESSFULLY, "").trim();
  if (removedSuccessfully && normalized)
    normalized = (normalized[0] ?? "").toUpperCase() + normalized.slice(1);
  if (PARENTHETICAL_PLANNING.test(normalized)) return null;
  if (!opts.keepStatusNarration && isPureStatusNarration(normalized)) return null;
  let previous: string | null = null;
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized.replace(TRAILING_CURSOR_ARTIFACT, "$1").trim();
  }
  return normalized || null;
}

/** The host's own message condensed for quoting back; never the assembled prompt. */
export function summarizeRequest(userMessage: string | null | undefined): string {
  if (!userMessage) return "";
  const normalized = userMessage.split(/\s+/).filter(Boolean).join(" ");
  const cps = [...normalized];
  if (cps.length > 140) return `${cps.slice(0, 137).join("").trimEnd()}...`;
  return normalized;
}

export function turnToolLimitMessage(hostMessage: string | null | undefined): string {
  const summary = summarizeRequest(hostMessage);
  if (!summary) return TOOL_LIMIT_SAFETY_MESSAGE;
  return (
    `I need to pause this pass on your request: "${summary}". ` +
    "Send it again and I'll retry with a fresh pass."
  );
}

export function automaticNudgeContent(toolCallsWithoutAssistantMessage: number): string {
  const milestone =
    Math.floor(toolCallsWithoutAssistantMessage / AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL) *
    AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL;
  return AUTOMATIC_NUDGE_TEMPLATE(milestone);
}

/**
 * Host-visible failure payload: the error code, never upstream text, which can carry
 * provider internals or echo the prompt (transcript context). The wording lives in the
 * frontend, keyed by the code, so it is localised.
 */
export function runFailurePayload(errorCode: string, statusCode?: number) {
  return statusCode === undefined
    ? { error_code: errorCode }
    : { error_code: errorCode, status_code: statusCode };
}

type Obj = Record<string, unknown>;

export function payloadToDict(payload: unknown): Obj {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Obj;
  if (typeof payload === "string") {
    try {
      const v = JSON.parse(payload);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Obj;
    } catch {}
  }
  return {};
}

export function nonEmptyText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * The host-visible text of a progress tool's result (ack, sendProgressUpdate), or null
 * when the tool said it is not for the host. Next steps become their own paragraph with no
 * English label, since the agent writes in the host's language.
 */
export function progressMessageFromToolOutput(toolName: string, output: unknown): string | null {
  if (!PROGRESS_TOOL_NAMES.has(toolName)) return null;
  const candidates: Obj[] = [];
  const direct = payloadToDict(output);
  if (Object.keys(direct).length) {
    candidates.push(direct);
    for (const k of ["output", "content"]) {
      const nested = payloadToDict(direct[k]);
      if (Object.keys(nested).length) candidates.push(nested);
    }
    const kwargs = payloadToDict(direct.kwargs);
    if (Object.keys(kwargs).length) {
      candidates.push(kwargs);
      const kc = payloadToDict(kwargs.content);
      if (Object.keys(kc).length) candidates.push(kc);
    }
  }
  if (!candidates.length) return null;
  const chosen =
    candidates.find((c) => c.kind === "progress_update" || nonEmptyText(c.update) !== null) ??
    (candidates[0] as Obj);
  if (chosen.visible_to_user === false) return null;
  const update = nonEmptyText(chosen.update);
  if (update === null) return null;
  const next = nonEmptyText(chosen.next_steps);
  return next === null ? update : `${update}\n\n${next}`;
}
