import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import { and, inArray, isNotNull, sql } from "drizzle-orm";

const { conversation_chunk } = schema;

/** Days after a conversation finishes that its audio is kept, for an organisation with no setting. */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * deleted: audio of conversations their owners deleted.
 * aged: audio of finished conversations past their organisation's keep period.
 * Transcripts, summaries and chats are never part of either step.
 */
export type RetentionStep = "deleted" | "aged";
export const RETENTION_STEPS: readonly RetentionStep[] = ["deleted", "aged"];

/** A conversation whose audio a step would remove. */
export interface Candidate {
  readonly conversationId: string;
  readonly orgId: string | null;
  readonly orgName: string;
  readonly retentionDays: number;
  /** When the last audio reached the conversation: the clock of the aged step. */
  readonly lastAudioAt: Date | null;
  readonly chunkIds: string[];
  /** Every stored path the rows point at, chunks and the merged recording. */
  readonly paths: string[];
  readonly mergedPath: string | null;
  /** Oldest chunk the database records for it; the dry run reports it when the bucket is not read. */
  readonly oldestChunkAt: Date | null;
}

type Row = {
  id: string;
  merged_audio_path: string | null;
  org_id: string | null;
  org_name: string | null;
  audio_retention_days: number | null;
  last_audio_at: Date | string | null;
};

const asDate = (v: Date | string | null | undefined) => (v ? new Date(v) : null);

export interface SelectOptions {
  /** Only this organisation. */
  readonly orgId?: string | undefined;
  /** Only these conversations: a real run re-checks each one just before it acts. */
  readonly conversationIds?: readonly string[] | undefined;
}

/**
 * The conversations a step covers and the audio paths their rows hold. The aged step reads
 * a conversation's finish as the moment its last audio arrived: nothing records the finish
 * itself, and a later edit must not push deletion back. A conversation that is not marked
 * finished, or was deleted (the other step's), is never aged.
 */
export async function selectCandidates(
  db: Db,
  step: RetentionStep,
  now: Date,
  opts: SelectOptions = {},
): Promise<Candidate[]> {
  const stamp = now.toISOString();
  const rows = await db.execute<Row>(sql`
    with ended as (
      select conversation_id, max(coalesce(created_at, "timestamp")) as at
      from conversation_chunk group by conversation_id
    )
    select c.id, c.merged_audio_path, o.id as org_id, o.name as org_name,
           o.audio_retention_days, e.at as last_audio_at
    from conversation c
    left join ended e on e.conversation_id = c.id
    left join project p on p.id = c.project_id
    left join workspace w on w.id = p.workspace_id
    left join org o on o.id = w.org_id
    where ${
      step === "deleted"
        ? sql`c.deleted_at is not null`
        : sql`c.deleted_at is null and c.is_finished = true
          and coalesce(e.at, c.updated_at, c.created_at)
              < ${stamp}::timestamptz - make_interval(days => coalesce(o.audio_retention_days, ${DEFAULT_RETENTION_DAYS}))`
    }
      and (c.merged_audio_path is not null or exists (
        select 1 from conversation_chunk k where k.conversation_id = c.id and k.path is not null))
      ${opts.orgId ? sql`and o.id = ${opts.orgId}::uuid` : sql``}
      ${
        opts.conversationIds
          ? sql`and c.id in (${sql.join(
              opts.conversationIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``
      }
    order by o.name nulls last, c.id`);
  if (!rows.length) return [];

  const chunks = new Map<string, { id: string; path: string; at: Date | null }[]>();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const found = await db
      .select({
        id: conversation_chunk.id,
        conversation_id: conversation_chunk.conversation_id,
        path: conversation_chunk.path,
        at: sql<
          string | null
        >`coalesce(${conversation_chunk.created_at}, ${conversation_chunk.timestamp})`,
      })
      .from(conversation_chunk)
      .where(
        and(
          inArray(conversation_chunk.conversation_id, ids.slice(i, i + 500)),
          isNotNull(conversation_chunk.path),
        ),
      );
    for (const c of found) {
      const list = chunks.get(c.conversation_id) ?? [];
      list.push({ id: c.id, path: c.path as string, at: asDate(c.at) });
      chunks.set(c.conversation_id, list);
    }
  }

  return rows.map((r) => {
    const mine = chunks.get(r.id) ?? [];
    const times = mine.flatMap((c) => (c.at ? [c.at.getTime()] : []));
    return {
      conversationId: r.id,
      orgId: r.org_id,
      orgName: r.org_name ?? "(no organisation)",
      retentionDays: r.audio_retention_days ?? DEFAULT_RETENTION_DAYS,
      lastAudioAt: asDate(r.last_audio_at),
      chunkIds: mine.map((c) => c.id),
      paths: [
        ...new Set([
          ...mine.map((c) => c.path),
          ...(r.merged_audio_path ? [r.merged_audio_path] : []),
        ]),
      ],
      mergedPath: r.merged_audio_path,
      oldestChunkAt: times.length ? new Date(Math.min(...times)) : null,
    };
  });
}

/**
 * Stored paths that a row outside `conversationIds` also points at. A conversation made from
 * another's recording (a re-transcription) shares its files, and deleting them would silence
 * the live one, so the job leaves those alone.
 */
export async function pathsHeldElsewhere(
  db: Db,
  conversationId: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const held = new Set<string>();
  for (let i = 0; i < paths.length; i += 500) {
    const part = paths.slice(i, i + 500);
    if (!part.length) break;
    const list = sql.join(
      part.map((p) => sql`${p}`),
      sql`, `,
    );
    const rows = await db.execute<{ path: string }>(sql`
      select path from conversation_chunk
        where path in (${list}) and conversation_id <> ${conversationId}::uuid
      union
      select merged_audio_path from conversation
        where merged_audio_path in (${list}) and id <> ${conversationId}::uuid`);
    for (const r of rows) held.add(r.path);
  }
  return held;
}

/** Forgets the removed audio in the rows, so the product shows no recording and a re-run skips them. */
export async function clearPaths(
  db: Db,
  conversationId: string,
  removed: ReadonlySet<string>,
): Promise<{ chunks: number; merged: boolean }> {
  if (!removed.size) return { chunks: 0, merged: false };
  const list = sql.join(
    [...removed].map((p) => sql`${p}`),
    sql`, `,
  );
  // updated_at stays as it was: it orders the conversation lists, and an old conversation
  // must not look recently touched.
  const chunks = await db.execute(sql`
    update conversation_chunk set path = null
      where conversation_id = ${conversationId}::uuid and path in (${list}) returning id`);
  const merged = await db.execute(sql`
    update conversation set merged_audio_path = null
      where id = ${conversationId}::uuid and merged_audio_path in (${list}) returning id`);
  return { chunks: chunks.length, merged: merged.length > 0 };
}
