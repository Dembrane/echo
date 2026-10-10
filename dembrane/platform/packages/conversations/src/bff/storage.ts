import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { directusRow } from "@dembrane/legacy-shape";
import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  inArray,
  isNull,
  max,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { isUuid, type Row } from "../storage";

const {
  conversation,
  conversation_chunk,
  conversation_project_tag,
  conversation_artifact,
  conversation_link,
  conversation_reply,
  project_chat_conversation,
  project_chat_message_conversation,
  processing_status,
  project,
  project_tag,
  app_user,
} = schema;

/** The lean overview set the list returns when the caller names no fields. */
export const CONVERSATION_DEFAULT_FIELDS = [
  "id",
  "created_at",
  "updated_at",
  "recording_started_at",
  "project_id",
  "participant_name",
  "participant_email",
  "title",
  "summary",
  "source",
  "duration",
  "is_finished",
  "is_audio_processing_finished",
  "is_anonymized",
  "is_over_cap",
  "move_history",
] as const;

export const CHUNK_DEFAULT_FIELDS = [
  "id",
  "conversation_id",
  "transcript",
  "path",
  "timestamp",
  "error",
  "source",
  "created_at",
] as const;

/** The columns of each collection a caller may name in `fields` (M-7: no relational paths). */
export const CONVERSATION_COLUMNS = Object.keys(conversation) as readonly string[];
export const CHUNK_COLUMNS = Object.keys(conversation_chunk) as readonly string[];

/** Directus's one-to-many and many-to-many aliases, returned as related ids under `*`. */
export const CONVERSATION_ALIASES = [
  "chunks",
  "conversation_artifacts",
  "linked_conversations",
  "linking_conversations",
  "processing_status",
  "project_chat_messages",
  "project_chats",
  "replies",
  "tags",
] as const;
export const CHUNK_ALIASES = ["processing_status"] as const;

/** Search is over these; `id` is left out because Directus rejects _icontains on uuids. */
const SEARCH_COLUMNS = [
  conversation.participant_name,
  conversation.participant_email,
  conversation.title,
  conversation.summary,
];

export interface ListFilter {
  readonly projectId: string;
  readonly sources?: readonly string[];
  readonly tagIds?: readonly string[];
  readonly verifiedOnly?: boolean;
  readonly searchText?: string | null;
  readonly excludeIds?: readonly string[];
}

/** Directus _nempty: neither NULL nor the empty string. */
const nonEmpty = (col: SQL | typeof conversation_chunk.transcript) =>
  sql`(${col} is not null and ${col} <> '')`;

function conversationWhere(f: ListFilter): SQL {
  const parts: (SQL | undefined)[] = [
    eq(conversation.project_id, f.projectId),
    isNull(conversation.deleted_at),
  ];
  if (f.sources?.length) parts.push(inArray(conversation.source, [...f.sources]));
  if (f.tagIds?.length) {
    const ids = f.tagIds.filter(isUuid);
    parts.push(
      ids.length
        ? sql`exists (select 1 from ${conversation_project_tag} where ${conversation_project_tag.conversation_id} = ${conversation.id} and ${inArray(conversation_project_tag.project_tag_id, ids)})`
        : sql`false`,
    );
  }
  if (f.verifiedOnly)
    parts.push(
      sql`exists (select 1 from ${conversation_artifact} where ${conversation_artifact.conversation_id} = ${conversation.id} and ${conversation_artifact.approved_at} is not null)`,
    );
  if (f.excludeIds?.length) {
    const ids = f.excludeIds.filter(isUuid);
    if (ids.length) parts.push(notInArray(conversation.id, ids));
  }
  // Token-AND search: every word present, in any order, in at least one field.
  const tokens = (f.searchText ?? "").split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const like = `%${tok.toLowerCase()}%`;
    parts.push(or(...SEARCH_COLUMNS.map((c) => sql`lower(${c}) like ${like}`)));
  }
  return and(...parts) as SQL;
}

