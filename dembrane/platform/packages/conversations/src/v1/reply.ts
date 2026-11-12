import { contextForPrompt } from "@dembrane/core";
import { isoTimestamp } from "@dembrane/legacy-shape";
import { type Models, speechHint } from "@dembrane/llm";
import { renderPrompt } from "@dembrane/prompts";
import { pythonJson } from "@dembrane/webhooks";
import { type FilePart, streamText, type TextPart } from "ai";
import type { ConversationsDeps } from "../deps";
import { type V1Store, v1Store } from "./storage";
import { countTokens } from "./token-count";

/**
 * The portal's "get reply" (reply_utils.py), Explore in the portal: the participant's
 * conversation so far, the project's other conversations when cross-pollination is on
 * (summaries or truncated transcripts within a token budget, never named), and any audio
 * not transcribed yet go to multi_modal_pro with the project's reply prompt; the answer
 * streams back and is stored as a conversation_reply.
 */

export type ReplyDeps = Pick<
  ConversationsDeps,
  "db" | "models" | "audio" | "audioUrls" | "logger" | "now"
>;

const TOKEN_LIMIT = 80_000;
const TARGET_TOKENS_PER_CONV = 4_000;

/** The model refused on content grounds; the portal shows its own message for it. */
export class ContentPolicyError extends Error {}

interface Conv {
  name: string;
  tags: string[];
  transcript: string;
}

export function formatConversation(c: Conv): string {
  return `<conversation>\n\t<name>${c.name}</name>\n\t<tags>${c.tags.join(", ")}</tags>\n\t<transcript>${c.transcript}</transcript>\n</conversation>\n`;
}

/** Transcripts and earlier replies interleaved in time order (a stable sort, as in Python). */
export function buildTranscript(
  chunks: readonly { timestamp: string | null; transcript: string | null }[],
  replies: readonly { date_created: string | null; content_text: string | null }[],
): string {
  const items = [
    ...chunks
      .filter((c) => c.transcript !== null)
      .map((c) => ({ at: isoTimestamp(c.timestamp) ?? "", text: `${c.transcript}\n` })),
    ...replies.map((r) => ({
      at: isoTimestamp(r.date_created) ?? "",
      text: `[Assistant Reply at this point in time: ${r.content_text}]\n`,
    })),
  ];
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return items.map((i) => i.text).join("");
}

/**
 * How conversations are named to the model (ECHO-1052): never by the participant's name. The
 * model needs no one's name to ask a question, a name can identify a person, and the old
 * behaviour (other tables by name) made replies quote other groups at this one.
 */
export const CURRENT_CONVERSATION_NAME = "this conversation";
export const OTHER_CONVERSATION_NAME = "another group";

/** The project's other conversations, as Explore may read them when cross-pollination is on. */
async function adjacentConversations(
  store: V1Store,
  projectId: string,
  excludeId: string,
  useSummaries: boolean,
) {
  const rows = await store.adjacent(projectId, excludeId);
  const tags = await store.tagTexts(rows.map((r) => r.id));
  const tagsOf = (id: string) => (tags.get(id) ?? []).filter((t): t is string => t !== null);
  const candidates: [string, number][] = [];
  for (const row of rows) {
    if (useSummaries) {
      if (row.summary === null) continue;
      const f = formatConversation({
        name: OTHER_CONVERSATION_NAME,
        tags: tagsOf(row.id),
        transcript: row.summary,
      });
      candidates.push([f, countTokens(f)]);
      continue;
    }
    const content = await store.adjacentContent(row.id);
    const c: Conv = {
      name: OTHER_CONVERSATION_NAME,
      tags: tagsOf(row.id),
      transcript: buildTranscript(content.chunks, content.replies),
    };
    let f = formatConversation(c);
    let tokens = countTokens(f);
    if (tokens > TARGET_TOKENS_PER_CONV) {
      // Rough cut by the token ratio, measured in characters as Python sliced the string.
      const ratio = TARGET_TOKENS_PER_CONV / tokens;
      const chars = [...c.transcript];
      c.transcript = `${chars.slice(0, Math.trunc(chars.length * ratio)).join("")}\n[Truncated for brevity...]`;
      f = formatConversation(c);
      tokens = countTokens(f);
    }
    candidates.push([f, tokens]);
  }
  let total = 0;
  let out = "";
  for (const [f, tokens] of candidates) {
    if (total + tokens > TOKEN_LIMIT) break;
    out += f;
    total += tokens;
  }
  return out;
}

