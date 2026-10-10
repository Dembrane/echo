import type { Access } from "@dembrane/access";
import type { ChatsStorage } from "@dembrane/chats";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  newId,
  PlatformError,
  StatusError,
  UnavailableError,
} from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import type { Logger } from "@dembrane/observability";
import type { Queue } from "@dembrane/queue";
import { agentProject } from "../access";
import { startTurn } from "../jobs";
import {
  currentGoal,
  FREE_TIER_MAX_CHAT_USER_TURNS,
  FREE_TIER_MAX_SAMPLE_USER_TURNS,
  freeTierLimitError,
  isSampleProject,
  liveProject,
  projectTier,
  workspaceContext,
} from "./context";
import { type Focused, followupPrompt, initialPrompt, nonEmpty } from "./focus";
import { publishEvent } from "./live";
import {
  AGENT_CANCELLED_ERROR_CODE,
  AGENT_CANCELLED_MESSAGE,
  payloadToDict,
  runFailurePayload,
} from "./sanitize";
import { type Row, type RunsStorage, TERMINAL_RUN_STATUSES } from "./storage";

/** A turn is a typed question, not a document; hosts attach conversations for bulk text. */
export const MAX_AGENTIC_MESSAGE_LENGTH = 32_000;

export interface RunsDeps {
  readonly store: RunsStorage;
  readonly chats: ChatsStorage;
  readonly access: Access;
  readonly queue: Pick<Queue, "enqueue">;
  readonly logger: Logger;
  readonly now: () => Date;
  /** A chat title from the host's first message; null when none could be made. */
  readonly generateTitle: (text: string, language: string) => Promise<string | null>;
}

const relatedId = (v: unknown): string | null =>
  v && typeof v === "object" ? nonEmpty((v as { id?: unknown }).id) : nonEmpty(v);

// ── chat binding ───────────────────────────────────────────────────────

/**
 * A chat id from the request, bound to the project the caller was authorised for before
 * anything is written against it. Every chat read runs without row ACL, so without this a
 * caller could pull another tenant's participant names into their own prompt. It fails
 * closed: a foreign chat is 400, a chat that cannot be read at all 503.
 */
async function assertChatInProject(d: RunsDeps, chatId: string | null, projectId: string) {
  if (!chatId) return;
  let chat: Awaited<ReturnType<ChatsStorage["chat"]>>;
  try {
    chat = await d.chats.chat(chatId);
  } catch {
    chat = null;
  }
  if (!chat) {
    d.logger.warn({ chatId }, "could not load the chat to verify it for this run");
    throw new UnavailableError("chat.verify_unavailable");
  }
  mismatch(chat.project_id?.id ?? null, projectId);
}

function mismatch(chatProjectId: string | null, projectId: string | null) {
  if (!projectId) throw new BadRequestError("chat.project_required");
  if (chatProjectId !== projectId) throw new BadRequestError("chat.project_mismatch");
}

/**
 * The conversations the host attached to the chat, as focus hints: deduplicated (the
 * junction has no unique constraint), in the host's order, without deleted ones (the agent
 * cannot read those). A chat that cannot be read loses its hint rather than the turn; its
 * binding to the project was verified before.
 */
async function focusedConversations(
  d: RunsDeps,
  chatId: string | null,
  projectId: string | null,
): Promise<Focused[]> {
  if (!chatId) return [];
  let chat: Awaited<ReturnType<ChatsStorage["chat"]>>;
  try {
    chat = await d.chats.chat(chatId, true);
  } catch {
    chat = null;
  }
  if (!chat) {
    d.logger.warn({ chatId }, "could not load the chat for its focus hint");
    return [];
  }
  mismatch(chat.project_id?.id ?? null, projectId);
  const seen = new Set<string>();
  const out: Focused[] = [];
  for (const link of chat.used_conversations ?? []) {
    const ref = link.conversation_id;
    const id = ref ? nonEmpty(ref.id) : null;
    if (!ref || !id || seen.has(id) || ref.deleted_at) continue;
    seen.add(id);
    out.push({ id, name: nonEmpty(ref.participant_name) ?? "" });
  }
  return out;
}

async function checkFreeTierTurns(d: RunsDeps, projectId: string | null, chatId: string | null) {
  if (!chatId || !projectId) return;
  if ((await projectTier(d.store.sql, projectId)) !== "free") return;
  // A sample copy's chats skip the per-chat cap and share the sample's own allowance.
  const spent = (await isSampleProject(d.store.sql, projectId))
    ? (await d.chats.countProjectUserTurns(projectId)) >= FREE_TIER_MAX_SAMPLE_USER_TURNS
    : (await d.chats.countUserTurns(chatId)) >= FREE_TIER_MAX_CHAT_USER_TURNS;
  if (spent) throw freeTierLimitError("chat_turns");
}