const SORTS: Record<string, SQL> = {
  created_at: asc(conversation.created_at),
  "-created_at": desc(conversation.created_at),
  participant_name: asc(conversation.participant_name),
  "-participant_name": desc(conversation.participant_name),
  duration: asc(conversation.duration),
  "-duration": desc(conversation.duration),
  updated_at: asc(conversation.updated_at),
  "-updated_at": desc(conversation.updated_at),
};

type IdRow = { owner: string | null; id: unknown };

/** Groups related ids by owner, in the order the query returned them. */
function byOwner(rows: readonly IdRow[], owners: readonly string[], asNumber = false) {
  const out = new Map<string, unknown[]>(owners.map((o) => [o, []]));
  for (const r of rows) {
    if (!r.owner) continue;
    out.get(r.owner)?.push(asNumber ? Number(r.id) : String(r.id));
  }
  return out;
}

export function bffStore(db: Db) {
  /** The alias id lists Directus adds to a conversation read with `*`. */
  async function conversationAliases(ids: readonly string[]): Promise<Map<string, Row>> {
    const out = new Map<string, Row>(ids.map((i) => [i, {}]));
    if (!ids.length) return out;
    const list = [...ids];
    const [chunks, artifacts, linked, linking, statuses, messages, chats, replies, tags] =
      await Promise.all([
        db
          .select({ owner: conversation_chunk.conversation_id, id: conversation_chunk.id })
          .from(conversation_chunk)
          .where(inArray(conversation_chunk.conversation_id, list))
          .orderBy(asc(conversation_chunk.timestamp), asc(conversation_chunk.id)),
        db
          .select({ owner: conversation_artifact.conversation_id, id: conversation_artifact.id })
          .from(conversation_artifact)
          .where(inArray(conversation_artifact.conversation_id, list))
          .orderBy(asc(conversation_artifact.id)),
        db
          .select({ owner: conversation_link.source_conversation_id, id: conversation_link.id })
          .from(conversation_link)
          .where(inArray(conversation_link.source_conversation_id, list))
          .orderBy(asc(conversation_link.id)),
        db
          .select({ owner: conversation_link.target_conversation_id, id: conversation_link.id })
          .from(conversation_link)
          .where(inArray(conversation_link.target_conversation_id, list))
          .orderBy(asc(conversation_link.id)),
        db
          .select({ owner: processing_status.conversation_id, id: processing_status.id })
          .from(processing_status)
          .where(inArray(processing_status.conversation_id, list))
          .orderBy(asc(processing_status.id)),
        db
          .select({
            owner: project_chat_message_conversation.conversation_id,
            id: project_chat_message_conversation.id,
          })
          .from(project_chat_message_conversation)
          .where(inArray(project_chat_message_conversation.conversation_id, list))
          .orderBy(asc(project_chat_message_conversation.id)),
        db
          .select({
            owner: project_chat_conversation.conversation_id,
            id: project_chat_conversation.id,
          })
          .from(project_chat_conversation)
          .where(inArray(project_chat_conversation.conversation_id, list))
          .orderBy(asc(project_chat_conversation.id)),
        db
          .select({ owner: conversation_reply.reply, id: conversation_reply.id })
          .from(conversation_reply)
          .where(inArray(conversation_reply.reply, list))
          .orderBy(asc(conversation_reply.id)),
        db
          .select({
            owner: conversation_project_tag.conversation_id,
            id: conversation_project_tag.id,
          })
          .from(conversation_project_tag)
          .where(inArray(conversation_project_tag.conversation_id, list))
          .orderBy(asc(conversation_project_tag.id)),
      ]);
    const groups: [string, Map<string, unknown[]>][] = [
      ["chunks", byOwner(chunks, list)],
      ["conversation_artifacts", byOwner(artifacts, list)],
      ["linked_conversations", byOwner(linked, list)],
      ["linking_conversations", byOwner(linking, list)],
      ["processing_status", byOwner(statuses, list)],
      ["project_chat_messages", byOwner(messages, list, true)],
      ["project_chats", byOwner(chats, list, true)],
      ["replies", byOwner(replies, list)],
      ["tags", byOwner(tags, list, true)],
    ];
    for (const id of list) {
      const row = out.get(id) as Row;
      for (const [name, m] of groups) row[name] = m.get(id) ?? [];
    }
    return out;
  }

  async function chunkAliases(ids: readonly string[]): Promise<Map<string, Row>> {
    const out = new Map<string, Row>(ids.map((i) => [i, {}]));
    if (!ids.length) return out;
    const list = [...ids];
    const statuses = await db
      .select({ owner: processing_status.conversation_chunk_id, id: processing_status.id })
      .from(processing_status)
      .where(inArray(processing_status.conversation_chunk_id, list))
      .orderBy(asc(processing_status.id));
    const p = byOwner(statuses, list);
    for (const id of list) out.set(id, { processing_status: p.get(id) ?? [] });
    return out;
  }

  /** Rows as Directus returned them for the given fields; `*` adds the alias id lists. */
  async function shapeConversations(
    rows: readonly Record<string, unknown>[],
    fields: readonly string[],
  ): Promise<Row[]> {
    const star = fields.includes("*");
    const aliasesWanted = star
      ? [...CONVERSATION_ALIASES]
      : CONVERSATION_ALIASES.filter((a) => fields.includes(a));
    const aliases = aliasesWanted.length
      ? await conversationAliases(rows.map((r) => String(r.id)))
      : new Map<string, Row>();
    return rows.map((r) => {
      const full = directusRow(r);
      const out: Row = {};
      if (star) Object.assign(out, full);
      else for (const f of fields) if (f in full) out[f] = full[f];
      const a = aliases.get(String(r.id)) ?? {};
      for (const name of aliasesWanted) out[name] = a[name] ?? [];
      return out;
    });
  }

  return {
    shapeConversations,

    async listConversations(
      f: ListFilter,
      opts: { sort: string; limit: number; offset: number; fields: readonly string[] },
    ): Promise<Row[]> {
      const rows = await db
        .select()
        .from(conversation)
        .where(conversationWhere(f))
        .orderBy(SORTS[opts.sort] as SQL, asc(conversation.id))
        .limit(opts.limit)
        .offset(opts.offset);
      return shapeConversations(rows, opts.fields);
    },

    async countConversations(f: ListFilter): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(${conversation.id})::int` })
        .from(conversation)
        .where(conversationWhere(f));
      return row?.n ?? 0;
    },

    async conversationIds(f: ListFilter): Promise<string[]> {
      const rows = await db
        .select({ id: conversation.id })
        .from(conversation)
        .where(conversationWhere(f))
        .orderBy(asc(conversation.id));
      return rows.map((r) => r.id);
    },

    /** How many of these conversations have at least one chunk with transcript text. */
    async countWithTranscript(ids: readonly string[]): Promise<number> {
      if (!ids.length) return 0;
      const [row] = await db
        .select({ n: countDistinct(conversation_chunk.conversation_id) })
        .from(conversation_chunk)
        .where(
          and(
            inArray(conversation_chunk.conversation_id, [...ids]),
            nonEmpty(conversation_chunk.transcript),
          ),
        );
      return Number(row?.n ?? 0);
    },

    /** Conversation ids among these with a chunk whose transcript is non-empty. */
    async withTranscript(ids: readonly string[]): Promise<Set<string>> {
      if (!ids.length) return new Set();
      const rows = await db
        .selectDistinct({ id: conversation_chunk.conversation_id })
        .from(conversation_chunk)
        .where(
          and(
            inArray(conversation_chunk.conversation_id, [...ids]),
            nonEmpty(conversation_chunk.transcript),
          ),
        );
      return new Set(rows.map((r) => r.id));
    },

    /** The derived chunk facts the list shows per row, from grouped aggregates. */
    async chunkFacts(ids: readonly string[]) {
      const list = [...ids];
      const text = sql`(${conversation_chunk.source} <> 'PORTAL_TEXT' or ${conversation_chunk.source} is null)`;
      const errored = sql`(${conversation_chunk.error} is not null and ${conversation_chunk.error} <> '') and (${conversation_chunk.transcript} is null or ${conversation_chunk.transcript} = '')`;
      const rows = await db
        .select({
          id: conversation_chunk.conversation_id,
          total: sql<number>`count(*)::int`,
          nonText: sql<number>`count(*) filter (where ${text})::int`,
          transcribed: sql<number>`count(*) filter (where ${nonEmpty(conversation_chunk.transcript)})::int`,
          errors: sql<number>`count(*) filter (where ${errored})::int`,
          // The pipeline's pendingChunks: neither a transcript nor an error yet.
          pending: sql<number>`count(*) filter (where ${conversation_chunk.transcript} is null and ${conversation_chunk.error} is null)::int`,
          lastTs: max(conversation_chunk.timestamp),
        })
        .from(conversation_chunk)
        .where(inArray(conversation_chunk.conversation_id, list))
        .groupBy(conversation_chunk.conversation_id);
      return new Map(rows.map((r) => [r.id, r]));
    },

    async artifactsFor(ids: readonly string[]) {
      return db
        .select({
          id: conversation_artifact.id,
          conversation_id: conversation_artifact.conversation_id,
          approved_at: conversation_artifact.approved_at,
          key: conversation_artifact.key,
          topic_label: conversation_artifact.topic_label,
        })
        .from(conversation_artifact)
        .where(inArray(conversation_artifact.conversation_id, [...ids]))
        .orderBy(
          sql`${conversation_artifact.approved_at} desc nulls first`,
          sql`${conversation_artifact.date_created} desc nulls first`,
          asc(conversation_artifact.id),
        );
    },

    /** Chunks of many conversations with the list's embed fields, newest first. */
    async chunksForList(ids: readonly string[]) {
      return db
        .select({
          id: conversation_chunk.id,
          conversation_id: conversation_chunk.conversation_id,
          transcript: conversation_chunk.transcript,
          source: conversation_chunk.source,
          path: conversation_chunk.path,
          timestamp: conversation_chunk.timestamp,
          created_at: conversation_chunk.created_at,
          error: conversation_chunk.error,
        })
        .from(conversation_chunk)
        .where(inArray(conversation_chunk.conversation_id, [...ids]))
        .orderBy(
          desc(conversation_chunk.timestamp),
          sql`${conversation_chunk.created_at} desc nulls first`,
          asc(conversation_chunk.id),
        );
    },

    /** Tag junction rows with the tag expanded, as `project_tag_id.*` fields returned them. */
    async tagRows(ids: readonly string[]) {
      if (!ids.length) return [];
      return db
        .select({
          id: conversation_project_tag.id,
          conversation_id: conversation_project_tag.conversation_id,
          tag_id: project_tag.id,
          tag_text: project_tag.text,
          tag_created_at: project_tag.created_at,
        })
        .from(conversation_project_tag)
        .leftJoin(project_tag, eq(project_tag.id, conversation_project_tag.project_tag_id))
        .where(inArray(conversation_project_tag.conversation_id, [...ids]))
        .orderBy(asc(conversation_project_tag.id));
    },

    /** Chunks of one conversation with every column plus the `*` aliases. */
    async allChunks(conversationId: string): Promise<Row[]> {
      const rows = await db
        .select()
        .from(conversation_chunk)
        .where(eq(conversation_chunk.conversation_id, conversationId))
        .orderBy(asc(conversation_chunk.timestamp), asc(conversation_chunk.id));
      const aliases = await chunkAliases(rows.map((r) => r.id));
      return rows.map((r) => ({ ...directusRow(r), ...(aliases.get(r.id) ?? {}) }));
    },

    async chunkPage(
      conversationId: string,
      opts: {
        sort: "timestamp" | "-timestamp";
        limit: number;
        offset: number;
        fields: readonly string[];
      },
    ): Promise<Row[]> {
      const rows = await db
        .select()
        .from(conversation_chunk)
        .where(eq(conversation_chunk.conversation_id, conversationId))
        .orderBy(
          opts.sort === "timestamp"
            ? asc(conversation_chunk.timestamp)
            : desc(conversation_chunk.timestamp),
          asc(conversation_chunk.id),
        )
        .limit(opts.limit)
        .offset(opts.offset);
      const star = opts.fields.includes("*");
      const wanted = star
        ? [...CHUNK_ALIASES]
        : CHUNK_ALIASES.filter((a) => opts.fields.includes(a));
      const aliases = wanted.length ? await chunkAliases(rows.map((r) => r.id)) : new Map();
      return rows.map((r) => {
        const full = directusRow(r);
        const out: Row = {};
        if (star) Object.assign(out, full);
        else for (const f of opts.fields) if (f in full) out[f] = full[f];
        const a = (aliases.get(r.id) ?? {}) as Row;
        for (const name of wanted) out[name] = a[name] ?? [];
        return out;
      });
    },

    async chunkCount(conversationId: string, transcriptRequired: boolean): Promise<number> {
      const [row] = await db
        .select({ n: sql<number>`count(${conversation_chunk.id})::int` })
        .from(conversation_chunk)
        .where(
          and(
            eq(conversation_chunk.conversation_id, conversationId),
            transcriptRequired ? nonEmpty(conversation_chunk.transcript) : undefined,
          ),
        );
      return row?.n ?? 0;
    },

    /** A conversation row read with `*`, aliases included, soft-deleted or not. */
    async conversationStar(id: string): Promise<Row | null> {
      const [row] = await db.select().from(conversation).where(eq(conversation.id, id)).limit(1);
      if (!row) return null;
      const [shaped] = await shapeConversations([row], ["*"]);
      return shaped ?? null;
    },

    async updateConversation(id: string, patch: Record<string, unknown>, now: Date) {
      await db
        .update(conversation)
        .set({ ...patch, updated_at: now.toISOString() })
        .where(eq(conversation.id, id));
    },

    async projectName(id: string): Promise<string | null> {
      const [row] = await db
        .select({ name: project.name })
        .from(project)
        .where(eq(project.id, id))
        .limit(1);
      return row?.name ?? null;
    },

    async appUserLabel(directusUserId: string): Promise<string | null> {
      const [row] = await db
        .select({ display_name: app_user.display_name, email: app_user.email })
        .from(app_user)
        .where(eq(app_user.directus_user_id, directusUserId))
        .limit(1);
      return row?.display_name || row?.email || null;
    },

    /** Of these tag ids, the ones that belong to the project. */
    async projectTagIds(projectId: string, ids: readonly string[]): Promise<Set<string>> {
      // Directus failed the whole `_in` lookup when one id was not a uuid, and the Python
      // then treated every requested tag as invalid; kept so a malformed request clears
      // the same tags on both APIs.
      if (!ids.every(isUuid)) return new Set();
      const valid = [...ids];
      if (!valid.length) return new Set();
      const rows = await db
        .select({ id: project_tag.id })
        .from(project_tag)
        .where(and(inArray(project_tag.id, valid), eq(project_tag.project_id, projectId)));
      return new Set(rows.map((r) => r.id));
    },

    async deleteTagLinks(rowIds: readonly number[]) {
      if (!rowIds.length) return;
      await db
        .delete(conversation_project_tag)
        .where(inArray(conversation_project_tag.id, [...rowIds]));
    },

    async addTagLink(conversationId: string, tagId: string) {
      await db
        .insert(conversation_project_tag)
        .values({ conversation_id: conversationId, project_tag_id: tagId });
    },

    /**
     * Sum of every conversation's seconds in the workspace, deleted rows and projects
     * included; a sample copy's invented conversations are left out.
     */
    async workspaceSeconds(workspaceId: string): Promise<number> {
      const [row] = await db
        .select({ s: sql<number>`coalesce(sum(${conversation.duration}), 0)::float8` })
        .from(conversation)
        .innerJoin(project, eq(project.id, conversation.project_id))
        .where(and(eq(project.workspace_id, workspaceId), eq(project.is_sample, false)));
      return Number(row?.s ?? 0);
    },
  };
}

export type BffStore = ReturnType<typeof bffStore>;