/** The project fields the Explore prompt reads. */
export interface ReplyProject {
  readonly context: string | null;
  readonly default_conversation_title: string | null;
  readonly default_conversation_description: string | null;
  readonly default_conversation_transcript_prompt: string | null;
  readonly get_reply_mode: string | null;
  readonly get_reply_prompt: string | null;
  readonly anonymize_transcripts: boolean | null;
}

/**
 * The text prompt Explore sends (before any audio). Pure, so tests and the prompt
 * comparison pack render it without a model. `others` is the formatted block of the
 * project's other conversations: empty when cross-pollination is off.
 */
export function replyPrompt(i: {
  project: ReplyProject;
  language: string;
  current: Conv;
  others: string;
}): string {
  const { project, language } = i;
  const mode = project.get_reply_mode;
  // The approved default and brainstorm prompts set their own length and voice (ECHO-1052),
  // so the wrapper's "1-3 sentences" and "we/our" lines do not apply to them.
  const ownFormat = mode === "summarize" || mode === "brainstorm";
  const description: string[] = [];
  const context = contextForPrompt(project.context);
  if (context !== null) description.push(context);
  if (project.default_conversation_title !== null)
    description.push(`Default Conversation Title: ${project.default_conversation_title}`);
  if (project.default_conversation_description !== null)
    description.push(
      `Default Conversation Description: ${project.default_conversation_description}`,
    );
  if (project.default_conversation_transcript_prompt !== null)
    description.push(
      ownFormat
        ? `Key terms (for names and spelling only): ${project.default_conversation_transcript_prompt}`
        : `Default Conversation Transcript Prompt: ${project.default_conversation_transcript_prompt}`,
    );

  let globalPrompt: string;
  if (mode === "summarize") globalPrompt = renderPrompt("get_reply_summarize", language, {});
  else if (mode === "brainstorm") globalPrompt = renderPrompt("get_reply_brainstorm", language, {});
  else if (mode === "custom")
    globalPrompt = project.get_reply_prompt?.trim()
      ? project.get_reply_prompt
      : renderPrompt("get_reply_summarize", language, {});
  else globalPrompt = project.get_reply_prompt ?? "";

  return renderPrompt("get_reply_system", language, {
    PROJECT_DESCRIPTION: description.join("\n\n"),
    GLOBAL_PROMPT: globalPrompt,
    OTHER_TRANSCRIPTS: i.others,
    MAIN_USER_TRANSCRIPT: formatConversation(i.current),
    pii_redaction: Boolean(project.anonymize_transcripts),
    own_format: ownFormat,
  });
}

/**
 * The reply text as it streams. Throws before the first part when the conversation is
 * missing or the project has replies off, as generate_reply_for_conversation did.
 */
export async function* generateReply(
  d: ReplyDeps,
  conversationId: string,
  language: string,
): AsyncGenerator<string> {
  const store = v1Store(d.db);
  const conv = await store.conversation(conversationId);
  if (!conv || conv.deleted_at) throw new Error(`Conversation ${conversationId} not found`);
  const project = await store.projectAny(conv.project_id);
  if (!project) throw new Error(`Conversation ${conversationId} not found`);
  if (project.is_get_reply_enabled === false)
    throw new Error(`Echo is not enabled for project ${project.id}`);

  const ctx = await store.replyContext(conversationId);
  const current: Conv = {
    name: CURRENT_CONVERSATION_NAME,
    tags: ctx.tags.filter((t): t is string => t !== null),
    transcript: buildTranscript(ctx.chunks, ctx.replies),
  };
  const lastReply = ctx.replies.at(-1)?.date_created ?? null;
  const lastReplyAt = lastReply ? new Date(isoTimestamp(lastReply) as string).getTime() : null;
  const audioChunks = ctx.chunks.filter((c) => {
    if ((c.transcript ?? "").trim()) return false;
    if (
      lastReplyAt !== null &&
      c.timestamp &&
      new Date(isoTimestamp(c.timestamp) as string).getTime() <= lastReplyAt
    )
      return false;
    return Boolean(c.path);
  });

  const mode = project.get_reply_mode;
  const useSummaries = mode === "summarize" || mode === "brainstorm" || mode === "custom";
  // Cross-pollination (ECHO-1052): off, Explore reads this conversation only.
  const others = project.is_get_reply_cross_pollination_enabled
    ? await adjacentConversations(store, project.id, conv.id, useSummaries)
    : "";
  const prompt = replyPrompt({ project, language, current, others });

  const content: (TextPart | FilePart)[] = [{ type: "text", text: prompt }];
  for (const chunk of audioChunks) {
    content.push({
      type: "text",
      text: `Audio chunk ${chunk.id} captured at ${isoTimestamp(chunk.timestamp)}`,
    });
    try {
      const blob = await d.audio.get(d.audioUrls.keyOf(chunk.path as string));
      if (!blob) throw new Error("audio object missing");
      // Labelled audio/mp3 whatever the container, as the Python API sent it.
      content.push({
        type: "file",
        data: new Uint8Array(await blob.arrayBuffer()),
        mediaType: "audio/mp3",
      });
    } catch (err) {
      d.logger.warn({ err, chunk: chunk.id }, "failed to attach audio chunk");
    }
  }

  let answer = "";
  for await (const text of replyText(d.models, language, content)) {
    answer += text;
    yield text;
  }
  await store.storeReply(conversationId, answer.trim(), d.now());
}

