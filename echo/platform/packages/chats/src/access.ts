import type { Access, Policy, ProjectAccess } from "@dembrane/access";
import { NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectFor } from "@dembrane/projects";
import type { ChatRow, ChatsStorage } from "./storage";

export interface ChatAccessDeps {
  readonly access: Access;
  readonly store: ChatsStorage;
}

/**
 * The chat gate shared by the v1 chat routes, the chat BFF and the agentic reads: the chat
 * must exist and be live, and the caller needs chat:use on its project (plus `require`
 * when given). The old v1 routes let staff bypass the ladder (spec H-14); staff now reach a
 * tenant's chats only through a support session. A missing chat, a colleague's private
 * chat and a chat the caller cannot reach answer 404.
 */
export async function chatFor(
  d: ChatAccessDeps,
  who: Signed,
  chatId: string,
  opts: { withUsed?: boolean; require?: Policy } = {},
): Promise<{ chat: ChatRow; access: ProjectAccess }> {
  const chat = await d.store.chat(chatId, opts.withUsed ?? false);
  if (!chat || chat.deleted_at) throw new NotFoundError("Chat not found");
  if (!chat.project_id) throw new NotFoundError("Chat not found");
  const access = await projectFor(d.access, who, chat.project_id.id, "chat:use");
  // Spec M-10: a private chat is its creator's. The old v1 and BFF routes let any member
  // read and post into it; the agentic routes already hid it. Hidden means 404, so its
  // existence is not confirmed.
  if (chat.is_private && chat.user_created !== who.directusUserId)
    throw new NotFoundError("Chat not found");
  if (opts.require) await projectFor(d.access, who, chat.project_id.id, opts.require);
  return { chat, access };
}

/** The chat's project id, or null for an orphaned chat. */
export const chatProjectId = (chat: ChatRow): string | null => chat.project_id?.id ?? null;
