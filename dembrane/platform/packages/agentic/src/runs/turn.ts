import { APICallError } from "@ai-sdk/provider";
import type { Capture } from "@dembrane/analytics";
import type { Signed } from "@dembrane/http";
import type { Models } from "@dembrane/llm";
import type { Emit } from "@dembrane/notifications";
import type { Logger } from "@dembrane/observability";
import type { ModelMessage } from "ai";
import type { AgentData, TurnContext } from "../agent/data";
import { chatModelEnd, toolEnd, toolError, toolStart } from "../agent/events";
import type { Agent, StepEvent } from "../agent/types";
import { canvasEnabled, distinctIdFor, principalFor } from "./context";
import { buildMessageHistory, type TextTurn, turnMessages } from "./history";
import { stableUuid } from "./ids";
import { publishDraft, publishEvent, watchers } from "./live";
import {
  AGENT_CANCELLED_ERROR_CODE,
  AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL,
  automaticNudgeContent,
  draftPublishIntervalMs,
  HISTORY_PAGE_SIZE,
  INTERNAL_PLACEHOLDER_CONTENTS,
  MAX_TOOL_CALLS_PER_RUN,
  MAX_TOOL_CALLS_PER_TURN,
  OVERFLOW_RETRY_WINDOW_SIZE,
  PROGRESS_TOOL_NAMES,
  payloadToDict,
  progressMessageFromToolOutput,
  RUN_TOOL_LIMIT_SAFETY_MESSAGE,
  runFailurePayload,
  sanitizeHostVisible,
  TOOL_LIMIT_EXEMPT_TOOL_NAMES,
  turnToolLimitMessage,
} from "./sanitize";
import { isUuid, type Row, type RunsStorage } from "./storage";

/** The durable workflow's registered name; the turn job enqueues it. */
export const TURN_WORKFLOW = "agentic.turn.run";

/** Event types a turn writes, and so the ones a replayed step may clear after its base seq. */
export const AGENT_EVENT_TYPES = [
  "on_chat_model_end",
  "on_tool_start",
  "on_tool_end",
  "on_tool_error",
  "assistant.message",
  "agent.nudge",
] as const;

/** Upper bound on steps in one turn; the tool limits normally end a turn long before. */
const MAX_STEPS_PER_TURN = MAX_TOOL_CALLS_PER_TURN * 2;

export const RUN_FINISHED_EVENT_CODE = "AGENTIC_RUN_FINISHED";
export const RUN_STOPPED_EVENT_CODE = "AGENTIC_RUN_STOPPED";

export interface TurnArgs {
  readonly runId: string;
  readonly turnSeq: number;
  readonly projectId: string;
  /** Model input: the assembled prompt with project framing and focus block. */
  readonly userMessage: string;
  /** What the host typed; the only text ever quoted back to them. */
  readonly hostUserMessage: string | null;
}

export interface TurnDeps {
  readonly store: RunsStorage;
  readonly logger: Logger;
  readonly models: Models;
  readonly config: {
    readonly agentic: {
      readonly modelGroup: "text_fast" | "multi_modal_fast" | "multi_modal_pro";
      readonly runTimeoutSeconds: number;
    };
    readonly canvas: { readonly enabled: boolean };
    readonly http: { readonly dashboardUrl: string; readonly portalUrl: string };
  };
  readonly agent: Agent;
  readonly bindData: (who: Signed, ctx: TurnContext) => AgentData;
  readonly capture: Capture;
  readonly notify: (e: Emit) => Promise<unknown>;
  readonly now: () => Date;
  /** How often a running step re-reads the run to notice Stop. */
  readonly cancelPollMs?: number;
}

/** Runs fn as one checkpointed step: a DBOS step in the worker, a plain call in tests. */
export type RunStep = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

interface LoopState {
  latestOutput: string | null;
  totalToolStarts: number;
  countedToolStarts: number;
  callsWithoutAssistant: number;
  nudged: number[];
  hasSentProgressIntro: boolean;
  pendingProgressMessageId: string | null;
  /** Seq of the last event this turn wrote; the next step clears leftovers after it. */
  lastSeq: number;
  /** The history was cut to its last turns after the model reported a context overflow. */
  windowed: boolean;
}

