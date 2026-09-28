import type { ProjectAccess } from "@dembrane/access";
import { bffStore, enrich, overCapActive, scrubChunk } from "@dembrane/conversations";
import { BadRequestError } from "@dembrane/core";
import { directusRow } from "@dembrane/legacy-shape";
import type postgres from "postgres";
import type { AgentDeps } from "./context";
import type { Row } from "./storage";

/**
 * The conversation read primitives both front doors (REST and MCP) answer from: keyword
 * search across a project, grep in one conversation, transcript pages, and the listing.
 * Every read applies the locked/over-cap scrub the dashboard applies, so a locked
 * conversation never leaks transcript text through a snippet or a page. Callers resolve
 * access first and pass it in.
 */

export const MIN_TOKEN_LENGTH = 4;
const MAX_QUERY_TOKENS = 4;
const SNIPPET_CONTEXT_CHARS = 80;
const MATCHES_PER_CONVERSATION = 3;
// The search scans a bounded window of matching chunks instead of counting them: this
// many per wanted conversation, within these bounds. has_more is exact within the window.
const CHUNK_SCAN_PER_CONVERSATION = 25;
const CHUNK_SCAN_MIN = 25;
const CHUNK_SCAN_MAX = 1000;

const SEARCH_LIMIT_MAX = 100;
const LIST_LIMIT_MAX = 500;
const GREP_LIMIT_MAX = 50;
const TRANSCRIPT_LIMIT_MAX = 200;

export const CONVERSATION_SORTS = [
  "-created_at",
  "created_at",
  "-updated_at",
  "updated_at",
  "-duration",
  "duration",
] as const;
export type ConversationSort = (typeof CONVERSATION_SORTS)[number];

const sqlOf = (d: AgentDeps): postgres.Sql => d.store.sql;

/** A stripped string, or null for empty, missing and structured values. */
export function text(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "object") return null;
  const s = String(value).trim();
  return s || null;
}

const clamp = (v: number, upper: number) => Math.max(1, Math.min(Math.trunc(v), upper));

/** Lower-case alphanumeric words of 4 letters or more, deduplicated, at most four. */
export function normalizeQueryTokens(query: string): string[] {
  const tokens: string[] = [];
  for (const m of query.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const t = m[0];
    if (t.length < MIN_TOKEN_LENGTH || tokens.includes(t)) continue;
    tokens.push(t);
    if (tokens.length >= MAX_QUERY_TOKENS) break;
  }
  return tokens;
}

/**
 * 80 characters either side of the first token found, with ellipses where it was cut; the
 * head of the text when none is found. Offsets count code points, as Python slices do.
 */
export function buildSnippet(textIn: string, tokens: readonly string[]): string {
  const chars = Array.from(textIn);
  const lowered = Array.from(textIn.toLowerCase());
  const loweredText = lowered.join("");
  for (const token of tokens) {
    const unit = loweredText.indexOf(token);
    if (unit < 0) continue;
    const offset = Array.from(loweredText.slice(0, unit)).length;
    const start = Math.max(0, offset - SNIPPET_CONTEXT_CHARS);
    const end = Math.min(chars.length, offset + token.length + SNIPPET_CONTEXT_CHARS);
    let snippet = chars.slice(start, end).join("").trim();
    if (start > 0 && snippet) snippet = `...${snippet}`;
    if (end < chars.length && snippet) snippet = `${snippet}...`;
    return snippet;
  }
  return Array.from(textIn.trim())
    .slice(0, SNIPPET_CONTEXT_CHARS * 2)
    .join("")
    .trim();
}

export interface Snippet {
  chunk_id: string;
  timestamp: string;
  snippet: string;
}

function chunkSnippet(row: Row, tokens: readonly string[]): Snippet | null {
  const chunkId = text(row.id);
  const transcript = text(row.transcript) ?? text(row.raw_transcript);
  if (chunkId === null || transcript === null) return null;
  const timestamp = text(row.timestamp) ?? text(row.created_at) ?? "";
  return { chunk_id: chunkId, timestamp, snippet: buildSnippet(transcript, tokens) };
}

/** live while recording, processing until every chunk is transcribed, then done. */
export function status(row: { is_finished?: unknown; is_all_chunks_transcribed?: unknown }) {
  if (!row.is_finished) return "live";
  if (!row.is_all_chunks_transcribed) return "processing";
  return "done";
}

