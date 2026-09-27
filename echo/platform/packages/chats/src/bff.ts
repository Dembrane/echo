import { BadRequestError, NotFoundError } from "@echo/core";
import type { Signed } from "@echo/http";
import { projectFor } from "@echo/projects";
import { chatFor } from "./access";
import type { ChatDeps } from "./deps";
import { FREE_TIER_MAX_CHATS, freeTierLimit, isFreeTier } from "./tiers";

/**
 * The chat BFF (/api/v2/bff/chats, /api/v2/bff/chat-messages). chat:use gates every route,
 * writes that change a chat or remove a message also need project:update. The BFF never
 * had the staff bypass the v1 routes have.
 */
const bffChat = (d: ChatDeps, who: Signed, chatId: string) =>
  chatFor({ access: d.access, store: d.store }, who, chatId, { staffBypass: false });

export async function createChat(
  d: ChatDeps,
  who: Signed,
  body: { project_id: string; name: string | null },
) {
  const access = await projectFor(d.access, who, body.project_id, "chat:use");
  if (
    isFreeTier(access.tier) &&
    (await d.reads.workspaceChatsWithUserMessages(access.project.workspaceId)) >=
      FREE_TIER_MAX_CHATS
  )
    throw freeTierLimit("chats");
  const id = d.newId();
  // The Python API wrote through the admin token, so Directus stamped the service account
  // as the creator. The creator is who created it: private chats and "is_own" read this.
  await d.store.insertChat({
    id,
    projectId: body.project_id,
    ...(body.name !== null && { name: body.name }),
    userCreated: who.directusUserId,
    now: d.now(),
  });
  return (await d.store.chatItem(id)) ?? {};
}

export async function listChats(
  d: ChatDeps,
  who: Signed,
  q: { project_id: string; limit: number; offset: number; has_messages: boolean; q: string | null },
) {
  await projectFor(d.access, who, q.project_id, "chat:use");
  const { rows, total } = await d.store.listChats({
    projectId: q.project_id,
    hasMessages: q.has_messages,
    search: (q.q ?? "").trim(),
    limit: q.limit,
    offset: q.offset,
    // Spec M-10: a colleague's private chat is not listed.
    visibleTo: who.directusUserId,
  });
  return { chats: rows, total };
}

export async function getChat(d: ChatDeps, who: Signed, chatId: string) {
  await bffChat(d, who, chatId);
  const item = await d.store.chatItem(chatId);
  if (!item) throw new NotFoundError("Chat not found");
  return {
    id: item.id,
    name: item.name ?? null,
    project_id: item.project_id ?? null,
    chat_mode: item.chat_mode ?? null,
    date_created: item.date_created ?? null,
    date_updated: item.date_updated ?? null,
  };
}

export async function updateChat(
  d: ChatDeps,
  who: Signed,
  chatId: string,
  body: { name: string | null; chat_mode: string | null },
) {
  const { chat } = await bffChat(d, who, chatId);
  await projectFor(d.access, who, chat.project_id?.id ?? "", "project:update");
  const values: Record<string, unknown> = {};
  if (body.name !== null) values.name = body.name;
  if (body.chat_mode !== null) values.chat_mode = body.chat_mode;
  if (!Object.keys(values).length) throw new BadRequestError("No fields to update");
  await d.store.updateChat(chatId, values, who.directusUserId, d.now());
  return (await d.store.chatItem(chatId)) ?? {};
}

export async function listMessages(d: ChatDeps, who: Signed, chatId: string, limit: number) {
  await bffChat(d, who, chatId);
  return d.store.bffMessages(chatId, limit);
}

/**
 * Stores a message. message_from stays free text (spec L-5 is left open): the dashboard
 * writes the assistant's streamed reply through here, because POST /api/chats/{id} does
 * not store it, so refusing "assistant" would lose every reply.
 */
export async function createMessage(
  d: ChatDeps,
  who: Signed,
  body: {
    project_chat_id: string;
    message_from: string;
    text: string;
    template_key: string | null;
  },
) {
  await bffChat(d, who, body.project_chat_id);
  const id = d.newId();
  await d.store.createMessage({
    id,
    chatId: body.project_chat_id,
    from: body.message_from,
    text: body.text,
    templateKey: body.template_key,
    now: d.now(),
  });
  return (await d.store.messageItem(id)) ?? {};
}

export async function deleteMessage(d: ChatDeps, who: Signed, messageId: string) {
  const msg = await d.store.message(messageId);
  if (!msg?.project_chat_id) throw new NotFoundError("Message not found");
  const { chat } = await bffChat(d, who, (msg as { project_chat_id: string }).project_chat_id);
  await projectFor(d.access, who, chat.project_id?.id ?? "", "project:update");
  await d.store.deleteMessage(messageId);
  return { status: "deleted" };
}