async function persistUserMessage(d: RunsDeps, chatId: string | null, text: string) {
  if (!chatId) return;
  try {
    await d.store.persistChatMessage({ id: newId(), chatId, from: "user", text, now: d.now() });
  } catch (err) {
    d.logger.warn({ err, chatId }, "persisting the host's message to the chat failed");
  }
}

/** Names an untitled chat from the host's message, after the response. Never fails the request. */
function scheduleTitle(d: RunsDeps, chatId: string | null, text: string, language: string) {
  if (!chatId) return;
  void (async () => {
    try {
      const chat = await d.chats.chat(chatId);
      if (!chat || nonEmpty(chat.name) !== null) return;
      const title = await d.generateTitle(text, language);
      if (nonEmpty(title) === null) return;
      await d.chats.setChatName(chatId, title, d.now());
    } catch (err) {
      d.logger.warn({ err, chatId }, "chat title generation failed");
    }
  })();
}

// ── runs ───────────────────────────────────────────────────────────────

async function runOr404(d: RunsDeps, runId: string): Promise<Row> {
  const run = await d.store.get(runId);
  if (!run) throw new NotFoundError("agent.run_not_found");
  return run;
}

/**
 * Runs are their creator's. Spec L-2: a creator removed from the project kept reading and
 * appending to their runs; the project gate now applies as well.
 */
async function authorizeRun(d: RunsDeps, who: Signed, run: Row) {
  if (run.directus_user_id !== who.directusUserId) throw new ForbiddenError("agent.run_forbidden");
  const projectId = relatedId(run.project_id);
  if (projectId) {
    try {
      await agentProject(d.access, who, projectId);
    } catch (err) {
      if (err instanceof PlatformError) throw new ForbiddenError("agent.run_forbidden");
      throw err;
    }
  }
}

export async function createRun(
  d: RunsDeps,
  who: Signed,
  body: { project_id: string; project_chat_id: string | null; message: string; language: string },
): Promise<Row> {
  const project = await liveProject(d.store.sql, body.project_id);
  if (!project) throw new NotFoundError("project.not_found");
  await agentProject(d.access, who, body.project_id);
  await assertChatInProject(d, body.project_chat_id, body.project_id);
  const focused = await focusedConversations(d, body.project_chat_id, body.project_id);
  // The Pilot hard block the old route checked here always answers "not blocked" now
  // (is_hard_blocked is deprecated to False), so it is not ported.
  await checkFreeTierTurns(d, body.project_id, body.project_chat_id);

  const run = await d.store.create({
    id: newId(),
    projectId: body.project_id,
    chatId: body.project_chat_id,
    directusUserId: who.directusUserId,
    now: d.now(),
  });
  const prompt = initialPrompt({
    projectName: project.name,
    projectContext: project.context,
    projectGoal: await currentGoal(d.store.sql, body.project_id),
    workspaceContext: await workspaceContext(d.store.sql, project.workspaceId),
    userMessage: body.message,
    focused,
  });
  const payload: Record<string, unknown> = { content: body.message, agent_prompt_content: prompt };
  if (focused.length) payload.focused_conversation_ids = focused.map((f) => f.id);
  await d.store.appendEvent(String(run.id), "user.message", payload, d.now());
  await persistUserMessage(d, body.project_chat_id, body.message);
  scheduleTitle(d, body.project_chat_id, body.message, body.language);
  return runOr404(d, String(run.id));
}

export async function appendMessage(
  d: RunsDeps,
  who: Signed,
  runId: string,
  body: { message: string; language: string },
): Promise<Row> {
  const run = await runOr404(d, runId);
  await authorizeRun(d, who, run);
  const chatId = nonEmpty(run.project_chat_id);
  const projectId = relatedId(run.project_id);
  const focused = await focusedConversations(d, chatId, projectId);
  await checkFreeTierTurns(d, projectId, chatId);
  const payload: Record<string, unknown> = { content: body.message };
  if (focused.length) {
    payload.agent_prompt_content = followupPrompt(body.message, focused);
    payload.focused_conversation_ids = focused.map((f) => f.id);
  }
  await d.store.appendEvent(runId, "user.message", payload, d.now());
  await persistUserMessage(d, chatId, body.message);
  scheduleTitle(d, chatId, body.message, body.language);
  if (run.status === "running") return runOr404(d, runId);
  return (await d.store.setStatus(runId, "queued", d.now())) as Row;
}