/** The toolkit's ConversationSummary, key order as pydantic dumps it (status last). */
function summaryFields(row: Row, projectId: string): Row {
  const out: Row = {
    id: String(row.id),
    project_id: text(row.project_id) ?? projectId,
    title: text(row.title),
    participant_name: text(row.participant_name),
    summary: typeof row.summary === "string" ? row.summary : null,
    source: text(row.source),
    duration: row.duration ?? null,
    is_finished: row.is_finished ?? null,
    is_all_chunks_transcribed: row.is_all_chunks_transcribed ?? null,
    locked: Boolean(row.locked),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
  return out;
}

const withStatus = (fields: Row, extra: Row = {}): Row => ({
  ...fields,
  ...extra,
  status: status(fields),
});

/** Whether the project's workspace is past its free hours right now. */
export function overCap(d: AgentDeps, pa: ProjectAccess): Promise<boolean> {
  const store = bffStore(d.db);
  return overCapActive(pa.project.workspaceId, pa.tier, (ws) => store.workspaceSeconds(ws));
}

const ISO_DATE =
  /^\d{4}-?\d{2}-?\d{2}([T ]\d{2}(:?\d{2}(:?\d{2}([.,]\d+)?)?)?(Z|[+-]\d{2}(:?\d{2}(:?\d{2}(\.\d+)?)?)?)?)?$/;

/** An ISO 8601 bound as Python's datetime.fromisoformat accepted it, or 400. */
function isoBound(value: string, name: string): string {
  const t = value.trim();
  const m = ISO_DATE.test(t) ? t.match(/^(\d{4})-?(\d{2})-?(\d{2})/) : null;
  const [y, mo, day] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  const real = m && new Date(Date.UTC(y, mo - 1, day)).getUTCDate() === day && mo >= 1 && mo <= 12;
  if (!real) throw new BadRequestError(`${name} must be an ISO 8601 date or datetime`);
  return t;
}

/** Any token in the transcript, or in raw_transcript, the pre-correction twin older chunks carry. */
function transcriptMatch(sql: postgres.Sql, tokens: readonly string[]) {
  return tokens
    .flatMap((t) => [sql`c.transcript ilike ${`%${t}%`}`, sql`c.raw_transcript ilike ${`%${t}%`}`])
    .reduce((acc, clause) => sql`${acc} or ${clause}`);
}

export async function searchTranscripts(
  d: AgentDeps,
  pa: ProjectAccess,
  projectId: string,
  query: string,
  limitIn: number,
  offsetIn: number,
) {
  const limit = clamp(limitIn, SEARCH_LIMIT_MAX);
  const offset = Math.max(0, Math.trunc(offsetIn));
  const tokens = normalizeQueryTokens(query);
  if (!tokens.length)
    return { project_id: projectId, tokens: [], offset, has_more: false, conversations: [] };
  const active = await overCap(d, pa);
  const wanted = limit + offset;
  const chunkLimit = Math.min(
    Math.max(wanted * CHUNK_SCAN_PER_CONVERSATION, CHUNK_SCAN_MIN),
    CHUNK_SCAN_MAX,
  );
  const sql = sqlOf(d);
  const rows = await sql`select c.id, c.timestamp, c.created_at, c.transcript, c.raw_transcript,
      v.id as conv_id, v.project_id as conv_project_id, v.title as conv_title,
      v.participant_name as conv_participant_name, v.summary as conv_summary,
      v.source as conv_source, v.duration as conv_duration, v.is_finished as conv_is_finished,
      v.is_all_chunks_transcribed as conv_is_all_chunks_transcribed,
      v.is_over_cap as conv_is_over_cap, v.created_at as conv_created_at,
      v.updated_at as conv_updated_at
    from conversation_chunk c join conversation v on v.id = c.conversation_id
    where v.project_id = ${projectId} and v.deleted_at is null and (${transcriptMatch(sql, tokens)})
    order by c.timestamp desc, c.created_at desc limit ${chunkLimit}`;

  const hits = new Map<string, { fields: Row; matches: Snippet[] }>();
  for (const raw of rows) {
    const r = directusRow(raw as Row);
    const cid = text(r.conv_id);
    if (cid === null) continue;
    let hit = hits.get(cid);
    if (!hit) {
      // One conversation past the page is the has_more probe.
      if (hits.size > wanted) continue;
      const conv: Row = {};
      for (const [k, v] of Object.entries(r)) if (k.startsWith("conv_")) conv[k.slice(5)] = v;
      enrich(conv, pa.tier, active);
      hit = { fields: summaryFields(conv, projectId), matches: [] };
      hits.set(cid, hit);
    }
    const chunk: Row = { ...r };
    if (hit.fields.locked) {
      scrubChunk(chunk);
      delete chunk.raw_transcript;
    }
    if (hit.matches.length < MATCHES_PER_CONVERSATION) {
      const s = chunkSnippet(chunk, tokens);
      if (s) hit.matches.push(s);
    }
  }
  const matched = [...hits.values()];
  const page = matched.slice(offset, offset + limit);
  return {
    project_id: projectId,
    tokens,
    offset,
    has_more: matched.length > offset + page.length,
    conversations: page.map((h) => withStatus(h.fields, { matches: h.matches })),
  };
}

/** Snippets from one conversation's chunks in speaking order; nothing from a locked one. */
export async function grepConversation(
  d: AgentDeps,
  conversationId: string,
  locked: boolean,
  query: string,
  maxIn: number,
): Promise<Snippet[]> {
  const max = clamp(maxIn, GREP_LIMIT_MAX);
  const tokens = normalizeQueryTokens(query);
  if (locked || !tokens.length) return [];
  const sql = sqlOf(d);
  const rows = await sql`select c.id, c.timestamp, c.created_at, c.transcript, c.raw_transcript
    from conversation_chunk c
    where c.conversation_id = ${conversationId} and (${transcriptMatch(sql, tokens)})
    order by c.timestamp asc, c.created_at asc limit ${max}`;
  const out: Snippet[] = [];
  for (const r of rows) {
    const s = chunkSnippet(directusRow(r as Row), tokens);
    if (s) out.push(s);
  }
  return out;
}

/** One page of chunks in speaking order with the total count; a locked conversation's text is withheld. */
export async function readTranscript(
  d: AgentDeps,
  conversationId: string,
  locked: boolean,
  offsetIn: number,
  limitIn: number,
) {
  const limit = clamp(limitIn, TRANSCRIPT_LIMIT_MAX);
  const offset = Math.max(0, Math.trunc(offsetIn));
  const sql = sqlOf(d);
  const [count, rows] = await Promise.all([
    sql`select count(*)::int as n from conversation_chunk where conversation_id = ${conversationId}`,
    sql`select id, timestamp, transcript from conversation_chunk
      where conversation_id = ${conversationId}
      order by timestamp asc, id asc limit ${limit} offset ${offset}`,
  ]);
  const chunks = rows.map((raw) => {
    const r = directusRow(raw as Row);
    if (locked) scrubChunk(r);
    return {
      id: String(r.id),
      timestamp: text(r.timestamp),
      transcript: typeof r.transcript === "string" ? r.transcript : null,
    };
  });
  const total = Number(count[0]?.n ?? 0);
  return {
    conversation_id: conversationId,
    offset,
    limit,
    total,
    has_more: offset + chunks.length < total,
    transcript_locked: locked,
    chunks,
  };
}

const SORT_SQL: Record<ConversationSort, string> = {
  "-created_at": "created_at desc",
  created_at: "created_at asc",
  "-updated_at": "updated_at desc",
  updated_at: "updated_at asc",
  "-duration": "duration desc",
  duration: "duration asc",
};

/**
 * A page of a project's conversations without transcripts. `search` needs every word in
 * the participant name, email, title or summary; the created bounds are inclusive. One
 * extra row is read so has_more is exact without a count.
 */
export async function listConversations(
  d: AgentDeps,
  pa: ProjectAccess,
  projectId: string,
  q: {
    search: string | null;
    limit: number;
    offset: number;
    sort: ConversationSort;
    createdAfter: string | null;
    createdBefore: string | null;
  },
) {
  const limit = clamp(q.limit, LIST_LIMIT_MAX);
  const offset = Math.max(0, Math.trunc(q.offset));
  const active = await overCap(d, pa);
  const sql = sqlOf(d);
  const after = q.createdAfter ? isoBound(q.createdAfter, "created_after") : null;
  const before = q.createdBefore ? isoBound(q.createdBefore, "created_before") : null;
  const words = (q.search ?? "").trim().split(/\s+/).filter(Boolean);
  const wordClauses = words.map((w) => {
    const like = `%${w.toLowerCase()}%`;
    return sql`(lower(participant_name) like ${like} or lower(participant_email) like ${like}
      or lower(title) like ${like} or lower(summary) like ${like})`;
  });
  const conditions = [
    sql`project_id = ${projectId}`,
    sql`deleted_at is null`,
    ...(after ? [sql`created_at >= ${after}::timestamptz`] : []),
    ...(before ? [sql`created_at <= ${before}::timestamptz`] : []),
    ...wordClauses,
  ].reduce((acc, c) => sql`${acc} and ${c}`);
  const rows = await sql`select id, project_id, title, participant_name, summary, source, duration,
      is_finished, is_all_chunks_transcribed, is_over_cap, created_at, updated_at
    from conversation where ${conditions}
    order by ${sql.unsafe(SORT_SQL[q.sort])}, id limit ${limit + 1} offset ${offset}`;
  const list = rows.map((r) => directusRow(r as Row));
  const hasMore = list.length > limit;
  const conversations = list.slice(0, limit).map((row) => {
    enrich(row, pa.tier, active);
    return withStatus(summaryFields(row, projectId));
  });
  return { project_id: projectId, offset, has_more: hasMore, conversations };
}

/** Tag texts per conversation, in the link table's order. */
export async function tagsByConversation(
  d: AgentDeps,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const sql = sqlOf(d);
  const rows = await sql`select cpt.conversation_id, t.text from conversation_project_tag cpt
    join project_tag t on t.id = cpt.project_tag_id
    where cpt.conversation_id in ${sql([...ids])} order by cpt.id`;
  for (const r of rows) {
    if (!r.text) continue;
    const cid = String(r.conversation_id);
    out.set(cid, [...(out.get(cid) ?? []), String(r.text)]);
  }
  return out;
}

export async function chunkCount(d: AgentDeps, conversationId: string): Promise<number> {
  const [r] = await sqlOf(d)`select count(*)::int as n from conversation_chunk
    where conversation_id = ${conversationId}`;
  return Number(r?.n ?? 0);
}
