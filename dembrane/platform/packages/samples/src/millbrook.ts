import { type Db, schema } from "@dembrane/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import chat from "../fixtures/millbrook/chat.json";
import conversations from "../fixtures/millbrook/conversations.json";
import project from "../fixtures/millbrook/project.json";
import report from "../fixtures/millbrook/report.md" with { type: "text" };

/**
 * The sample every PR preview carries, so a reviewer opens a project that already has
 * conversations, a report and a chat instead of an empty dashboard. It is the fictional
 * Millbrook Citizens' Assembly (fixtures/millbrook, written by scripts/generate-millbrook.ts:
 * no real people, places or organisations), in its own fictional org, Acme Civic (sample),
 * that the preview admin owns, so it stands whether or not the accounts demo seeds.
 *
 * Every id derives from a fixed name, so a rerun writes the same rows. A rerun also puts
 * the fixture back: edits, deletions, extra chunks and chat turns made on a preview are
 * undone on its next deploy, and text from an older fixture is replaced, not left behind.
 */

export const MILLBROOK = {
  org: project.org,
  workspace: project.workspace,
  project: project.project,
  conversations: conversations.length,
  chatMessages: chat.turns.length,
} as const;

const id = (kind: string) => Bun.randomUUIDv5(`dembrane:sample:millbrook:${kind}`, "url");

export const MILLBROOK_IDS = {
  org: id("org"),
  billing: id("billing"),
  orgOwner: id("org-owner"),
  workspace: id("workspace"),
  workspaceOwner: id("workspace-owner"),
  project: id("project"),
  chat: id("chat"),
  conversation: (key: string) => id(`conversation:${key}`),
};

/** Every conversation the sample holds, so a caller can tell them from ones added since. */
export const MILLBROOK_CONVERSATION_IDS: readonly string[] = conversations.map((c) =>
  MILLBROOK_IDS.conversation(c.key),
);

export interface SampleOwner {
  /** directus_users.id: projects, reports and chats name their creator by it. */
  readonly userId: string;
  /** app_user.id: memberships reference it. */
  readonly appUserId: string;
}

export interface SampleSummary {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly conversations: number;
  readonly chunks: number;
  readonly report_id: string;
  readonly chat_id: string;
}

const at = (start: string, seconds: number) =>
  new Date(Date.parse(start) + seconds * 1000).toISOString();