interface Begin {
  readonly go: boolean;
  readonly history: TextTurn[];
  readonly canvasEnabled: boolean;
  readonly triggeringMessageId: string | null;
  readonly persistedNonExempt: number;
  readonly deadline: number;
  readonly baseSeq: number;
  readonly who: Signed | null;
  readonly chatId: string | null;
  readonly distinctId: string;
  readonly appUserId: string | null;
}

type End =
  | { kind: "limit" }
  | { kind: "cancelled" }
  | { kind: "timeout"; message: string }
  | { kind: "error"; code: string; status?: number; message: string };

interface StepOutcome {
  readonly state: LoopState;
  readonly responseMessages: ModelMessage[];
  readonly done: boolean;
  readonly end?: End;
}

class StopTurn extends Error {}
class Cancelled extends Error {}

/**
 * One assistant turn, ported from agentic_worker.process_agentic_run. It runs as a DBOS
 * workflow whose id names the run and the turn, so starting it twice is a no-op and a
 * crashed worker's turn resumes elsewhere at its first unfinished step: that id and the
 * executor heartbeat are the turn lease the Redis key used to be. Each agent step (one
 * model call and its tools) is a step here; its result carries the messages and counters
 * the next step needs, so a replay rebuilds the same state from checkpoints.
 */
export async function runTurn(d: TurnDeps, a: TurnArgs, runStep: RunStep): Promise<void> {
  const begin = await runStep("begin", () => beginTurn(d, a));
  if (!begin.go) return;
  let state: LoopState = {
    latestOutput: null,
    totalToolStarts: 0,
    countedToolStarts: 0,
    callsWithoutAssistant: 0,
    nudged: [],
    hasSentProgressIntro: false,
    pendingProgressMessageId: null,
    lastSeq: begin.baseSeq,
    windowed: false,
  };
  const prior: ModelMessage[] = [];
  let end: End | undefined = begin.who
    ? undefined
    : { kind: "error", code: "AGENT_UNEXPECTED_ERROR", message: "Run creator no longer exists" };
  for (let i = 0; !end && i < MAX_STEPS_PER_TURN; i++) {
    const out = await runStep(`agent-${i}`, () => agentStep(d, a, begin, state, prior, i));
    state = out.state;
    prior.push(...out.responseMessages);
    if (out.end) end = out.end;
    else if (out.done) break;
  }
  await runStep("finish", () => finishTurn(d, a, begin, state, end));
}

async function beginTurn(d: TurnDeps, a: TurnArgs): Promise<Begin> {
  const run = await d.store.get(a.runId);
  const latest = await d.store.latestEvent(a.runId, "user.message");
  const status = String(run?.status ?? "");
  const stale = !run || Number(latest?.seq ?? 0) !== a.turnSeq;
  const none: Begin = {
    go: false,
    history: [],
    canvasEnabled: false,
    triggeringMessageId: null,
    persistedNonExempt: 0,
    deadline: 0,
    baseSeq: 0,
    who: null,
    chatId: null,
    distinctId: a.runId,
    appUserId: null,
  };
  // A turn only starts from its own queued state: a Stop that landed first, or a newer
  // host message that superseded it, leaves nothing to do.
  if (stale || (status !== "queued" && status !== "running")) return none;
  const started = await d.store.setStatus(a.runId, "running", d.now(), {
    ifStatus: ["queued", "running"],
  });
  if (!started) return none;
  const directusUserId = String(run.directus_user_id ?? "");
  const who = directusUserId ? await principalFor(d.store.sql, directusUserId) : null;
  const trigger = (await d.store.listEvents(a.runId, a.turnSeq - 1, 1))[0];
  const last = await d.store.latestEvent(a.runId);
  return {
    go: true,
    history: await buildMessageHistory(d.store, a.runId),
    canvasEnabled: await canvasEnabled(d.store.sql, a.projectId, d.config.canvas.enabled),
    triggeringMessageId:
      trigger?.event_type === "user.message" ? String(trigger.id ?? "") || null : null,
    persistedNonExempt: await countPersistedNonExemptToolStarts(d.store, a.runId),
    deadline: d.now().getTime() + d.config.agentic.runTimeoutSeconds * 1000,
    baseSeq: Number(last?.seq ?? a.turnSeq),
    who,
    chatId: typeof run.project_chat_id === "string" ? run.project_chat_id : null,
    distinctId: await distinctIdFor(d.store.sql, directusUserId || null, a.runId),
    appUserId: who?.appUserId ?? null,
  };
}

