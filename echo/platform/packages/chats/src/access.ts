import type { Access, Policy, ProjectAccess } from "@echo/access";
import { NotFoundError } from "@echo/core";
import type { Signed } from "@echo/http";
import { projectFor } from "@echo/projects";
import type { ChatRow, ChatsStorage } from "./storage";

export interface ChatAccessDeps {
  readonly access: Access;
  readonly store: ChatsStorage;
}

/**
 * The chat gate shared by the v1 chat routes, the chat BFF and the agentic reads: the chat
 * must exist and be live, and the caller needs chat:use on its project (plus `require`
 * when given). Staff bypass the ladder, as the old API's admin bypass did, and get no
 * ProjectAccess back. A missing chat and a chat the caller cannot reach both answer 404.
 */
export async function chatFor(
  d: ChatAccessDeps,
  who: Signed,
  chatId: string,
  opts: { withUsed?: boolean; require?: Policy } = {},
): Promise<{ chat: ChatRow; access: ProjectAccess | null }> {
  const chat = await d.store.chat(chatId, opts.withUsed ?? false);
  if (!chat || chat.deleted_at) throw new NotFoundError("Chat not found");
  if (who.isStaff) return { chat, access: null };
  if (!chat.project_id) throw new NotFoundError("Chat not found");
  const access = await projectFor(d.access, who, chat.project_id.id, "chat:use");
  if (opts.require) await projectFor(d.access, who, chat.project_id.id, opts.require);
  return { chat, access };
}

/** The chat's project id, or null for an orphaned chat. */
export const chatProjectId = (chat: ChatRow): string | null => chat.project_id?.id ?? null;
