import { chatsStorage } from "@echo/chats";
import { NotFoundError } from "@echo/core";
import type { Signed } from "@echo/http";
import { projectFor } from "@echo/projects";
import { agentProject } from "../access";
import { type DataDeps, isUuid, projectRow, type Row, row, sqlOf, text } from "./deps";

/**
 * Projects of a workspace the caller may read, for the workspace-wide chat listing: the
 * same ladder every project read uses, so a private project the caller is not on never
 * contributes chats. Staff see every live project of the workspace.
 */
async function visibleProjectIds(d: DataDeps, who: Signed, workspaceId: string) {
  const rows = await sqlOf(d)`
    select id from project where workspace_id = ${workspaceId} and deleted_at is null order by id`;
  const ids = rows.map((r) => String(r.id));
  if (who.isStaff) return ids;
  const out: string[] = [];
  for (const id of ids)
    if (
      await d.access.project(who, id, "project:read").then(
        () => true,
        () => false,
      )
    )
      out.push(id);
  return out;
}

/**
 * GET /agentic/projects/{p}/chats: earlier chats the assistant may build on, newest
 * activity first. Private chats of other people are left out in both modes (staff see all).
 */
export async function chats(
  d: DataDeps,
  who: Signed,
  projectId: string,
  limit: number,
  workspaceWide: boolean,
) {
  await agentProject(d.access, who, projectId);
  let projectIds = [projectId];
  if (workspaceWide) {
    const project = await projectRow(d, projectId);
    const workspaceId = text(project?.workspace_id);
    if (workspaceId) {
      projectIds = await visibleProjectIds(d, who, workspaceId);
      if (!projectIds.length) return [];
    }
  }
  const valid = projectIds.filter((id) => isUuid(id));
  if (!valid.length) return [];
  const sql = sqlOf(d);
  const rows = await sql`
    select id, name, chat_mode, is_private, user_created, date_updated, project_id
    from project_chat
    where project_id = any(${valid}) and deleted_at is null
      ${
        who.isStaff
          ? sql``
          : sql`and (is_private is distinct from true or user_created = ${who.directusUserId})`
      }
    order by date_updated desc
    limit ${limit}`;
  return rows.map((raw) => {
    const r = row(raw as Row);
    return {
      id: r.id ?? null,
      name: r.name ?? null,
      chat_mode: r.chat_mode ?? null,
      is_private: Boolean(r.is_private),
      is_own: r.user_created === who.directusUserId,
      date_updated: r.date_updated ?? null,
      project_id: r.project_id ?? null,
    };
  });
}

/**
 * GET /agentic/chats/{id}/messages: an earlier chat in order. A private chat of someone
 * else answers 404, as if it did not exist.
 */
export async function chatMessages(d: DataDeps, who: Signed, chatId: string, limit: number) {
  const chat = await chatsStorage(d.db).chat(chatId);
  if (!chat || chat.deleted_at || !chat.project_id) throw new NotFoundError("Chat not found");
  await projectFor(d.access, who, chat.project_id.id, "chat:use");
  if (!who.isStaff && chat.is_private && chat.user_created !== who.directusUserId)
    throw new NotFoundError("Chat not found");
  const rows = await sqlOf(d)`
    select message_from, text, date_created from project_chat_message
    where project_chat_id = ${chatId} order by date_created asc limit ${limit}`;
  return rows.map((raw) => {
    const r = row(raw as Row);
    return {
      message_from: r.message_from ?? null,
      text: r.text ?? null,
      date_created: r.date_created ?? null,
    };
  });
}