async function countPersistedNonExemptToolStarts(
  store: RunsStorage,
  runId: string,
): Promise<number> {
  let total = 0;
  let after = 0;
  for (;;) {
    const events = await store.listEvents(runId, after, HISTORY_PAGE_SIZE);
    if (!events.length) return total;
    for (const e of events) {
      after = Math.max(after, Number(e.seq ?? 0));
      if (e.event_type !== "on_tool_start") continue;
      const name = String(payloadToDict(e.payload).name ?? "tool");
      if (!TOOL_LIMIT_EXEMPT_TOOL_NAMES.has(name)) total++;
    }
    if (events.length < HISTORY_PAGE_SIZE) return total;
  }
}

const toModel = (m: TextTurn): ModelMessage =>
  m.role === "user"
    ? { role: "user", content: m.content }
    : { role: "assistant", content: m.content };

async function agentStep(
  d: TurnDeps,
  a: TurnArgs,
  begin: Begin,
  from: LoopState,
  prior: readonly ModelMessage[],
  stepIndex: number,
): Promise<StepOutcome> {
  // A replay after a crash first removes what the dead attempt of this step wrote.
  await d.store.deleteAgentEventsAfter(a.runId, from.lastSeq, AGENT_EVENT_TYPES);
  const s: LoopState = { ...from, nudged: [...from.nudged] };
  const current = await d.store.get(a.runId);
  if (current?.status !== "running")
    return { state: s, responseMessages: [], done: true, end: { kind: "cancelled" } };
  if (d.now().getTime() >= begin.deadline)
    return { state: s, responseMessages: [], done: true, end: timeoutEnd() };

  const who = begin.who as Signed;
  const ctx: TurnContext = {
    projectId: a.projectId,
    threadId: a.runId,
    chatId: begin.chatId,
    appUserId: begin.appUserId,
    messageId: begin.triggeringMessageId,
    canvasEnabled: begin.canvasEnabled,
    docsBaseUrl: docsBaseUrl(d.config.http.dashboardUrl),
    portalUrl: d.config.http.portalUrl,
  };
  const data = d.bindData(who, ctx);
  const model = d.models.model(d.config.agentic.modelGroup);
  let transientLeft = 1;

  for (;;) {
    const history = s.windowed ? begin.history.slice(-OVERFLOW_RETRY_WINDOW_SIZE) : begin.history;
    const messages = [...turnMessages(history, a.userMessage).map(toModel), ...prior];
    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    const poll = setInterval(() => {
      void d.store.get(a.runId).then(
        (r) => {
          if (r && r.status !== "running") {
            cancelled = true;
            controller.abort(new Cancelled("stopped"));
          }
        },
        () => {},
      );
    }, d.cancelPollMs ?? 1000);
    const timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort(new Error("Agent request timed out"));
      },
      Math.max(0, begin.deadline - d.now().getTime()),
    );
    const turn = new StepEmitter(d, a, begin, s, stepIndex, () => cancelled);
    try {
      const res = await d.agent.step(
        { ctx, data, model, messages, stepIndex, signal: controller.signal },
        (e) => turn.on(e),
      );
      return { state: s, responseMessages: res.responseMessages, done: res.done };
    } catch (err) {
      if (err instanceof StopTurn)
        return { state: s, responseMessages: [], done: true, end: { kind: "limit" } };
      if (cancelled || err instanceof Cancelled)
        return { state: s, responseMessages: [], done: true, end: { kind: "cancelled" } };
      if (timedOut) return { state: s, responseMessages: [], done: true, end: timeoutEnd() };
      const up = upstreamError(err);
      if (up && !turn.emitted && transientLeft > 0 && isTransient(up)) {
        transientLeft--;
        d.logger.warn(
          { runId: a.runId, code: up.code },
          "transient model error; retrying the step once",
        );
        continue;
      }
      if (
        up &&
        !turn.emitted &&
        !s.windowed &&
        begin.history.length > OVERFLOW_RETRY_WINDOW_SIZE &&
        isContextOverflow(up)
      ) {
        d.logger.warn(
          { runId: a.runId, messages: begin.history.length },
          "context overflow; retrying with the latest turns only",
        );
        s.windowed = true;
        transientLeft = 1;
        continue;
      }
      if (up) return { state: s, responseMessages: [], done: true, end: { kind: "error", ...up } };
      d.logger.error({ err, runId: a.runId }, "turn step failed unexpectedly");
      return {
        state: s,
        responseMessages: [],
        done: true,
        end: {
          kind: "error",
          code: "AGENT_UNEXPECTED_ERROR",
          message: String((err as Error)?.message ?? err),
        },
      };
    } finally {
      clearInterval(poll);
      clearTimeout(timer);
    }
  }
}