/**
 * The Explore model call itself: the prompt and any audio to multi_modal_pro, the answer's
 * text as it streams. The live reply and the portal editor's "Try it" (sampleReply) both
 * call it, so a host sees what participants would get.
 */
export async function* replyText(
  models: Models,
  language: string,
  content: (TextPart | FilePart)[],
): AsyncGenerator<string> {
  const result = streamText({
    model: models.model("multi_modal_pro"),
    messages: [{ role: "user", content }],
    maxRetries: 0,
    providerOptions: {
      google: { thinkingConfig: { thinkingBudget: 2048 } },
      ...speechHint(models, language),
    },
  });
  let any = false;
  for await (const part of result.fullStream) {
    if (part.type === "text-delta" && part.text) {
      any = true;
      yield part.text;
    } else if (part.type === "error") throw part.error;
    else if (part.type === "finish" && part.finishReason === "content-filter" && !any)
      throw new ContentPolicyError("content policy violation");
  }
}

/**
 * Explore on a transcript that is no conversation (ECHO-1061): the portal editor's sample,
 * with the host's draft settings in `project`. The same prompt and model call as the live
 * reply, with no other conversations (one sample has none) and nothing stored.
 */
export async function sampleReply(
  models: Models,
  i: { project: ReplyProject; language: string; transcript: string },
): Promise<string> {
  const prompt = replyPrompt({
    project: i.project,
    language: i.language,
    current: { name: CURRENT_CONVERSATION_NAME, tags: [], transcript: i.transcript },
    others: "",
  });
  let answer = "";
  for await (const text of replyText(models, i.language, [{ type: "text", text: prompt }]))
    answer += text;
  return answer.trim();
}

/** How long the portal waits in silence before it is told the system is busy. */
export const HIGH_LOAD_AFTER_MS = 20_000;

/**
 * stream_with_status: if nothing arrives within the threshold, one "2:" data event says
 * the system is under load; after the first part, parts pass straight through.
 */
export async function* withStatus(
  source: AsyncGenerator<string>,
  thresholdMs = HIGH_LOAD_AFTER_MS,
): AsyncGenerator<string> {
  const first = source.next();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<"late">((r) => {
    timeout = setTimeout(() => r("late"), thresholdMs);
  });
  const winner = await Promise.race([first, timer]).finally(() => clearTimeout(timeout));
  if (winner === "late")
    yield `2:${pythonJson([{ type: "high_load", message: "High demand. Still working on your request..." }])}\n`;
  const r = await first;
  if (r.done) return;
  yield r.value;
  yield* source;
}

/** The AI SDK data protocol lines the portal parses: "0:" text, "3:" an error. */
export async function* replyProtocol(d: ReplyDeps, conversationId: string, language: string) {
  try {
    for await (const text of generateReply(d, conversationId, language))
      yield `0:${pythonJson(text)}\n`;
  } catch (err) {
    // Not the error itself: the model SDK's errors carry the request body (the transcript).
    const e = err as { name?: unknown; statusCode?: unknown } | null;
    d.logger.error(
      {
        error: {
          name: typeof e?.name === "string" ? e.name : "Error",
          status: typeof e?.statusCode === "number" ? e.statusCode : null,
        },
        conversationId,
      },
      "error generating reply",
    );
    yield `3:${pythonJson(err instanceof ContentPolicyError ? "CONTENT_POLICY_VIOLATION" : "Something went wrong.")}\n`;
  }
}
