import type { ProjectAccess } from "@dembrane/access";
import { chatsStorage } from "@dembrane/chats";
import { BadRequestError, NotFoundError, UnavailableError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectFor } from "@dembrane/projects";
import { agentProject } from "../access";
import { type DataDeps, isUuid, projectRow, type Row, row, sqlOf, text } from "./deps";
import { conversationLocked, stampLocked, workspaceOverCapActive } from "./locks";

// Keyword search: words shorter than this are noise ("the", "and"); at most this many
// distinct words are searched.
const MIN_TOKEN_LENGTH = 4;
const MAX_QUERY_TOKENS = 4;
const SNIPPET_CONTEXT = 80;
const MATCHES_PER_CONVERSATION = 3;
// The search scans a bounded window of matching chunks instead of counting them, so a
// page deep into a large project may end early; has_more is exact within the window.
const CHUNK_SCAN_PER_CONVERSATION = 25;
const CHUNK_SCAN_MIN = 25;
const CHUNK_SCAN_MAX = 1000;

/** Lower-case alphanumeric words of four letters or more, deduplicated, in query order. */
export function queryTokens(query: string): string[] {
  const out: string[] = [];
  for (const t of query.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (t.length < MIN_TOKEN_LENGTH || out.includes(t)) continue;
    out.push(t);
    if (out.length >= MAX_QUERY_TOKENS) break;
  }
  return out;
}

/** Context either side of the first token found, with ellipses where it was cut. */
export function snippet(textIn: string, tokens: readonly string[]): string {
  const chars = Array.from(textIn);
  const lowered = Array.from(textIn.toLowerCase());
  const hay = lowered.join("");
  for (const token of tokens) {
    const at = hay.indexOf(token);
    if (at < 0) continue;
    const offset = Array.from(hay.slice(0, at)).length;
    const start = Math.max(0, offset - SNIPPET_CONTEXT);
    const end = Math.min(chars.length, offset + token.length + SNIPPET_CONTEXT);
    let s = chars.slice(start, end).join("").trim();
    if (start > 0 && s) s = `...${s}`;
    if (end < chars.length && s) s = `${s}...`;
    return s;
  }
  return Array.from(textIn.trim())
    .slice(0, SNIPPET_CONTEXT * 2)
    .join("")
    .trim();
}

function status(conv: Row): string {
  if (!conv.is_finished) return "live";
  if (!conv.is_all_chunks_transcribed) return "processing";
  return "done";
}

/** The assistant's conversation card; key names and order are the dashboard's contract. */
function card(conv: Row, locked: boolean) {
  return {
    conversation_id: String(conv.id),
    participant_name: text(conv.participant_name),
    status: status(conv),
    summary: locked ? null : typeof conv.summary === "string" ? conv.summary : null,
    started_at: text(conv.created_at),
    last_chunk_at: text(conv.updated_at),
  };
}

/** Tier and live cap of the project the caller reached; staff read as legacy (never locked). */
async function gate(d: DataDeps, access: ProjectAccess | null) {
  const tier = access?.tier ?? null;
  const workspaceId = access?.project.workspaceId ?? null;
  return { tier, overCap: await workspaceOverCapActive(d, workspaceId, tier) };
}

/**
 * GET /agentic/projects/{p}/conversations: the listing (newest activity first) or, with a
 * transcript_query, the keyword search. limit is a per-call cap of 100 and offset makes it
 * a page. A query with no usable word answers the short no-search shape.
 */
