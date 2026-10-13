import { type Db, schema } from "@dembrane/db";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import chat from "../fixtures/best-practices/chat.json";
import conversations from "../fixtures/best-practices/conversations.json";
import project from "../fixtures/best-practices/project.json";
import type { SampleOwner } from "./millbrook";

/**
 * The sample every workspace gets: "Best practices (sample)", simulated anonymous
 * conversations of practitioners describing how they used dembrane, and a chat that
 * already answers "how do other organisations use dembrane?", so a new user opens a
 * project the assistant can answer from on day one (fixtures/best-practices).
 *
 * Each workspace holds its own copy, owned by whoever created the workspace. Every id
 * derives from the workspace id, so a rerun writes the same rows, and a copy the user
 * deleted stays deleted: its project row is the tombstone. The copy is marked
 * project.is_sample, which keeps it out of usage, limits and public numbers, and it takes
 * no new conversations, so nothing real is ever recorded under that exemption.
 *
 * project.sample_version names the fixture a copy was seeded from. A rerun with the same
 * fixture writes nothing; a newer fixture rewrites the seeded conversations, their chunks
 * and the seeded chat's turns, and leaves the project's settings, the user's own chats and
 * reports, and any turn the user added to the seeded chat alone.
 */

export const BEST_PRACTICES = {
  project: project.project,
  disclosure: project.disclosure,
  conversations: conversations.length,
  chatMessages: chat.turns.length,
} as const;

/** The fixture's fingerprint, stored on every copy seeded from it. */
export const BEST_PRACTICES_VERSION = `best-practices@${new Bun.CryptoHasher("sha256")
  .update(JSON.stringify([project, conversations, chat]))
  .digest("hex")
  .slice(0, 16)}`;

const VERSION_PREFIX = "best-practices@";
const uuid5 = (name: string) => Bun.randomUUIDv5(`dembrane:sample:best-practices:${name}`, "url");
const projectId = (workspaceId: string) => uuid5(`project:${workspaceId}`);
// Children hang off the project id, so a copy can be refreshed from its own row.
const child = (pid: string, kind: string) => uuid5(`${pid}:${kind}`);
// Seeded turns are numbered; a newer, shorter chat removes the ones it no longer has.
const MAX_SEEDED_TURNS = 32;

export const BEST_PRACTICES_IDS = {
  project: projectId,
  chat: (workspaceId: string) => child(projectId(workspaceId), "chat"),
  conversation: (workspaceId: string, key: string) =>
    child(projectId(workspaceId), `conversation:${key}`),
};

export interface BestPracticesSummary {
  /**
   * created: a new copy. updated: an older fixture's copy rewritten. current: already
   * seeded from this fixture, nothing written. deleted: the user deleted the copy, left so.
   * workspace_deleted: no copy, and the workspace is gone, so none is made.
   */
  readonly status: "created" | "updated" | "current" | "deleted" | "workspace_deleted";
  readonly workspace_id: string;
  readonly project_id: string;
  readonly conversations: number;
  readonly chunks: number;
  readonly chat_id: string;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const at = (start: string, seconds: number) =>
  new Date(Date.parse(start) + seconds * 1000).toISOString();

const chunkCount = conversations.reduce((n, c) => n + c.chunks.length, 0);

/** Seeds the workspace's copy, or brings it to this fixture; safe to repeat. */
export async function seedBestPractices(
  db: Db,
  owner: SampleOwner,
  workspaceId: string,
  now: Date,
): Promise<BestPracticesSummary> {
  const pid = projectId(workspaceId);
  const summary = (status: BestPracticesSummary["status"]): BestPracticesSummary => ({
    status,
    workspace_id: workspaceId,
    project_id: pid,
    conversations: conversations.length,
    chunks: chunkCount,
    chat_id: child(pid, "chat"),
  });
  return db.transaction(async (tx) => {
    const existing = await lockCopy(tx, pid);
    if (existing?.deleted_at) return summary("deleted");
    if (existing?.version === BEST_PRACTICES_VERSION) return summary("current");
    if (existing) {
      await rewriteCopy(tx, pid, owner.userId, now);
      return summary("updated");
    }
    const [ws] = await tx
      .select({ deleted_at: schema.workspace.deleted_at })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, workspaceId));
    if (!ws || ws.deleted_at) return summary("workspace_deleted");
    const nowIso = now.toISOString();
    await tx.insert(schema.project).values({
      id: pid,
      name: project.project,
      language: project.language,
      context: project.context,
      workspace_id: workspaceId,
      directus_user_id: owner.userId,
      // Closed to participants: a recording here would escape every usage count.
      is_conversation_allowed: false,
      is_sample: true,
      sample_version: BEST_PRACTICES_VERSION,
      created_at: nowIso,
      updated_at: nowIso,
    });
    await writeContent(tx, pid, owner.userId, now);
    return summary("created");
  });
}