const timeoutEnd = (): End => ({ kind: "timeout", message: "Agent request timed out" });

/** Where docs citations link: the published docs site for dembrane hosts, bare paths elsewhere. */
export function docsBaseUrl(dashboardUrl: string): string {
  try {
    return new URL(dashboardUrl).hostname.endsWith("dembrane.com")
      ? "https://docs.dembrane.com"
      : "";
  } catch {
    return "";
  }
}

/**
 * The worker's per-event rules for one step: what is stored, what is streamed, what the
 * host sees, and when the turn must stop. Mirrors the event loop of the Python worker.
 */
class StepEmitter {
  emitted = false;
  private readonly ids = new Map<string, string>();
  private readonly drafts = new Map<string, string>();
  private readonly draftAt = new Map<string, number>();
  private readonly draftSent = new Map<string, string>();

  constructor(
    private readonly d: TurnDeps,
    private readonly a: TurnArgs,
    private readonly begin: Begin,
    private readonly s: LoopState,
    private readonly stepIndex: number,
    private readonly isCancelled: () => boolean,
  ) {}

  /** The agent's message id mapped onto one derived from the turn, stable across replays. */
  private id(agentId: string): string {
    let v = this.ids.get(agentId);
    if (!v) {
      v = stableUuid(`${this.a.runId}:${this.a.turnSeq}:${this.stepIndex}:${this.ids.size}`);
      this.ids.set(agentId, v);
    }
    return v;
  }