export async function conversations(
  d: DataDeps,
  who: Signed,
  projectId: string,
  q: {
    limit: number;
    offset?: number;
    conversationId?: string | null;
    transcriptQuery?: string | null;
  },
) {
  if (!(await projectRow(d, projectId))) throw new NotFoundError("Project not found");
  const access = await agentProject(d.access, who, projectId);
  const limit = Math.max(1, Math.min(q.limit, 100));
  const offset = Math.max(0, q.offset ?? 0);
  const conversationId = text(q.conversationId);
  const query = text(q.transcriptQuery);
  const { tier, overCap } = await gate(d, access);
  const sql = sqlOf(d);

  if (query !== null) {
    const tokens = queryTokens(query);
    if (!tokens.length) return { project_id: projectId, count: 0, conversations: [] };
    if (conversationId !== null && !isUuid(conversationId))
      return { project_id: projectId, count: 0, offset, has_more: false, conversations: [] };
    const wanted = limit + offset;
    const scan = Math.min(
      Math.max(wanted * CHUNK_SCAN_PER_CONVERSATION, CHUNK_SCAN_MIN),
      CHUNK_SCAN_MAX,
    );
    const any = tokens
      .flatMap((t) => [
        sql`ch.transcript ilike ${`%${t}%`}`,
        sql`ch.raw_transcript ilike ${`%${t}%`}`,
      ])
      .reduce((a, b) => sql`${a} or ${b}`);
    const rows = await sql`
      select ch.id as chunk_id, ch.timestamp, ch.created_at as chunk_created_at, ch.transcript,
             ch.raw_transcript, c.id, c.project_id, c.title, c.participant_name, c.summary,
             c.source, c.duration, c.is_finished, c.is_all_chunks_transcribed, c.is_over_cap,
             c.created_at, c.updated_at
      from conversation_chunk ch join conversation c on c.id = ch.conversation_id
      where c.project_id = ${projectId} and c.deleted_at is null and (${any})
        ${conversationId ? sql`and c.id = ${conversationId}` : sql``}
      order by ch.timestamp desc, ch.created_at desc
      limit ${scan}`;
    const hits = new Map<
      string,
      { card: ReturnType<typeof card>; locked: boolean; matches: Row[] }
    >();
    for (const raw of rows) {
      const r = row(raw as Row);
      const cid = String(r.id);
      let hit = hits.get(cid);
      if (!hit) {
        // One conversation past the page is the has_more probe.
        if (hits.size > wanted) continue;
        const locked = conversationLocked(r, tier, overCap);
        hit = { card: card(r, locked), locked, matches: [] };
        hits.set(cid, hit);
      }
      if (hit.locked) continue;
      if (hit.matches.length < MATCHES_PER_CONVERSATION) {
        const t = text(r.transcript) ?? text(r.raw_transcript);
        const chunkId = text(r.chunk_id);
        if (t && chunkId)
          hit.matches.push({
            chunk_id: chunkId,
            timestamp: text(r.timestamp) ?? text(r.chunk_created_at) ?? "",
            snippet: snippet(t, tokens),
          });
      }
    }
    const matched = [...hits.values()];
    const page = matched.slice(offset, offset + limit);
    const cards = page.map((h) => ({ ...h.card, matches: h.matches }));
    return {
      project_id: projectId,
      count: cards.length,
      offset,
      has_more: matched.length > offset + page.length,
      conversations: cards,
    };
  }

  const rows =
    conversationId !== null && !isUuid(conversationId)
      ? []
      : await sql`
          select id, project_id, title, participant_name, summary, source, duration, is_finished,
                 is_all_chunks_transcribed, is_over_cap, created_at, updated_at
          from conversation
          where project_id = ${projectId} and deleted_at is null
            ${conversationId ? sql`and id = ${conversationId}` : sql``}
          order by updated_at desc
          limit ${limit + 1} offset ${offset}`;
  const list = rows.map((r) => row(r as Row));
  const cards = list.slice(0, limit).map((r) => card(r, conversationLocked(r, tier, overCap)));
  return {
    project_id: projectId,
    count: cards.length,
    offset,
    has_more: list.length > limit,
    conversations: cards,
  };
}

/**
 * A chat id the caller supplied, bound to the project already authorised before anything
 * reads it: a chat that cannot be loaded answers 503, one of another project 400.
 */
export async function requireChatOfProject(d: DataDeps, chatId: string, projectId: string | null) {
  const chat = await chatsStorage(d.db).chat(chatId, true);
  if (!chat)
    throw new UnavailableError("Could not verify the chat for this request. Please try again.");
  if (!projectId) throw new BadRequestError("project_id is required to read this chat");
  if (chat.project_id?.id !== projectId)
    throw new BadRequestError("project_id does not match this chat");
  return chat;
}

/**
 * The conversations the host focused a chat on, in the host's order, each once, without
 * soft-deleted ones (the assistant cannot read those, so pointing it there sends it after
 * context it cannot reach).
 */
export async function focusedList(d: DataDeps, chatId: string | null, projectId: string) {
  if (!chatId) return [];
  const chat = await chatsStorage(d.db).chat(chatId, true);
  if (!chat) return [];
  if (chat.project_id?.id !== projectId)
    throw new BadRequestError("project_id does not match this chat");
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const link of chat.used_conversations ?? []) {
    const ref = link.conversation_id;
    const id = text(ref?.id);
    if (!ref || !id || seen.has(id) || ref.deleted_at) continue;
    seen.add(id);
    out.push({ id, name: text(ref.participant_name) ?? "" });
  }
  return out;
}

/** GET /agentic/projects/{p}/focused-conversations: the focus selection, paginated. */
export async function focusedConversations(
  d: DataDeps,
  who: Signed,
  projectId: string,
  chatId: string,
  limit: number,
  offset: number,
) {
  await agentProject(d.access, who, projectId);
  await requireChatOfProject(d, chatId, projectId);
  const focused = await focusedList(d, chatId, projectId);
  const page = focused.slice(offset, offset + limit);
  return {
    project_id: projectId,
    project_chat_id: chatId,
    total: focused.length,
    count: page.length,
    offset,
    has_more: focused.length > offset + page.length,
    conversations: page,
  };
}

/**
 * GET /api/conversations/{id}/transcript as the assistant read it: transcribed chunks in
 * speaking order joined by newlines.
 */