interface LatestTurn {
  readonly seq: number;
  readonly agentMessage: string;
  readonly hostMessage: string;
}

/**
 * The newest user turn, model input and host text kept apart: the prompt carries
 * participant-controlled names and is model input only; the host's own words are the only
 * text that may be shown back to them.
 */
async function latestUserTurn(d: RunsDeps, runId: string): Promise<LatestTurn | null> {
  const ev = await d.store.latestEvent(runId, "user.message");
  if (!ev) return null;
  const p = payloadToDict(ev.payload);
  const host = typeof p.content === "string" && p.content.trim() ? p.content : "";
  let agent = typeof p.agent_prompt_content === "string" ? p.agent_prompt_content : "";
  // Runs that predate the assembled prompt used the host's text as model input.
  if (!agent.trim()) agent = host;
  if (!agent) return null;
  const seq = Number(ev.seq ?? 0);
  if (!(seq > 0)) return null;
  return { seq, agentMessage: agent, hostMessage: host };
}

/**
 * The Stream call's side effect: a queued run with a user turn gets that turn started in
 * the worker. The job's singleton key and the workflow id both name the run and turn, so
 * concurrent Stream calls (two tabs, a reconnect) start it once.
 */
export async function claimTurn(d: RunsDeps, who: Signed, runId: string): Promise<Row> {
  const run = await runOr404(d, runId);
  await authorizeRun(d, who, run);
  if (run.status !== "queued") return run;
  const turn = await latestUserTurn(d, runId);
  if (!turn) return run;
  const projectId = relatedId(run.project_id);
  if (!projectId) throw new StatusError(500, "agent.run_missing_project");
  await d.queue.enqueue(
    startTurn,
    {
      runId,
      turnSeq: turn.seq,
      projectId,
      userMessage: turn.agentMessage,
      hostUserMessage: turn.hostMessage,
    },
    { singletonKey: `${runId}:${turn.seq}` },
  );
  return run;
}

/**
 * Stop. The turn runs in the worker, never in this process, so the stop always takes the
 * path the old API took for a turn on another replica: write the terminal shape the
 * worker's own cancel produced. The turn notices the failed status at its next check and
 * stops quietly, and its own status writes only apply while the run is running.
 */
export async function stopRun(d: RunsDeps, who: Signed, runId: string) {
  const run = await runOr404(d, runId);
  await authorizeRun(d, who, run);
  const turn = await latestUserTurn(d, runId);
  if (!turn) throw new ConflictError("agent.no_active_turn");
  if (!TERMINAL_RUN_STATUSES.has(String(run.status ?? ""))) {
    const ev = await d.store.appendEvent(
      runId,
      "run.failed",
      runFailurePayload(AGENT_CANCELLED_ERROR_CODE),
      d.now(),
    );
    await publishEvent(d.store.sql, runId, ev, d.logger);
    await d.store.setStatus(runId, "failed", d.now(), {
      latestError: AGENT_CANCELLED_MESSAGE,
      latestErrorCode: AGENT_CANCELLED_ERROR_CODE,
    });
  }
  return { run_id: runId, turn_seq: turn.seq, status: "stopped" };
}

export async function getRun(d: RunsDeps, who: Signed, runId: string): Promise<Row> {
  const run = await runOr404(d, runId);
  await authorizeRun(d, who, run);
  return run;
}

export async function latestChatRun(d: RunsDeps, who: Signed, chatId: string): Promise<Row> {
  const run = await d.store.latestForChat(chatId);
  if (!run) throw new NotFoundError("agent.run_not_found", { message: "Agentic run not found" });
  await authorizeRun(d, who, run);
  return run;
}

export async function runEvents(d: RunsDeps, who: Signed, runId: string, afterSeq: number) {
  const run = await runOr404(d, runId);
  await authorizeRun(d, who, run);
  const events = await d.store.listEvents(runId, afterSeq);
  const latest = await runOr404(d, runId);
  const next = events.length ? Number(events.at(-1)?.seq ?? afterSeq) : afterSeq;
  return {
    run_id: runId,
    status: latest.status,
    events,
    next_seq: next,
    done: TERMINAL_RUN_STATUSES.has(String(latest.status ?? "")),
  };
}

/** Authorisation for the event streams, which answer before streaming starts. */
export async function authorizedRun(d: RunsDeps, who: Signed, runId: string): Promise<Row> {
  return getRun(d, who, runId);
}