export async function seedMillbrook(db: Db, owner: SampleOwner, now: Date): Promise<SampleSummary> {
  const nowIso = now.toISOString();
  const I = MILLBROOK_IDS;
  return db.transaction(async (tx) => {
    await tx
      .insert(schema.org)
      .values({ id: I.org, name: MILLBROOK.org, created_by: owner.appUserId, created_at: nowIso })
      .onConflictDoUpdate({
        target: schema.org.id,
        set: { name: MILLBROOK.org, deleted_at: null },
      });
    // A paid tier without a subscription: nothing is capped or locked, and billing has
    // nothing to charge or downgrade.
    const billing = {
      tier: "changemaker",
      payment_mode: "offline",
      status: "active",
      tier_expires_at: null,
      deleted_at: null,
    };
    await tx
      .insert(schema.billing_account)
      .values({ id: I.billing, org_id: I.org, created_by: owner.appUserId, ...billing })
      .onConflictDoUpdate({ target: schema.billing_account.id, set: billing });
    await tx
      .insert(schema.org_membership)
      .values({ id: I.orgOwner, org_id: I.org, user_id: owner.appUserId, role: "owner" })
      .onConflictDoUpdate({
        target: schema.org_membership.id,
        set: { role: "owner", deleted_at: null },
      });
    const workspace = { name: MILLBROOK.workspace, deleted_at: null };
    await tx
      .insert(schema.workspace)
      .values({
        id: I.workspace,
        org_id: I.org,
        billing_account_id: I.billing,
        visibility: "open_to_organisation",
        is_default: true,
        created_by: owner.appUserId,
        created_at: nowIso,
        ...workspace,
      })
      .onConflictDoUpdate({ target: schema.workspace.id, set: workspace });
    // The workspace list is membership based, even for an org owner.
    const member = { role: "owner", source: "direct", deleted_at: null, expires_at: null };
    await tx
      .insert(schema.workspace_membership)
      .values({
        id: I.workspaceOwner,
        workspace_id: I.workspace,
        user_id: owner.appUserId,
        ...member,
      })
      .onConflictDoUpdate({ target: schema.workspace_membership.id, set: member });

    const proj = {
      name: MILLBROOK.project,
      language: project.language,
      context: project.context,
      workspace_id: I.workspace,
      directus_user_id: owner.userId,
      is_conversation_allowed: true,
      deleted_at: null,
    };
    await tx
      .insert(schema.project)
      .values({ id: I.project, created_at: nowIso, ...proj })
      .onConflictDoUpdate({ target: schema.project.id, set: proj });

    const convRows = conversations.map((c) => {
      const last = c.chunks[c.chunks.length - 1]?.at_s ?? 0;
      return {
        id: I.conversation(c.key),
        project_id: I.project,
        participant_name: c.name,
        title: c.name,
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
        deleted_at: null,
      };
    });
    await tx
      .insert(schema.conversation)
      .values(convRows)
      .onConflictDoUpdate({
        target: schema.conversation.id,
        set: {
          project_id: sql`excluded.project_id`,
          participant_name: sql`excluded.participant_name`,
          title: sql`excluded.title`,
          merged_transcript: sql`excluded.merged_transcript`,
          summary: sql`excluded.summary`,
          duration: sql`excluded.duration`,
          is_finished: true,
          is_all_chunks_transcribed: true,
          is_audio_processing_finished: true,
          is_over_cap: false,
          deleted_at: null,
        },
      });

    const chunkRows = conversations.flatMap((c) =>
      c.chunks.map((x, i) => ({
        id: id(`chunk:${c.key}:${i}`),
        conversation_id: I.conversation(c.key),
        transcript: x.text,
        timestamp: at(c.started_at, x.at_s),
        created_at: at(c.started_at, x.at_s),
      })),
    );
    // Chunks the fixture no longer has (an older, longer fixture, or one added on the
    // preview) would otherwise stay in the transcript view and in search.
    await tx.delete(schema.conversation_chunk).where(
      and(
        inArray(
          schema.conversation_chunk.conversation_id,
          convRows.map((c) => c.id),
        ),
        notInArray(
          schema.conversation_chunk.id,
          chunkRows.map((c) => c.id),
        ),
      ),
    );
    // Well under Postgres's 65535 bind parameters per statement at five columns a row.
    for (let i = 0; i < chunkRows.length; i += 2000)
      await tx
        .insert(schema.conversation_chunk)
        .values(chunkRows.slice(i, i + 2000))
        .onConflictDoUpdate({
          target: schema.conversation_chunk.id,
          set: {
            conversation_id: sql`excluded.conversation_id`,
            transcript: sql`excluded.transcript`,
            timestamp: sql`excluded.timestamp`,
          },
        });

    // project_report ids are a sequence, so the sample report is found by its project.
    const [found] = await tx
      .select({ id: schema.project_report.id })
      .from(schema.project_report)
      .where(
        and(
          eq(schema.project_report.project_id, I.project),
          eq(schema.project_report.kind, "report"),
        ),
      )
      .orderBy(schema.project_report.id)
      .limit(1);
    const rep = {
      content: report,
      status: "published",
      language: project.language,
      user_created: owner.userId,
      error_code: null,
      error_message: null,
      deleted_at: null,
    };
    let reportId: bigint;
    if (found) {
      reportId = found.id;
      await tx.update(schema.project_report).set(rep).where(eq(schema.project_report.id, found.id));
    } else {
      const [row] = await tx
        .insert(schema.project_report)
        .values({
          project_id: I.project,
          kind: "report",
          date_created: nowIso,
          date_updated: nowIso,
          ...rep,
        })
        .returning({ id: schema.project_report.id });
      reportId = (row as { id: bigint }).id;
    }

    // A Specific Details chat over the conversations it quotes, answered from them.
    const chatRow = {
      name: chat.name,
      project_id: I.project,
      chat_mode: "deep_dive",
      auto_select: false,
      user_created: owner.userId,
      deleted_at: null,
    };
    await tx
      .insert(schema.project_chat)
      .values({ id: I.chat, date_created: nowIso, ...chatRow })
      .onConflictDoUpdate({ target: schema.project_chat.id, set: chatRow });
    const turnIds = chat.turns.map((_, i) => id(`chat-message:${i}`));
    await tx
      .delete(schema.project_chat_message)
      .where(
        and(
          eq(schema.project_chat_message.project_chat_id, I.chat),
          notInArray(schema.project_chat_message.id, turnIds),
        ),
      );
    await tx
      .insert(schema.project_chat_message)
      .values(
        chat.turns.map((t, i) => ({
          id: turnIds[i] as string,
          project_chat_id: I.chat,
          message_from: t.from,
          text: t.text,
          date_created: new Date(now.getTime() + i * 1000).toISOString(),
        })),
      )
      .onConflictDoUpdate({
        target: schema.project_chat_message.id,
        set: { message_from: sql`excluded.message_from`, text: sql`excluded.text` },
      });
    const wanted = chat.conversation_keys.map((k) => I.conversation(k));
    // The chat answers from exactly the conversations it quotes, so a link an older fixture
    // or a reviewer added goes.
    await tx
      .delete(schema.project_chat_conversation)
      .where(
        and(
          eq(schema.project_chat_conversation.project_chat_id, I.chat),
          notInArray(schema.project_chat_conversation.conversation_id, wanted),
        ),
      );
    const linked = new Set(
      (
        await tx
          .select({ id: schema.project_chat_conversation.conversation_id })
          .from(schema.project_chat_conversation)
          .where(
            and(
              eq(schema.project_chat_conversation.project_chat_id, I.chat),
              inArray(schema.project_chat_conversation.conversation_id, wanted),
            ),
          )
      ).map((r) => r.id),
    );
    const missing = wanted.filter((c) => !linked.has(c));
    if (missing.length)
      await tx
        .insert(schema.project_chat_conversation)
        .values(missing.map((c) => ({ project_chat_id: I.chat, conversation_id: c })));

    return {
      workspace_id: I.workspace,
      project_id: I.project,
      conversations: convRows.length,
      chunks: chunkRows.length,
      report_id: String(reportId),
      chat_id: I.chat,
    };
  });
}