export async function transcript(d: DataDeps, who: Signed, conversationId: string) {
  const sql = sqlOf(d);
  const [conv] = isUuid(conversationId)
    ? await sql`select id, project_id, deleted_at from conversation where id = ${conversationId}`
    : [];
  if (!conv || conv.deleted_at || !conv.project_id)
    throw new NotFoundError("Conversation not found");
  await projectFor(d.access, who, String(conv.project_id), "conversation:read");
  const chunks = await sql`
    select transcript from conversation_chunk where conversation_id = ${conversationId}
    order by timestamp asc limit 1500`;
  return chunks
    .map((c) => c.transcript)
    .filter((t): t is string => typeof t === "string" && t !== "")
    .join("\n");
}

const iso = (v: unknown) => text(row({ v }).v);

function displayLabel(c: Row): string {
  const name = c.participant_name;
  if (typeof name === "string" && name.trim()) return name;
  const email = c.participant_email;
  if (typeof email === "string" && email.trim()) return email;
  const id = text(c.id);
  return id ? `Conversation ${id.slice(0, 6)}` : "Conversation";
}

/**
 * GET /api/home/search as the assistant used it: conversations whose participant or
 * summary holds every word, and transcript chunks holding the phrase, both limited to
 * projects the caller may read. Projects and chats are not searched: the assistant never
 * read them. Locked conversations lose summary and excerpt, as every other read does.
 */
export async function searchHome(d: DataDeps, who: Signed, query: string, limit: number) {
  const empty = { projects: [], conversations: [], transcripts: [], chats: [] };
  const term = query.trim();
  if (!term || !who.appUserId) return empty;
  const n = Math.max(1, Math.min(limit, 25));
  const fetch = n * 3;
  const sql = sqlOf(d);
  const words = term.split(/\s+/).filter(Boolean);
  const wordClause = words
    .map(
      (w) =>
        sql`(c.participant_name ilike ${`%${w}%`} or c.participant_email ilike ${`%${w}%`} or c.summary ilike ${`%${w}%`})`,
    )
    .reduce((a, b) => sql`${a} and ${b}`);
  const [convRows, chunkRows] = await Promise.all([
    sql`
      select c.id, c.created_at, c.is_finished, c.is_all_chunks_transcribed, c.participant_name,
             c.participant_email, c.summary, c.is_over_cap, p.id as project_id, p.name as project_name,
             p.workspace_id,
             (select coalesce(ch.timestamp, ch.created_at) from conversation_chunk ch
              where ch.conversation_id = c.id order by ch.timestamp desc nulls first limit 1) as last_chunk
      from conversation c left join project p on p.id = c.project_id
      where c.deleted_at is null and ${wordClause}
      order by c.created_at desc limit ${fetch}`,
    sql`
      select ch.id, ch.transcript, ch.timestamp, ch.created_at, c.id as conversation_id,
             c.participant_name, c.is_over_cap, p.id as project_id, p.workspace_id
      from conversation_chunk ch left join conversation c on c.id = ch.conversation_id
        left join project p on p.id = c.project_id
      where ch.transcript ilike ${`%${term}%`} or ch.raw_transcript ilike ${`%${term}%`}
      order by ch.timestamp desc limit ${fetch}`,
  ]);
  const tiers = new Map<string, string | null | false>();
  const tierOf = async (projectId: unknown) => {
    const id = text(projectId);
    if (!id) return false;
    if (!tiers.has(id))
      tiers.set(
        id,
        await d.access.project(who, id, "project:read").then(
          (a) => a.tier,
          () => false as const,
        ),
      );
    return tiers.get(id) as string | null | false;
  };
  const conversationsOut = [];
  for (const c of convRows) {
    if (conversationsOut.length >= n) break;
    const tier = await tierOf(c.project_id);
    if (tier === false) continue;
    const locked = stampLocked(c.is_over_cap, tier);
    conversationsOut.push({
      id: String(c.id),
      projectId: text(c.project_id),
      projectName: text(c.project_name),
      workspaceId: text(c.workspace_id),
      displayLabel: displayLabel(c as Row),
      status: status(c as Row),
      startedAt: iso(c.created_at),
      lastChunkAt: iso(c.last_chunk),
      summary: locked ? null : typeof c.summary === "string" ? c.summary : null,
    });
  }
  const transcriptsOut = [];
  for (const ch of chunkRows) {
    if (transcriptsOut.length >= n) break;
    const tier = await tierOf(ch.project_id);
    if (tier === false) continue;
    let excerpt = stampLocked(ch.is_over_cap, tier) ? null : (ch.transcript as string | null);
    if (excerpt && excerpt.length > 280) excerpt = `${excerpt.slice(0, 277)}…`;
    transcriptsOut.push({
      id: String(ch.id),
      conversationId: text(ch.conversation_id),
      conversationLabel: text(ch.participant_name),
      projectId: text(ch.project_id),
      workspaceId: text(ch.workspace_id),
      excerpt,
      timestamp: iso(ch.timestamp ?? ch.created_at),
    });
  }
  return { projects: [], conversations: conversationsOut, transcripts: transcriptsOut, chats: [] };
}
