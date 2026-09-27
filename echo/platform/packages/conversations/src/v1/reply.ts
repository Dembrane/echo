import { isoTimestamp } from "@echo/legacy-shape";
import { renderPrompt } from "@echo/prompts";
import { pythonJson } from "@echo/webhooks";
import { type FilePart, streamText, type TextPart } from "ai";
import type { ConversationsDeps } from "../deps";
import { type V1Store, v1Store } from "./storage";
import { countTokens } from "./token-count";

/**
 * The portal's "get reply" (reply_utils.py): the participant's conversation so far, the
 * project's other conversations (summaries or truncated transcripts, within a token
 * budget) and any audio not transcribed yet go to multi_modal_pro with the project's
 * reply prompt; the answer streams back and is stored as a conversation_reply.
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

/** A Conversation model needs a string name; a null participant name failed validation. */
function named(name: string | null, id: string): string {
  if (typeof name !== "string") throw new Error(`conversation ${id} has no participant name`);
  return name;
}

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
        name: named(row.participant_name, row.id),
        tags: tagsOf(row.id),
        transcript: row.summary,
      });
      candidates.push([f, countTokens(f)]);
      continue;
    }
    const content = await store.adjacentContent(row.id);
    const c: Conv = {
      name: named(row.participant_name, row.id),
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
    name: named(conv.participant_name, conv.id),
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
  const others = await adjacentConversations(store, project.id, conv.id, useSummaries);

  const description: string[] = [];
  if (project.context !== null) description.push(project.context);
  if (project.default_conversation_title !== null)
    description.push(`Default Conversation Title: ${project.default_conversation_title}`);
  if (project.default_conversation_description !== null)
    description.push(
      `Default Conversation Description: ${project.default_conversation_description}`,
    );
  if (project.default_conversation_transcript_prompt !== null)
    description.push(
      `Default Conversation Transcript Prompt: ${project.default_conversation_transcript_prompt}`,
    );

  let globalPrompt: string;
  if (mode === "summarize") globalPrompt = renderPrompt("get_reply_summarize", language, {});
  else if (mode === "brainstorm") globalPrompt = renderPrompt("get_reply_brainstorm", language, {});
  else if (mode === "custom")
    globalPrompt = project.get_reply_prompt?.trim()
      ? project.get_reply_prompt
      : renderPrompt("get_reply_summarize", language, {});
  else globalPrompt = project.get_reply_prompt ?? "";

  const prompt = renderPrompt("get_reply_system", language, {
    PROJECT_DESCRIPTION: description.join("\n\n"),
    GLOBAL_PROMPT: globalPrompt,
    OTHER_TRANSCRIPTS: others,
    MAIN_USER_TRANSCRIPT: formatConversation(current),
    pii_redaction: Boolean(project.anonymize_transcripts),
  });

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

  const result = streamText({
    model: d.models.model("multi_modal_pro"),
    messages: [{ role: "user", content }],
    maxRetries: 0,
    providerOptions: { google: { thinkingConfig: { thinkingBudget: 2048 } } },
  });
  let answer = "";
  for await (const part of result.fullStream) {
    if (part.type === "text-delta" && part.text) {
      answer += part.text;
      yield part.text;
    } else if (part.type === "error") throw part.error;
    else if (part.type === "finish" && part.finishReason === "content-filter" && !answer)
      throw new ContentPolicyError("content policy violation");
  }
  await store.storeReply(conversationId, answer.trim(), d.now());
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
    d.logger.error({ err, conversationId }, "error generating reply");
    yield `3:${pythonJson(err instanceof ContentPolicyError ? "CONTENT_POLICY_VIOLATION" : "Something went wrong.")}\n`;
  }
}