  async on(e: StepEvent): Promise<void> {
    if (this.isCancelled()) throw new Cancelled("stopped");
    this.emitted = true;
    const s = this.s;
    switch (e.type) {
      case "text-delta": {
        const id = this.id(e.messageId);
        this.drafts.set(id, (this.drafts.get(id) ?? "") + e.delta);
        await this.maybePublishDraft(id, false);
        return;
      }
      case "model-end": {
        const id = this.id(e.messageId);
        if (this.drafts.has(id)) await this.maybePublishDraft(id, true);
        const hasProgress = e.toolCalls.some((c) => PROGRESS_TOOL_NAMES.has(c.name));
        // The tool's output is this model turn's visible message; sharing the id lets the
        // streamed narration draft resolve into it.
        if (hasProgress) s.pendingProgressMessageId = id;
        const text = e.content.trim();
        if (text) {
          if (hasProgress) s.hasSentProgressIntro = true;
          else {
            const persisted = await this.assistantMessage(text, id, false);
            if (persisted !== null) {
              s.latestOutput = persisted;
              this.resetSilence();
            }
          }
        }
        await this.append(
          "on_chat_model_end",
          chatModelEnd({
            runId: id,
            threadId: this.a.runId,
            content: e.content,
            toolCalls: e.toolCalls,
            model: e.model,
            usage: e.usage,
          }),
        );
        return;
      }
      case "tool-start": {
        s.totalToolStarts++;
        const exempt = TOOL_LIMIT_EXEMPT_TOOL_NAMES.has(e.name);
        if (!exempt) s.countedToolStarts++;
        s.callsWithoutAssistant++;
        if (exempt || !s.hasSentProgressIntro) {
          // An ack or plan tick is what the host sees move, so it counts as an update.
          s.hasSentProgressIntro = true;
          this.resetSilence();
        } else {
          const milestone =
            Math.floor(s.callsWithoutAssistant / AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL) *
            AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL;
          if (
            s.callsWithoutAssistant >= AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL &&
            !s.nudged.includes(milestone)
          ) {
            s.nudged.push(milestone);
            await this.append("agent.nudge", {
              hidden: true,
              origin: "automatic_nudge",
              // The app, not the host: never shown or replayed as a chat message.
              role: "runtime",
              content: automaticNudgeContent(s.callsWithoutAssistant),
              tool_calls_without_assistant_message: s.callsWithoutAssistant,
              total_tool_calls: s.totalToolStarts,
            });
          }
        }
        if (this.begin.persistedNonExempt + s.countedToolStarts >= MAX_TOOL_CALLS_PER_RUN) {
          s.latestOutput = await this.assistantMessage(
            RUN_TOOL_LIMIT_SAFETY_MESSAGE,
            null,
            false,
            "run-limit",
          );
          this.resetSilence();
          throw new StopTurn();
        }
        if (s.countedToolStarts >= MAX_TOOL_CALLS_PER_TURN) {
          // One honest message only; the last substantive answer is already in the chat.
          s.latestOutput = await this.assistantMessage(
            turnToolLimitMessage(this.a.hostUserMessage),
            null,
            false,
            "turn-limit",
          );
          this.resetSilence();
          throw new StopTurn();
        }
        await this.append(
          "on_tool_start",
          toolStart({ runId: e.runId, threadId: this.a.runId, name: e.name, input: e.input }),
        );
        return;
      }
      case "tool-end": {
        await this.append(
          "on_tool_end",
          toolEnd({
            runId: e.runId,
            threadId: this.a.runId,
            name: e.name,
            input: e.input,
            toolCallId: e.toolCallId,
            output: e.output,
            messageId: stableUuid(`${this.a.runId}:${e.toolCallId}:tool-message`),
          }),
        );
        const progress = progressMessageFromToolOutput(e.name, e.output);
        if (progress) {
          s.hasSentProgressIntro = true;
          const persisted = await this.assistantMessage(progress, s.pendingProgressMessageId, true);
          s.pendingProgressMessageId = null;
          if (persisted !== null) this.resetSilence();
        }
        return;
      }
      case "tool-error": {
        await this.append(
          "on_tool_error",
          toolError({
            runId: e.runId,
            threadId: this.a.runId,
            name: e.name,
            input: e.input,
            error: e.error,
          }),
        );
        return;
      }
    }
  }

  private resetSilence() {
    this.s.callsWithoutAssistant = 0;
    this.s.nudged = [];
  }

  private async append(type: string, payload: unknown): Promise<Row> {
    const ev = await this.d.store.appendEvent(this.a.runId, type, payload, this.d.now());
    this.s.lastSeq = Math.max(this.s.lastSeq, Number(ev.seq ?? 0));
    await publishEvent(this.d.store.sql, this.a.runId, ev, this.d.logger);
    return ev;
  }

