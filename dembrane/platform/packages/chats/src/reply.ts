import { BadRequestError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { streamText } from "ai";
import { chatFor, chatProjectId } from "./access";
import { chatContext } from "./context";
import type { ChatDeps } from "./deps";
import { generateTitle } from "./llm";
import { systemMessagesForChat } from "./prompt";
import { FREE_TIER_MAX_CHAT_USER_TURNS, freeTierLimit, isFreeTier } from "./tiers";

export interface ReplyBody {
  messages: { role: "user" | "assistant" | "dembrane"; content: string }[];
  template_key: string | null;
}

/** json.dumps of a string: non-ASCII escaped as \uXXXX, as the dashboard's parser has always seen it. */
export function asciiJson(s: string): string {
  return JSON.stringify(s).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const HIGH_LOAD =
  '2:[{"type": "high_load", "message": "High demand. Still working on your request..."}]\n';

/** The analytics distinct id: the app user's email, lowercased, or the Directus user id. */
export async function distinctIdFor(
  reads: { appUserEmail(id: string): Promise<string | null> },
  directusUserId: string,
): Promise<string> {
  const email = await reads.appUserEmail(directusUserId).catch(() => null);
  return email?.toLowerCase() || directusUserId;
}

/**
 * POST /api/chats/{id}: a non-agentic reply, streamed. The host's message is stored first
 * and removed again when the reply fails, so a failed turn leaves nothing behind. The
 * reply itself is not stored here; the dashboard writes it through the chat BFF.
 * `protocol=data` speaks the Vercel AI data stream ("0:" text parts, "2:" status, "3:"
 * error); `protocol=text` sends bare text.
 */
export async function reply(
  d: ChatDeps,
  who: Signed,
  chatId: string,
  body: ReplyBody,
  protocol: string,
  language: string,
): Promise<Response> {
  const { chat, access } = await chatFor({ access: d.access, store: d.store }, who, chatId, {
    withUsed: true,
  });
  if (chat.chat_mode === "agentic") throw new BadRequestError("chat.agentic_endpoint_required");
  const projectId = chatProjectId(chat);
  if (!projectId) throw new Error("Chat is missing a project reference");
  // The turn cap leaves a sample copy's chats alone, as the chat allowance does.
  if (
    !access.project.isSample &&
    isFreeTier(await d.reads.projectTier(projectId)) &&
    (await d.store.countUserTurns(chatId)) >= FREE_TIER_MAX_CHAT_USER_TURNS
  )
    throw freeTierLimit("chat_turns");

  const last = body.messages[body.messages.length - 1];
  if (!last) throw new Error("list index out of range");
  const messageId = d.newId();
  await d.store.createMessage({
    id: messageId,
    chatId,
    from: "user",
    text: last.content,
    now: d.now(),
  });

  let formatted: { role: "system" | "user" | "assistant"; content: string }[];
  try {
    const [history, ctx, title] = await Promise.all([
      d.store.messages(chatId, { withRelations: false, order: "asc" }),
      chatContext(d, who, chat),
      chat.name ? Promise.resolve(null) : generateTitle(d.models, last.content, language),
    ]);
    await Promise.all([
      title ? d.store.setChatName(chatId, title, d.now()) : null,
      body.template_key !== null
        ? d.store.updateMessage(messageId, { template_key: body.template_key }, d.now())
        : null,
    ]);
    let convo = history
      .filter((m) => m.message_from === "user" || m.message_from === "assistant")
      .map((m) => ({
        role: m.message_from as "user" | "assistant",
        content: (m.text as string | null) ?? "",
      }));
    const n = convo.length;
    if (
      n >= 2 &&
      convo[n - 2]?.role === "user" &&
      convo[n - 1]?.role === "user" &&
      convo[n - 2]?.content === convo[n - 1]?.content
    )
      convo = convo.slice(0, -1);
    const system = await systemMessagesForChat(
      d,
      ctx.conversation_id_list,
      language,
      projectId,
      ctx.chat_mode,
    );
    formatted = [...system.map((content) => ({ role: "system" as const, content })), ...convo];
  } catch (err) {
    await d.store.deleteMessage(messageId);
    throw err;
  }

  const distinctId = await distinctIdFor(d.reads, who.directusUserId);
  const enc = new TextEncoder();
  const headers: Record<string, string> = { "Content-Type": "text/event-stream" };
  if (protocol === "data") headers["x-vercel-ai-data-stream"] = "v1";

  // The host pressing Stop cancels the body; that ends the turn, it is not a failure.
  const stop = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      stop.abort();
    },
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s));
      let first = false;
      const timer =
        protocol === "data"
          ? setTimeout(() => {
              if (!first && !stop.signal.aborted) send(HIGH_LOAD);
            }, d.highLoadDelayMs)
          : undefined;
      try {
        const res = streamText({
          model: d.models.model("multi_modal_pro"),
          messages: formatted,
          allowSystemInMessages: true,
          timeout: 300_000,
          abortSignal: stop.signal,
          // Errors arrive as stream parts and are handled below; the default handler only prints.
          onError: () => {},
        });
        for await (const part of res.fullStream) {
          if (part.type === "error") throw part.error;
          if (part.type !== "text-delta" || !part.text) continue;
          first = true;
          send(protocol === "text" ? part.text : `0:${asciiJson(part.text)}\n`);
        }
        await d.capture(distinctId, "server_chat_response_received", {
          chat_id: chatId,
          project_id: projectId,
          mode: "context",
        });
      } catch (err) {
        if (stop.signal.aborted) return;
        d.logger.error({ err, chatId }, "chat reply stream failed");
        await d.capture(distinctId, "server_chat_error", {
          chat_id: chatId,
          project_id: projectId,
          error_code: "STREAM_ERROR",
          message: String((err as Error)?.message ?? err).slice(0, 300),
          mode: "context",
        });
        await d.store.deleteMessage(messageId).catch(() => {});
        first = true;
        send(
          protocol === "text"
            ? "Error: An error occurred while processing the chat response."
            : '3:"An error occurred while processing the chat response."\n',
        );
      } finally {
        clearTimeout(timer);
        if (!stop.signal.aborted) controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers });
}