/** The copy's row under a per-copy lock: the creation job and the backfill can meet. */
async function lockCopy(tx: Tx, pid: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`sample:${pid}`}))`);
  const [row] = await tx
    .select({ deleted_at: schema.project.deleted_at, version: schema.project.sample_version })
    .from(schema.project)
    .where(eq(schema.project.id, pid));
  return row ?? null;
}

/** An older fixture's copy: new content, then the stamp. Project settings stay the user's. */
async function rewriteCopy(tx: Tx, pid: string, ownerUserId: string | null, now: Date) {
  await writeContent(tx, pid, ownerUserId, now);
  await tx
    .update(schema.project)
    .set({ sample_version: BEST_PRACTICES_VERSION, updated_at: now.toISOString() })
    .where(eq(schema.project.id, pid));
}

/**
 * The conversations, chunks and seeded chat. A conversation or chat the user deleted
 * stays deleted; a conversation an older fixture had and this one does not is deleted.
 */
async function writeContent(tx: Tx, pid: string, ownerUserId: string | null, now: Date) {
  const nowIso = now.toISOString();
  const convId = (key: string) => child(pid, `conversation:${key}`);
  const convRows = conversations.map((c) => {
    const last = c.chunks[c.chunks.length - 1]?.at_s ?? 0;
    return {
      id: convId(c.key),
      project_id: pid,
      participant_name: c.name,
      title: c.name,
      // Uploaded, not portal: the live monitor and recording stamps leave it alone.
      source: "DASHBOARD_UPLOAD",
      is_finished: true,
      is_all_chunks_transcribed: true,
      is_audio_processing_finished: true,
      is_over_cap: false,
      merged_transcript: c.chunks.map((x) => x.text).join("\n"),
      summary: c.summary,
      duration: last + 30,
      created_at: c.started_at,
      updated_at: at(c.started_at, last + 30),
      recording_started_at: c.started_at,
    };
  });
  const ids = convRows.map((c) => c.id);
  await tx
    .update(schema.conversation)
    .set({ deleted_at: nowIso, updated_at: nowIso })
    .where(
      and(
        eq(schema.conversation.project_id, pid),
        notInArray(schema.conversation.id, ids),
        isNull(schema.conversation.deleted_at),
      ),
    );
  await tx
    .insert(schema.conversation)
    .values(convRows)
    .onConflictDoUpdate({
      target: schema.conversation.id,
      set: {
        participant_name: sql`excluded.participant_name`,
        title: sql`excluded.title`,
        merged_transcript: sql`excluded.merged_transcript`,
        summary: sql`excluded.summary`,
        duration: sql`excluded.duration`,
        is_finished: true,
        is_all_chunks_transcribed: true,
        is_audio_processing_finished: true,
        is_over_cap: false,
        updated_at: nowIso,
      },
    });

  const chunkRows = conversations.flatMap((c) =>
    c.chunks.map((x, i) => ({
      id: child(pid, `chunk:${c.key}:${i}`),
      conversation_id: convId(c.key),
      transcript: x.text,
      timestamp: at(c.started_at, x.at_s),
      created_at: at(c.started_at, x.at_s),
    })),
  );
  await tx.delete(schema.conversation_chunk).where(
    and(
      inArray(schema.conversation_chunk.conversation_id, ids),
      notInArray(
        schema.conversation_chunk.id,
        chunkRows.map((c) => c.id),
      ),
    ),
  );
  for (let i = 0; i < chunkRows.length; i += 2000)
    await tx
      .insert(schema.conversation_chunk)
      .values(chunkRows.slice(i, i + 2000))
      .onConflictDoUpdate({
        target: schema.conversation_chunk.id,
        set: {
          transcript: sql`excluded.transcript`,
          timestamp: sql`excluded.timestamp`,
        },
      });

  // A Specific Details chat over the conversations it quotes: its follow-ups read the same
  // message store the seeded turns are in.
  const chatId = child(pid, "chat");
  const [found] = await tx
    .select({ deleted_at: schema.project_chat.deleted_at })
    .from(schema.project_chat)
    .where(eq(schema.project_chat.id, chatId));
  if (found?.deleted_at) return;
  if (!found)
    await tx.insert(schema.project_chat).values({
      id: chatId,
      name: chat.name,
      project_id: pid,
      chat_mode: "deep_dive",
      auto_select: false,
      user_created: ownerUserId,
      date_created: nowIso,
    });
  const turnId = (i: number) => child(pid, `chat-message:${i}`);
  const retired = Array.from({ length: MAX_SEEDED_TURNS }, (_, i) => i)
    .filter((i) => i >= chat.turns.length)
    .map(turnId);
  await tx
    .delete(schema.project_chat_message)
    .where(inArray(schema.project_chat_message.id, retired));
  // The seeded turns sit just after the chat's creation, before anything the user adds.
  const [created] = await tx
    .select({ at: schema.project_chat.date_created })
    .from(schema.project_chat)
    .where(eq(schema.project_chat.id, chatId));
  const base = Date.parse(created?.at ?? nowIso);
  await tx
    .insert(schema.project_chat_message)
    .values(
      chat.turns.map((t, i) => ({
        id: turnId(i),
        project_chat_id: chatId,
        message_from: t.from,
        text: t.text,
        date_created: new Date(base + i * 1000).toISOString(),
      })),
    )
    .onConflictDoUpdate({
      target: schema.project_chat_message.id,
      set: { message_from: sql`excluded.message_from`, text: sql`excluded.text` },
    });
  const wanted = chat.conversation_keys.map(convId);
  const linked = new Set(
    (
      await tx
        .select({ id: schema.project_chat_conversation.conversation_id })
        .from(schema.project_chat_conversation)
        .where(eq(schema.project_chat_conversation.project_chat_id, chatId))
    ).map((r) => r.id),
  );
  const missing = wanted.filter((c) => !linked.has(c));
  if (missing.length)
    await tx
      .insert(schema.project_chat_conversation)
      .values(missing.map((c) => ({ project_chat_id: chatId, conversation_id: c })));
}

/**
 * Who a workspace's copy belongs to: the workspace's creator, or for a workspace with no
 * recorded creator its longest-standing owner. Null when neither exists (a workspace staff
 * seeded for a demo); such a workspace gets no copy.
 */
export async function sampleOwner(db: Db, workspaceId: string): Promise<SampleOwner | null> {
  const [creator] = await db
    .select({ appUserId: schema.app_user.id, userId: schema.app_user.directus_user_id })
    .from(schema.workspace)
    .innerJoin(schema.app_user, eq(schema.app_user.id, schema.workspace.created_by))
    .where(eq(schema.workspace.id, workspaceId));
  if (creator?.userId) return { appUserId: creator.appUserId, userId: creator.userId };
  const [owner] = await db
    .select({ appUserId: schema.app_user.id, userId: schema.app_user.directus_user_id })
    .from(schema.workspace_membership)
    .innerJoin(schema.app_user, eq(schema.app_user.id, schema.workspace_membership.user_id))
    .where(
      and(
        eq(schema.workspace_membership.workspace_id, workspaceId),
        eq(schema.workspace_membership.role, "owner"),
        eq(schema.workspace_membership.source, "direct"),
        isNull(schema.workspace_membership.deleted_at),
      ),
    )
    .orderBy(asc(schema.workspace_membership.created_at))
    .limit(1);
  return owner?.userId ? { appUserId: owner.appUserId, userId: owner.userId } : null;
}

export interface BackfillOptions {
  readonly now: Date;
  /** Organisations that never get a copy: the synthetic demo and preview samples. */
  readonly excludeOrgIds?: readonly string[];
  /** Workspaces per query; each is seeded in its own transaction. */
  readonly batchSize?: number;
  /** Stops starting new batches after this long; the next run carries on. */
  readonly budgetMs?: number;
}

export interface BackfillReport {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

/**
 * Gives every live workspace without a copy its copy, then brings copies of an older
 * fixture up to date, in batches. A workspace whose copy was deleted is not a candidate
 * (the deleted row still names it), so it is never given another. Safe to run as often as
 * wanted: a second run over a finished backfill reads two empty pages.
 */
export async function backfillBestPractices(
  db: Db,
  opts: BackfillOptions,
  onError: (err: unknown, workspaceId: string) => void = () => {},
): Promise<BackfillReport> {
  const report: BackfillReport = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const batch = opts.batchSize ?? 100;
  const deadline = performance.now() + (opts.budgetMs ?? 4 * 60_000);
  const excluded = [...(opts.excludeOrgIds ?? [])];
  const { workspace, org, project: p } = schema;
  const tally = (status: BestPracticesSummary["status"]) => {
    if (status === "created") report.created++;
    else if (status === "updated") report.updated++;
    else report.skipped++;
  };

  let after = "00000000-0000-0000-0000-000000000000";
  while (performance.now() < deadline) {
    const rows = await db
      .select({ id: workspace.id })
      .from(workspace)
      .innerJoin(org, eq(org.id, workspace.org_id))
      .where(
        and(
          isNull(workspace.deleted_at),
          isNull(org.deleted_at),
          sql`${workspace.id} > ${after}`,
          excluded.length ? notInArray(workspace.org_id, excluded) : undefined,
          sql`not exists (select 1 from ${p} where ${p.workspace_id} = ${workspace.id}
            and ${p.is_sample} and ${p.sample_version} like ${`${VERSION_PREFIX}%`})`,
        ),
      )
      .orderBy(asc(workspace.id))
      .limit(batch);
    for (const { id } of rows) {
      try {
        const owner = await sampleOwner(db, id);
        if (!owner) report.skipped++;
        else tally((await seedBestPractices(db, owner, id, opts.now)).status);
      } catch (err) {
        report.failed++;
        onError(err, id);
      }
    }
    if (rows.length < batch) break;
    after = rows[rows.length - 1]?.id ?? after;
  }

  // Older fixtures' live copies, found by their stamp.
  let afterProject = "00000000-0000-0000-0000-000000000000";
  while (performance.now() < deadline) {
    const rows = await db
      .select({ id: p.id, workspaceId: p.workspace_id, owner: p.directus_user_id })
      .from(p)
      .where(
        and(
          eq(p.is_sample, true),
          isNull(p.deleted_at),
          sql`${p.sample_version} like ${`${VERSION_PREFIX}%`}`,
          sql`${p.sample_version} <> ${BEST_PRACTICES_VERSION}`,
          sql`${p.id} > ${afterProject}`,
        ),
      )
      .orderBy(asc(p.id))
      .limit(batch);
    for (const row of rows) {
      try {
        tally(await refreshCopy(db, row.id, row.owner, opts.now));
      } catch (err) {
        report.failed++;
        onError(err, row.workspaceId ?? row.id);
      }
    }
    if (rows.length < batch) break;
    afterProject = rows[rows.length - 1]?.id ?? afterProject;
  }
  return report;
}

/** An older fixture's copy, by its project id: ids hang off it, wherever the project lives now. */
async function refreshCopy(
  db: Db,
  pid: string,
  ownerUserId: string | null,
  now: Date,
): Promise<BestPracticesSummary["status"]> {
  return db.transaction(async (tx) => {
    const row = await lockCopy(tx, pid);
    if (!row || row.deleted_at) return "deleted";
    if (row.version === BEST_PRACTICES_VERSION) return "current";
    await rewriteCopy(tx, pid, ownerUserId, now);
    return "updated";
  });
}