  /**
   * A host-visible assistant message: event first (the stream never waits on the chat
   * write), then the chat's copy under the same id. Placeholders and empty text never
   * become messages; they only fragment the chat.
   */
  private async assistantMessage(
    content: string,
    messageId: string | null,
    keepStatusNarration: boolean,
    fixedKey?: string,
  ): Promise<string | null> {
    const text = sanitizeHostVisible(content, { keepStatusNarration });
    if (text === null) return null;
    const chatId = this.begin.chatId;
    const payload: Record<string, unknown> = { content: text };
    if (messageId) payload.message_id = messageId;
    const rowId = chatId
      ? messageId && isUuid(messageId)
        ? messageId
        : stableUuid(`${this.a.runId}:${this.a.turnSeq}:${this.stepIndex}:${fixedKey ?? "message"}`)
      : null;
    if (chatId && messageId && isUuid(messageId)) payload.persisted_message_id = messageId;
    await this.append("assistant.message", payload);
    if (chatId && rowId) {
      try {
        await this.d.store.persistChatMessage({
          id: rowId,
          chatId,
          from: "assistant",
          text,
          now: this.d.now(),
        });
      } catch (err) {
        this.d.logger.warn({ err, chatId }, "persisting the assistant message to the chat failed");
      }
    }
    return text;
  }

  private async maybePublishDraft(id: string, flush: boolean) {
    const text = this.drafts.get(id) ?? "";
    const now = Date.now();
    const last = this.draftAt.get(id);
    if (!flush && last !== undefined && now - last < draftPublishIntervalMs(text.length)) return;
    const sanitized = sanitizeHostVisible(text);
    if (!sanitized || sanitized === this.draftSent.get(id)) return;
    // A growing draft hits placeholder prefixes ("(calling") before the sanitiser can
    // match the whole placeholder; hold those back.
    for (const p of INTERNAL_PLACEHOLDER_CONTENTS) if (p.startsWith(sanitized)) return;
    this.draftAt.set(id, now);
    this.draftSent.set(id, sanitized);
    await publishDraft(this.d.store.sql, this.a.runId, id, sanitized, this.d.logger);
  }
}

async function finishTurn(
  d: TurnDeps,
  a: TurnArgs,
  begin: Begin,
  s: LoopState,
  end: End | undefined,
): Promise<void> {
  const chatError = (code: string) =>
    d.capture(begin.distinctId, "server_chat_error", {
      run_id: a.runId,
      project_id: a.projectId,
      error_code: code,
      mode: "agentic",
    });
  const run = await d.store.get(a.runId);
  // Stop already wrote run.failed and the failed status; the turn ends without a word.
  if (end?.kind === "cancelled" || run?.status !== "running") {
    d.logger.info({ runId: a.runId, turn: a.turnSeq }, "turn cancelled");
    await chatError(AGENT_CANCELLED_ERROR_CODE);
    return;
  }
  const failWith = async (
    type: "run.failed" | "run.timeout",
    status: "failed" | "timeout",
    code: string,
    message: string,
    httpStatus?: number,
  ) => {
    await chatError(code);
    const ev = await d.store.appendEvent(
      a.runId,
      type,
      runFailurePayload(code, httpStatus),
      d.now(),
    );
    await publishEvent(d.store.sql, a.runId, ev, d.logger);
    await d.store.setStatus(a.runId, status, d.now(), {
      latestError: message,
      latestErrorCode: code,
      ifStatus: ["running"],
    });
    await notifyIfUnwatched(d, a, begin, false);
  };
  if (end?.kind === "timeout") {
    d.logger.warn({ runId: a.runId }, "turn timed out");
    return failWith("run.timeout", "timeout", "AGENT_TIMEOUT", end.message);
  }
  if (end?.kind === "error") {
    d.logger.warn({ runId: a.runId, code: end.code }, "turn failed");
    return failWith("run.failed", "failed", end.code, end.message, end.status);
  }
  const latestUser = await d.store.latestEvent(a.runId, "user.message");
  const latestSeq = Number(latestUser?.seq ?? 0);
  if (latestSeq > a.turnSeq) {
    await d.store.setStatus(a.runId, "queued", d.now(), {
      latestOutput: s.latestOutput,
      ifStatus: ["running"],
    });
  } else {
    await d.store.setStatus(a.runId, "completed", d.now(), {
      latestOutput: s.latestOutput,
      ifStatus: ["running"],
    });
    await notifyIfUnwatched(d, a, begin, true);
  }
  await d.capture(begin.distinctId, "server_chat_response_received", {
    run_id: a.runId,
    project_id: a.projectId,
    has_output: s.latestOutput !== null,
    mode: "agentic",
  });
}

