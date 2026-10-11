import { finishConversation, transaction } from "@dembrane/conversations";
import { NotFoundError, newId, PlatformError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { frameLink, MiroError, type MiroFrame } from "./miro";
import { contentHash, type Segment, segments } from "./render";
import { accessToken, type ConnectorDeps } from "./service";
import type { SourceRow } from "./storage";

const { conversation, conversation_chunk, project } = schema;

/** conversation.source for an input from a Miro frame. */
export const MIRO_SOURCE = "MIRO";

/** What an input remembers of where it came from (conversation.origin). */
export interface MiroOrigin {
  readonly provider: "miro";
  readonly board_id: string;
  readonly board_name: string;
  readonly frame_id: string;
  readonly frame_title: string;
  readonly url: string;
  readonly items: number;
  readonly hash: string;
  readonly synced_at: string;
}

export interface SyncResult {
  readonly written: number;
  readonly unchanged: number;
  readonly removed: number;
}

/**
 * One sync of a source: every picked frame that changed becomes (or replaces) one input,
 * and inputs of frames no longer picked or no longer on the board are deleted. Each write
 * queues conversations' finish, which merges, summarises and counts the input like any
 * finished conversation. A failure the person can fix is saved on the source and the run
 * ends; Miro being busy or down throws so the queue retries.
 */
export async function runSync(d: ConnectorDeps, sourceId: string): Promise<SyncResult | null> {
  const source = await d.store.source(sourceId);
  if (!source) return null;
  const [proj] = await d.db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, source.project_id), isNull(project.deleted_at)))
    .limit(1);
  if (!proj) return null;
  const fail = async (error: string) => {
    await d.store.updateSource(source.id, { status: "error", error, updated_at: d.now() });
    return null;
  };
  const conn = source.connection_id ? await d.store.connection(source.connection_id) : null;
  if (!conn || !d.miro) return fail("not_connected");
  await d.store.updateSource(source.id, { status: "syncing", updated_at: d.now() });
  try {
    const token = await accessToken(d, conn);
    const board = await d.miro.board(token, source.external_id);
    if (!board) return fail("board_not_found");
    const onBoard = new Map((await d.miro.frames(token, board.id)).map((f) => [f.id, f]));
    const picked = ((source.settings as { frame_ids?: string[] }).frame_ids ?? [])
      .map((id) => onBoard.get(id))
      .filter((f): f is MiroFrame => Boolean(f));
    const existing = new Map(
      (await d.store.inputs(source.id)).map((r) => [
        r.ref ?? "",
        { id: r.id, hash: (r.origin as MiroOrigin | null)?.hash ?? null },
      ]),
    );
    let written = 0;
    let unchanged = 0;
    const keep = new Set<string>();
    for (const frame of picked) {
      const segs = segments(await d.miro.frameItems(token, board.id, frame.id));
      // An empty frame has nothing to say; it is not an input until it has words.
      if (!segs.length) continue;
      const title = frame.title.trim() || "Untitled frame";
      const hash = contentHash(title, segs);
      const prev = existing.get(frame.id);
      if (prev) keep.add(prev.id);
      if (prev?.hash === hash) {
        unchanged++;
        continue;
      }
      const origin: MiroOrigin = {
        provider: "miro",
        board_id: board.id,
        board_name: board.name,
        frame_id: frame.id,
        frame_title: title,
        url: frameLink(board.id, frame.id),
        items: segs.length,
        hash,
        synced_at: d.now().toISOString(),
      };
      const id = await writeInput(d, source, prev?.id ?? null, title, origin, segs);
      keep.add(id);
      written++;
    }
    const gone = [...existing.values()].map((e) => e.id).filter((id) => !keep.has(id));
    if (gone.length) await d.db.delete(conversation).where(inArray(conversation.id, gone));
    await d.store.updateSource(source.id, {
      status: "ok",
      error: null,
      name: board.name,
      url: board.url,
      last_synced_at: d.now(),
      updated_at: d.now(),
    });
    d.logger.info(
      { sourceId, written, unchanged, removed: gone.length },
      "connector source synced",
    );
    return { written, unchanged, removed: gone.length };
  } catch (err) {
    if (err instanceof PlatformError && err.code === "connector.not_connected")
      return fail("not_connected");
    if (err instanceof NotFoundError) return fail("board_not_found");
    if (err instanceof MiroError && (err.status === 403 || err.status === 404))
      return fail("board_not_found");
    // The token was revoked on Miro's side; someone has to connect again.
    if (err instanceof MiroError && err.status === 401) return fail("not_connected");
    await d.store.updateSource(source.id, {
      status: "error",
      error: "provider_refused",
      updated_at: d.now(),
    });
    throw err;
  }
}

/**
 * Writes one frame as an input in one transaction: the conversation (new, or reset when
 * it existed), one chunk per item in reading order, and the finish job.
 */
async function writeInput(
  d: ConnectorDeps,
  source: SourceRow,
  existingId: string | null,
  title: string,
  origin: MiroOrigin,
  segs: readonly Segment[],
): Promise<string> {
  const now = d.now();
  const iso = now.toISOString();
  const id = existingId ?? newId();
  await transaction(d.db, async (tx) => {
    const fields = {
      title,
      participant_name: origin.board_name.slice(0, 255),
      voice: source.voice,
      origin,
      is_finished: false,
      is_all_chunks_transcribed: false,
      merged_transcript: null,
      summary: null,
      token_count: null,
      updated_at: iso,
    };
    if (existingId) {
      // Under the row lock the pipeline's claims take, so a finalize in flight either
      // finishes before this or sees the reset.
      await tx.sql`select id from conversation where id = ${id} for no key update`;
      await tx.db.delete(conversation_chunk).where(eq(conversation_chunk.conversation_id, id));
      await tx.db.update(conversation).set(fields).where(eq(conversation.id, id));
    } else {
      await tx.db.insert(conversation).values({
        id,
        project_id: source.project_id,
        source: MIRO_SOURCE,
        connector_source_id: source.id,
        external_ref: origin.frame_id,
        is_anonymized: false,
        created_at: iso,
        ...fields,
      });
    }
    // The chunk timestamps carry the reading order; they are not when anything was said.
    await tx.db.insert(conversation_chunk).values(
      segs.map((s, i) => ({
        id: newId(),
        conversation_id: id,
        timestamp: new Date(now.getTime() + i).toISOString(),
        transcript: s.text,
        raw_transcript: s.text,
        source: MIRO_SOURCE,
        created_at: iso,
        updated_at: iso,
      })),
    );
    await d.jobs.enqueue(
      finishConversation,
      { conversationId: id },
      { tx: tx.sql, singletonKey: id },
    );
  });
  return id;
}
