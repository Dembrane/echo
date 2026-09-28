import type { Policy, ProjectAccess } from "@dembrane/access";
import { NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectFor } from "@dembrane/http";
import type { ConversationsDeps } from "./deps";
import { type ConversationRow, conversationStore, isUuid } from "./storage";

/**
 * The conversation access checks of the Python API, decided by @dembrane/access. Two
 * surfaces word them differently and the dashboard shows the words:
 *   BFF (resolve_conversation_access): the conversation must exist and not be deleted
 *     (404 "Conversation not found"), then project access with conversation:read, then
 *     the route's policy (403 "Not allowed", or the tier message).
 *   v1 (raise_if_conversation_not_found_or_not_authorized): the same, except staff skip
 *     the project check and only need the conversation to exist.
 */
export interface ConversationAccess {
  readonly conversation: ConversationRow;
  /** Null for staff on a v1 route: they passed without a project role. */
  readonly project: ProjectAccess | null;
}

export async function conversationForBff(
  d: Pick<ConversationsDeps, "db" | "access">,
  who: Signed,
  conversationId: string,
  policy?: Policy,
): Promise<ConversationAccess & { project: ProjectAccess }> {
  const conv = await conversationStore(d.db).conversation(conversationId);
  if (!conv) throw new NotFoundError("Conversation not found");
  const project = await projectFor(d.access, who, conv.project_id, "conversation:read");
  if (policy && policy !== "conversation:read")
    await projectFor(d.access, who, conv.project_id, policy);
  return { conversation: conv, project };
}

export async function conversationForV1(
  d: Pick<ConversationsDeps, "db" | "access">,
  who: Signed,
  conversationId: string,
  policy?: Policy,
): Promise<ConversationAccess> {
  if (who.isStaff) {
    const conv = await conversationStore(d.db).conversation(conversationId);
    if (!conv) throw new NotFoundError("Conversation not found");
    return { conversation: conv, project: null };
  }
  return conversationForBff(d, who, conversationId, policy);
}

export { isUuid };