/**
 * Tells the host their answer is ready when no stream is open on the run: they may close
 * the tab once the plan is up while the turn keeps running. Best effort.
 */
async function notifyIfUnwatched(d: TurnDeps, a: TurnArgs, begin: Begin, finished: boolean) {
  if (!begin.appUserId || !begin.chatId) return;
  try {
    if ((await watchers(d.store.sql, a.runId)) > 0) return;
    const sql = d.store.sql;
    const [p] = await sql`select workspace_id from project where id = ${a.projectId}`;
    const [c] = await sql`select name from project_chat where id = ${begin.chatId}`;
    const chatName = typeof c?.name === "string" && c.name.trim() ? c.name.trim() : null;
    const title = finished
      ? chatName
        ? `Your answer in ${chatName} is ready`
        : "Your answer is ready"
      : chatName
        ? `${chatName} stopped before it finished`
        : "Your chat stopped before it finished";
    await d.notify({
      audienceUserId: begin.appUserId,
      eventCode: finished ? RUN_FINISHED_EVENT_CODE : RUN_STOPPED_EVENT_CODE,
      title,
      action: "NAVIGATE_CHAT",
      refWorkspaceId: (p?.workspace_id as string | null) ?? null,
      refProjectId: a.projectId,
      refChatId: begin.chatId,
      params: chatName ? { chat_name: chatName } : null,
    });
  } catch (err) {
    d.logger.warn({ err, runId: a.runId }, "turn finished but the notification failed");
  }
}

interface Upstream {
  code: string;
  status?: number;
  message: string;
}

/** A model provider failure in the agent service's terms: its HTTP status, or transport. */
export function upstreamError(err: unknown): Upstream | null {
  let e: unknown = err;
  // AI SDK RetryError wraps the last attempt's error.
  for (let i = 0; i < 3 && e && typeof e === "object" && "lastError" in e; i++)
    e = (e as { lastError: unknown }).lastError;
  if (APICallError.isInstance(e)) {
    const status = e.statusCode;
    if (status === undefined)
      return { code: "AGENT_UPSTREAM_TRANSPORT", status: 502, message: e.message };
    return {
      code: `AGENT_UPSTREAM_${status}`,
      status,
      message: `${e.message} ${e.responseBody ?? ""}`.trim(),
    };
  }
  const x = e as { name?: string; code?: string; message?: string } | null;
  const transport =
    x &&
    (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"].includes(x.code ?? "") ||
      (x.name === "TypeError" && /fetch failed|network/i.test(x.message ?? "")));
  if (transport)
    return { code: "AGENT_UPSTREAM_TRANSPORT", status: 502, message: String(x?.message ?? "") };
  return null;
}

export function isTransient(e: Upstream): boolean {
  if (e.code === "AGENT_UPSTREAM_TRANSPORT") return true;
  if (e.status !== undefined && [502, 503, 504].includes(e.status)) return true;
  const hay = `${e.code} ${e.message}`.toLowerCase();
  return [
    "incomplete chunked read",
    "peer closed connection",
    "connection reset",
    "connection closed",
    "broken pipe",
  ].some((m) => hay.includes(m));
}

export function isContextOverflow(e: Upstream): boolean {
  if (e.status === 413) return true;
  const hay = `${e.code} ${e.message}`.toLowerCase();
  if (hay.includes("prompt too long")) return true;
  const any = (words: string[]) => words.some((w) => hay.includes(w));
  if (hay.includes("context") && any(["length", "window", "limit", "too long", "maximum"]))
    return true;
  if (hay.includes("token") && any(["limit", "maximum", "too many", "context", "length"]))
    return true;
  if (hay.includes("maximum") && (hay.includes("context") || hay.includes("token"))) return true;
  return false;
}
