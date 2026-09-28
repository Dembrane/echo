import { BadRequestError, NotFoundError, newId } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { agentProject } from "../access";
import { type DataDeps, isUuid, projectRow, type Row, row, sqlOf, text } from "./deps";

export const INSIGHT_KINDS = ["capability_gap", "friction", "wish", "praise"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];
const SOURCE_ASSISTANT = "assistant";

/**
 * A chat named on a row this project owns must be a live chat of this project (spec L-3:
 * the ids were stored as given, so a ticket or insight could point at another tenant's
 * chat). Absent means none.
 */
export async function requireProjectChat(d: DataDeps, projectId: string, chatId: string | null) {
  if (chatId === null) return;
  const [c] = isUuid(chatId)
    ? await sqlOf(d)`
        select id from project_chat
        where id = ${chatId} and project_id = ${projectId} and deleted_at is null`
    : [];
  if (!c) throw new NotFoundError("Chat not found");
}

/** POST /agentic/projects/{p}/support-request: an outbox row the support forwarder sends on. */
export async function supportRequest(
  d: DataDeps,
  who: Signed,
  projectId: string,
  body: {
    message: string;
    page_context?: string | null;
    chat_id?: string | null;
    message_id?: string | null;
  },
) {
  await agentProject(d.access, who, projectId);
  const project = await projectRow(d, projectId);
  const chatId = body.chat_id ?? null;
  await requireProjectChat(d, projectId, chatId);
  const id = newId();
  await sqlOf(d)`
    insert into support_request (id, source, directus_user_id, app_user_id, workspace_id,
      project_id, chat_id, message_id, message, page_context, status, created_at)
    values (${id}, 'assistant', ${who.directusUserId}, ${who.appUserId},
      ${text(project?.workspace_id)}, ${projectId}, ${chatId}, ${body.message_id ?? null},
      ${body.message}, ${body.page_context ?? null}, 'new', ${d.now().toISOString()})`;
  return { id, status: "new" };
}

/** POST /agentic/projects/{p}/insight: a quiet product-learning note from an assistant turn. */
export async function noteInsight(
  d: DataDeps,
  who: Signed,
  projectId: string,
  body: {
    kind: string;
    content: string;
    suggested_capability?: string | null;
    chat_id?: string | null;
    message_id?: string | null;
  },
) {
  await agentProject(d.access, who, projectId);
  const content = body.content.trim();
  if (!content) throw new BadRequestError("content is required");
  const suggested = text(body.suggested_capability);
  const project = await projectRow(d, projectId);
  const chatId = body.chat_id ?? null;
  await requireProjectChat(d, projectId, chatId);
  const id = newId();
  await sqlOf(d)`
    insert into agent_insight (id, source, workspace_id, project_id, chat_id, message_id, kind,
      content, suggested_capability, status, created_at)
    values (${id}, ${SOURCE_ASSISTANT}, ${text(project?.workspace_id)}, ${projectId}, ${chatId},
      ${body.message_id ?? null}, ${body.kind}, ${content}, ${suggested}, 'new',
      ${d.now().toISOString()})`;
  return { id, status: "new" };
}

async function insightOr404(d: DataDeps, id: string): Promise<Row> {
  if (!isUuid(id)) throw new NotFoundError("Insight not found");
  const [r] = await sqlOf(d)`select * from agent_insight where id = ${id}`;
  if (!r) throw new NotFoundError("Insight not found");
  return row(r as Row);
}

/** The insight's project is the data boundary: the caller must reach it. */
async function ownedInsight(d: DataDeps, who: Signed, id: string) {
  const insight = await insightOr404(d, id);
  const projectId = text(insight.project_id);
  if (!projectId) throw new NotFoundError("Insight not found");
  await agentProject(d.access, who, projectId);
  return insight;
}

const payload = (r: Row) => ({
  id: text(r.id),
  kind: r.kind ?? null,
  content: r.content ?? null,
  suggested_capability: r.suggested_capability ?? null,
  status: r.status ?? null,
  retracted_reason: r.retracted_reason ?? null,
});

/** PATCH /agentic/insights/{id}: a partial amendment; at least one field must be given. */
export async function editInsight(
  d: DataDeps,
  who: Signed,
  insightId: string,
  body: { content?: string | null; kind?: string | null; suggested_capability?: string | null },
) {
  await ownedInsight(d, who, insightId);
  const updates: Record<string, string | null> = {};
  if (body.content !== null && body.content !== undefined) {
    const content = body.content.trim();
    if (!content) throw new BadRequestError("content cannot be blank");
    updates.content = content;
  }
  if (body.kind !== null && body.kind !== undefined) updates.kind = body.kind;
  if (body.suggested_capability !== null && body.suggested_capability !== undefined)
    updates.suggested_capability = text(body.suggested_capability);
  if (!Object.keys(updates).length)
    throw new BadRequestError("Provide at least one of content, kind, or suggested_capability.");
  const sql = sqlOf(d);
  await sql`update agent_insight set ${sql(updates)} where id = ${insightId}`;
  return payload(await insightOr404(d, insightId));
}

/**
 * POST /agentic/insights/{id}/retract: never deletes, because the team may already have
 * read it; the withdrawal and its reason are signal too.
 */
export async function retractInsight(d: DataDeps, who: Signed, insightId: string, reason: string) {
  await ownedInsight(d, who, insightId);
  const trimmed = reason.trim();
  if (!trimmed) throw new BadRequestError("reason is required");
  // agent_insight has no retracted_reason column: Directus dropped the reason, so only the
  // status moves. The reason stays in the tool call the chat already shows.
  await sqlOf(d)`update agent_insight set status = 'retracted' where id = ${insightId}`;
  return payload(await insightOr404(d, insightId));
}

/** POST /agentic/insights/{id}/dismiss: the host clearing their own view; the row stays. */
export async function dismissInsight(d: DataDeps, who: Signed, insightId: string) {
  await ownedInsight(d, who, insightId);
  await sqlOf(d)`update agent_insight set status = 'archived' where id = ${insightId}`;
  return payload(await insightOr404(d, insightId));
}

/** Insights dismissed in a project, so a reloaded chat keeps showing them as removed. */
export async function dismissedInsights(d: DataDeps, who: Signed, projectId: string) {
  await agentProject(d.access, who, projectId);
  const rows = await sqlOf(d)`
    select id from agent_insight where project_id = ${projectId} and status = 'archived'
    order by id`;
  return { project_id: projectId, insight_ids: rows.map((r) => String(r.id)) };
}

/** Insights already sent in a project (optionally one chat), so a card cannot be sent twice. */
export async function sentInsights(
  d: DataDeps,
  who: Signed,
  projectId: string,
  chatId: string | null,
) {
  await agentProject(d.access, who, projectId);
  const sql = sqlOf(d);
  const rows = await sql`
    select id, kind, content, suggested_capability, chat_id, message_id, status
    from agent_insight
    where project_id = ${projectId} ${chatId ? sql`and chat_id = ${chatId}` : sql``}
    order by id`;
  return { project_id: projectId, insights: rows.map((r) => ({ ...r })) };
}
