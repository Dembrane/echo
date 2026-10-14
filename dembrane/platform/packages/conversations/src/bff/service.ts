import type { ProjectAccess } from "@dembrane/access";
import { BadRequestError, ForbiddenError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { projectFor } from "@dembrane/http";
import { directusRow, pythonIso } from "@dembrane/legacy-shape";
import { projectsStorage, sameMoveContext } from "@dembrane/projects";
import { conversationForBff } from "../access";
import type { ConversationsDeps } from "../deps";
import type { Row } from "../storage";
import { conversationLock, enrich, overCapActive, scrubChunk } from "./lock";
import {
  type BffStore,
  bffStore,
  CHUNK_ALIASES,
  CHUNK_COLUMNS,
  CHUNK_DEFAULT_FIELDS,
  CONVERSATION_ALIASES,
  CONVERSATION_COLUMNS,
  CONVERSATION_DEFAULT_FIELDS,
  type ListFilter,
} from "./storage";

type Deps = Pick<ConversationsDeps, "db" | "access" | "now">;

const csv = (v: string | null | undefined) =>
  (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * A caller-supplied `fields` list. The Python API passed it straight to Directus on the
 * admin client, so an observer could name relational paths and read outside the
 * conversation (hole M-7). Only the collection's own fields, its alias id lists and `*`
 * are accepted now.
 */
function checkFields(fields: readonly string[], allowed: readonly string[]): void {
  for (const f of fields) {
    if (f === "*") continue;
    if (f.includes(".") || f.includes("*"))
      throw new BadRequestError("conversation.field_relational", { params: { field: f } });
    if (!allowed.includes(f))
      throw new BadRequestError("conversation.field_unknown", { params: { field: f } });
  }
}

async function projectRead(d: Deps, who: Signed, projectId: string) {
  return projectFor(d.access, who, projectId, "conversation:read");
}

async function activeFor(store: BffStore, pa: ProjectAccess) {
  return overCapActive(pa.project.workspaceId, pa.tier, (ws) => store.workspaceSeconds(ws));
}

function filterOf(
  projectId: string,
  q: {
    tag_ids: string | null;
    verified_only: boolean;
    search_text: string | null;
  },
): ListFilter {
  return {
    projectId,
    tagIds: csv(q.tag_ids),
    verifiedOnly: q.verified_only,
    searchText: q.search_text?.trim() || null,
  };
}

/** A tag junction row as `project_tag_id.id,text,created_at` expanded it. */
function tagRow(
  r: Awaited<ReturnType<BffStore["tagRows"]>>[number],
  withConversation: boolean,
): Row {
  return {
    id: r.id,
    ...(withConversation && { conversation_id: r.conversation_id }),
    project_tag_id:
      r.tag_id === null
        ? null
        : directusRow({ id: r.tag_id, text: r.tag_text, created_at: r.tag_created_at }),
  };
}

export async function listConversations(
  d: Deps,
  who: Signed,
  q: {
    project_id: string;
    include_chunks: boolean;
    include_tags: boolean;
    fields: string | null;
    sources: string | null;
    limit: number;
    offset: number;
    sort: string;
    tag_ids: string | null;
    verified_only: boolean;
    search_text: string | null;
    transcript_required: boolean;
  },
): Promise<Row[]> {
  const pa = await projectRead(d, who, q.project_id);
  const store = bffStore(d.db);
  let fields: string[];
  if (q.fields === null) fields = [...CONVERSATION_DEFAULT_FIELDS];
  else if (q.fields.trim() === "*") fields = ["*"];
  else {
    fields = csv(q.fields);
    if (!fields.includes("id")) fields.unshift("id");
    checkFields(fields, [...CONVERSATION_COLUMNS, ...CONVERSATION_ALIASES]);
  }
  let convs = await store.listConversations(
    { ...filterOf(q.project_id, q), sources: csv(q.sources) },
    { sort: q.sort, limit: q.limit, offset: q.offset, fields },
  );
  if (q.transcript_required && convs.length) {
    const kept = await store.withTranscript(convs.map((c) => String(c.id)));
    convs = convs.filter((c) => kept.has(String(c.id)));
  }
  const active = await activeFor(store, pa);
  for (const conv of convs) enrich(conv, pa.tier, active);
  if (!convs.length) return convs;

  const ids = convs.map((c) => String(c.id));
  const artifacts = new Map<string, Row[]>();
  for (const a of await store.artifactsFor(ids)) {
    if (!a.conversation_id) continue;
    const list = artifacts.get(a.conversation_id) ?? [];
    list.push(directusRow(a));
    artifacts.set(a.conversation_id, list);
  }
  const facts = await store.chunkFacts(ids);
  for (const conv of convs) {
    const id = String(conv.id);
    const f = facts.get(id);
    conv.conversation_artifacts = artifacts.get(id) ?? [];
    conv.has_transcript = (f?.transcribed ?? 0) > 0;
    conv.last_chunk_at = f?.lastTs ? directusRow({ t: f.lastTs }).t : null;
    conv.has_only_text_chunks = onlyText(f);
    conv.has_transcription_error = (f?.errors ?? 0) > 0;
    conv.has_pending_chunks = (f?.pending ?? 0) > 0;
  }
  if (q.include_chunks) {
    const locked = new Set(convs.filter((c) => c.locked).map((c) => String(c.id)));
    const byConv = new Map<string, Row[]>();
    for (const ch of await store.chunksForList(ids)) {
      const row = directusRow(ch);
      if (locked.has(ch.conversation_id)) scrubChunk(row);
      const list = byConv.get(ch.conversation_id) ?? [];
      list.push(row);
      byConv.set(ch.conversation_id, list);
    }
    for (const conv of convs) conv.chunks = byConv.get(String(conv.id)) ?? [];
  }
  if (q.include_tags) {
    const byConv = new Map<string, Row[]>();
    for (const t of await store.tagRows(ids)) {
      if (!t.conversation_id) continue;
      const list = byConv.get(t.conversation_id) ?? [];
      list.push(tagRow(t, true));
      byConv.set(t.conversation_id, list);
    }
    for (const conv of convs) conv.tags = byConv.get(String(conv.id)) ?? [];
  }
  return convs;
}

export async function countConversations(
  d: Deps,
  who: Signed,
  q: {
    project_id: string;
    tag_ids: string | null;
    verified_only: boolean;
    search_text: string | null;
  },
) {
  await projectRead(d, who, q.project_id);
  return { count: await bffStore(d.db).countConversations(filterOf(q.project_id, q)) };
}

/** Conversations not yet in a chat's context that would add something (have transcript text). */
export async function countRemaining(
  d: Deps,
  who: Signed,
  q: {
    project_id: string;
    tag_ids: string | null;
    verified_only: boolean;
    search_text: string | null;
    exclude_ids: string | null;
  },
) {
  await projectRead(d, who, q.project_id);
  const store = bffStore(d.db);
  const ids = await store.conversationIds({
    ...filterOf(q.project_id, q),
    excludeIds: csv(q.exclude_ids),
  });
  if (!ids.length) return { count: 0 };
  return { count: await store.countWithTranscript(ids) };
}

/** Every chunk is typed text: there is no audio to download. */
const onlyText = (f: { total: number; nonText: number } | undefined) =>
  (f?.total ?? 0) > 0 && (f?.nonText ?? 0) === 0;

export async function getConversation(
  d: Deps,
  who: Signed,
  conversationId: string,
  q: { include_chunks: boolean; include_tags: boolean },
): Promise<Row> {
  const { project: pa } = await conversationForBff(d, who, conversationId);
  const store = bffStore(d.db);
  const conv = (await store.conversationStar(conversationId)) as Row;
  enrich(conv, pa.tier, await activeFor(store, pa));
  conv.has_only_text_chunks = onlyText(
    (await store.chunkFacts([conversationId])).get(conversationId),
  );
  if (q.include_chunks) {
    const chunks = await store.allChunks(conversationId);
    if (conv.locked) for (const ch of chunks) scrubChunk(ch);
    conv.chunks = chunks;
  }
  if (q.include_tags)
    conv.tags = (await store.tagRows([conversationId])).map((t) => tagRow(t, false));
  return conv;
}

/**
 * Writable fields only: project, deletion, duration and processing state are internal
 * or have their own routes. Null means "not sent", as the pydantic model dump did.
 */
export async function updateConversation(
  d: Deps,
  who: Signed,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<Row> {
  await conversationForBff(d, who, conversationId, "project:update");
  const payload = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null));
  if (!Object.keys(payload).length) throw new BadRequestError("request.nothing_to_update");
  const store = bffStore(d.db);
  await store.updateConversation(conversationId, payload, d.now());
  return (await store.conversationStar(conversationId)) ?? {};
}

/** move_history.append_move_entry: one audit record per move, kept on the conversation. */
function appendMove(
  history: unknown,
  e: {
    from: string;
    fromLabel: string | null;
    to: string;
    toLabel: string | null;
    by: string | null;
    byLabel: string | null;
    at: Date;
  },
) {
  const entries = Array.isArray(history) ? [...history] : [];
  entries.push({
    from: e.from,
    from_label: e.fromLabel,
    to: e.to,
    to_label: e.toLabel,
    by: e.by,
    by_label: e.byLabel,
    at: pythonIso(e.at),
  });
  return entries;
}

/**
 * Moves a conversation to another project the caller can edit, in any workspace of the
 * same billing and data-ownership context. Tags, chats and artifacts stay attached as
 * they were, as the Python move left them.
 */
export async function moveConversation(
  d: Deps,
  who: Signed,
  conversationId: string,
  targetProjectId: string,
): Promise<Row> {
  const src = await conversationForBff(d, who, conversationId, "project:update");
  if (targetProjectId === src.conversation.project_id)
    throw new BadRequestError("conversation.move_same_project");
  const dst = await projectFor(d.access, who, targetProjectId, "project:update");
  // A sample's conversations count toward no limit, so none moves in or out of one.
  if (src.project.project.isSample || dst.project.isSample)
    throw new BadRequestError("conversation.move_sample");
  const from = src.project.project.workspaceId;
  if (!(await sameMoveContext(projectsStorage(d.db), from, dst.project.workspaceId)))
    throw new ForbiddenError("conversation.move_context_mismatch");
  const store = bffStore(d.db);
  const byLabel = await store.appUserLabel(who.directusUserId);
  await store.updateConversation(
    conversationId,
    {
      project_id: targetProjectId,
      move_history: appendMove(src.conversation.move_history, {
        from: src.conversation.project_id,
        fromLabel: await store.projectName(src.conversation.project_id),
        to: targetProjectId,
        toLabel: await store.projectName(targetProjectId),
        by: who.appUserId,
        byLabel,
        at: d.now(),
      }),
    },
    d.now(),
  );
  return (await store.conversationStar(conversationId)) ?? {};
}

export async function listChunks(
  d: Deps,
  who: Signed,
  conversationId: string,
  q: { limit: number; offset: number; sort: "timestamp" | "-timestamp"; fields: string | null },
): Promise<Row[]> {
  const a = await conversationForBff(d, who, conversationId);
  const store = bffStore(d.db);
  const fields = q.fields ? csv(q.fields) : [...CHUNK_DEFAULT_FIELDS];
  if (q.fields) checkFields(fields, [...CHUNK_COLUMNS, ...CHUNK_ALIASES]);
  const { locked } = conversationLock(
    a.conversation as unknown as Row,
    a.project.tier,
    await activeFor(store, a.project),
  );
  const rows = await store.chunkPage(conversationId, { ...q, fields });
  if (locked) for (const r of rows) scrubChunk(r);
  return rows;
}

export async function countChunks(
  d: Deps,
  who: Signed,
  conversationId: string,
  transcriptRequired: boolean,
) {
  await conversationForBff(d, who, conversationId);
  return { count: await bffStore(d.db).chunkCount(conversationId, transcriptRequired) };
}

export async function listTags(d: Deps, who: Signed, conversationId: string): Promise<Row[]> {
  await conversationForBff(d, who, conversationId);
  return (await bffStore(d.db).tagRows([conversationId])).map((t) => tagRow(t, true));
}

/**
 * Replaces a conversation's whole tag set with the requested one. Tags are project-local:
 * ids from another project are ignored even when the caller can reach both.
 */
export async function replaceTags(
  d: Deps,
  who: Signed,
  conversationId: string,
  requested: string[],
): Promise<Row[]> {
  const a = await conversationForBff(d, who, conversationId, "project:update");
  const store = bffStore(d.db);
  const valid = await store.projectTagIds(a.conversation.project_id, [
    ...new Set(requested.filter(Boolean)),
  ]);
  const existing = await store.tagRows([conversationId]);
  const current = new Set(existing.map((r) => r.tag_id).filter((t): t is string => Boolean(t)));
  const remove = existing.filter((r) => r.tag_id && !valid.has(r.tag_id)).map((r) => r.id);
  await store.deleteTagLinks(remove);
  for (const tagId of valid) if (!current.has(tagId)) await store.addTagLink(conversationId, tagId);
  return (await store.tagRows([conversationId])).map((t) => tagRow(t, true));
}
