import { ForbiddenError, NotFoundError, newId } from "@dembrane/core";
import { schema } from "@dembrane/db";
import { directusTime } from "@dembrane/http";
import { pydanticIso } from "@dembrane/legacy-shape";
import { effectiveLegalBasis, isExternalClient } from "@dembrane/projects";
import { enqueueConversationEvent, webhooksStorage } from "@dembrane/webhooks";
import { and, eq, inArray } from "drizzle-orm";
import { createChunk, deleteChunk, type NewChunk, NOT_OPEN } from "../chunks";
import type { ConversationsDeps } from "../deps";
import { finishConversation } from "../pipeline/defs";
import { type ChunkRow, type ConversationRow, conversationStore, transaction } from "../storage";
import { portalStore } from "./storage";

const { conversation, conversation_project_tag, project_tag } = schema;

export type PortalDeps = Pick<
  ConversationsDeps,
  "db" | "jobs" | "now" | "tokens" | "settings" | "audio" | "audioUrls" | "logger"
>;

/** PublicConversationSchema: what a participant may see of their conversation. */
export function publicConversation(c: ConversationRow) {
  return {
    id: c.id,
    project_id: c.project_id,
    title: c.title,
    description: null,
    participant_email: c.participant_email,
    participant_name: c.participant_name,
    is_anonymized: c.is_anonymized,
  };
}

/** PublicConversationChunkSchema. */
export function publicChunk(c: ChunkRow) {
  return {
    id: c.id,
    conversation_id: c.conversation_id,
    path: c.path,
    transcript: c.transcript,
    timestamp: pydanticIso(c.timestamp),
    source: c.source,
  };
}

export interface InitiateInput {
  readonly name: string;
  readonly email: string | null;
  readonly userAgent: string | null;
  readonly tagIds: readonly string[];
  readonly source: string | null;
}

/**
 * conversation_service.create for the portal. Tags are attached only when they belong
 * to the project (L-6: the Python attached any tag id it was given); the webhook for
 * conversation.started is queued in the same commit as the row.
 */
export async function initiate(d: PortalDeps, projectId: string, input: InitiateInput) {
  const store = conversationStore(d.db);
  const project = await store.project(projectId);
  // project_service raised ProjectNotFoundException here, which the route did not catch.
  if (!project) throw new Error(`project ${projectId} not found`);
  if (project.is_conversation_allowed !== true) throw new ForbiddenError(NOT_OPEN);
  const id = newId();
  const now = d.now().toISOString();
  const row = await transaction(d.db, async (tx) => {
    const [created] = await tx.db
      .insert(conversation)
      .values({
        id,
        project_id: project.id,
        participant_name: input.name,
        participant_email: input.email,
        participant_user_agent: input.userAgent,
        source: input.source,
        is_anonymized: Boolean(project.anonymize_transcripts),
        created_at: now,
        updated_at: now,
      })
      .returning();
    const wanted = [...new Set(input.tagIds)];
    if (wanted.length) {
      const own = await tx.db
        .select({ id: project_tag.id })
        .from(project_tag)
        .where(
          and(
            eq(project_tag.project_id, project.id),
            inArray(project_tag.id, wanted.filter(isUuidLike)),
          ),
        );
      const ownIds = new Set(own.map((t) => t.id));
      const tags = input.tagIds.filter((t) => ownIds.has(t));
      if (tags.length)
        await tx.db
          .insert(conversation_project_tag)
          .values(tags.map((t) => ({ conversation_id: id, project_tag_id: t })));
    }
    await enqueueConversationEvent(
      {
        store: webhooksStorage(tx.db),
        jobs: d.jobs,
        now: d.now,
        enabled: d.settings.webhooksEnabled,
        dashboardUrl: d.settings.dashboardUrl,
      },
      project.id,
      id,
      "conversation.started",
      { tx: tx.sql },
    );
    return created as ConversationRow;
  });
  return {
    conversation: row,
    token: d.tokens.issue({ conversationId: id, projectId: project.id }),
  };
}

const isUuidLike = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

/** GET /participant/projects/:id: the portal's configuration of an open project. */
export async function publicProject(d: PortalDeps, projectId: string) {
  const store = conversationStore(d.db);
  const project = await store.project(projectId);
  if (!project) throw new NotFoundError("Project not found");
  if (project.is_conversation_allowed !== true) throw new ForbiddenError(NOT_OPEN);
  const portal = portalStore(d.db);
  const [tags, rows] = await Promise.all([
    portal.projectTags(project.id),
    portal.cascade(project.workspace_id, project.directus_user_id),
  ]);
  const legal = effectiveLegalBasis({ project, workspace: rows.workspace, owner: rows.owner });
  let organiser: string | null = null;
  if (rows.workspace?.data_owner_org_name) organiser = rows.workspace.data_owner_org_name;
  else if (rows.workspace && isExternalClient(rows.workspace)) organiser = null;
  else organiser = rows.org?.name ?? null;
  let logo: string | null = null;
  if (rows.workspace?.logo_url) logo = rows.workspace.logo_url;
  else if (rows.owner?.whitelabel_logo) logo = rows.owner.whitelabel_logo;
  // The event invitation: only a paid workspace may switch it off; the tier is read
  // only when the project did switch it off, and an unknown tier is never gated.
  let cta = true;
  if (project.is_dembrane_event_cta_enabled === false) {
    const tier = await portal.tier(rows.workspace?.billing_account_id ?? null);
    cta = tier === "free";
  }
  return {
    id: project.id,
    language: project.language,
    tags: tags.map((t) => ({ id: t.id, text: t.text })),
    is_conversation_allowed: project.is_conversation_allowed,
    is_get_reply_enabled: project.is_get_reply_enabled,
    is_verify_enabled: project.is_verify_enabled,
    is_verify_on_finish_enabled: project.is_verify_on_finish_enabled,
    is_project_notification_subscription_allowed:
      project.is_project_notification_subscription_allowed,
    verification_topics: [],
    is_dembrane_event_cta_enabled: cta,
    default_conversation_tutorial_slug: project.default_conversation_tutorial_slug,
    conversation_ask_for_participant_name_label:
      project.conversation_ask_for_participant_name_label,
    default_conversation_ask_for_participant_name:
      project.default_conversation_ask_for_participant_name,
    default_conversation_ask_for_participant_email:
      project.default_conversation_ask_for_participant_email,
    default_conversation_title: project.default_conversation_title,
    default_conversation_description: project.default_conversation_description,
    default_conversation_finish_text: project.default_conversation_finish_text,
    whitelabel_logo_url: logo,
    legal_basis: legal.legal_basis,
    privacy_policy_url: legal.privacy_policy_url,
    organiser_name: organiser,
  };
}

/**
 * A participant's conversation inside a project. H-5: the Python never checked that
 * the conversation belongs to the project in the path, so any open project id read any
 * tenant's conversation; the project is now part of the lookup.
 */
async function ownConversation(d: PortalDeps, projectId: string, conversationId: string) {
  const store = conversationStore(d.db);
  const project = await store.project(projectId);
  const conv = await store.conversation(conversationId);
  if (!project || !conv || conv.project_id !== project.id)
    throw new NotFoundError("Conversation not found");
  if (project.is_conversation_allowed !== true) throw new ForbiddenError(NOT_OPEN);
  return conv;
}

export async function participantConversation(d: PortalDeps, projectId: string, id: string) {
  return publicConversation(await ownConversation(d, projectId, id));
}

export async function participantChunks(d: PortalDeps, projectId: string, id: string) {
  await ownConversation(d, projectId, id);
  const chunks = await conversationStore(d.db).chunksNewestFirst(id, 1200);
  return chunks.map(publicChunk);
}

/**
 * The replies under a conversation, for the portal. Directus served these to anyone by id
 * (spec C-6); here the conversation must belong to the project and the participant token,
 * once required, must name it. A project closed to new conversations still shows replies.
 */
export async function participantReplies(d: PortalDeps, projectId: string, id: string) {
  const conv = await conversationStore(d.db).conversation(id);
  if (!conv || conv.project_id !== projectId) throw new NotFoundError("Conversation not found");
  const rows = await portalStore(d.db).replies(conv.id);
  return rows.map((r) => ({ ...r, date_created: directusTime(r.date_created) }));
}

/**
 * DELETE a chunk. M-2: the chunk must belong to the conversation (the Python deleted any
 * chunk id); the conversation must belong to the project, as before.
 */
export async function removeChunk(d: PortalDeps, projectId: string, id: string, chunkId: string) {
  const store = conversationStore(d.db);
  const conv = await store.conversation(id);
  if (!conv || conv.project_id !== projectId) throw new NotFoundError("Conversation not found");
  const chunk = await store.chunk(chunkId);
  if (!chunk || chunk.conversation_id !== conv.id) return;
  await deleteChunk(d, chunkId);
}

export async function addChunk(
  d: PortalDeps,
  input: NewChunk,
  opts: { chunkId?: string; usePiiRedaction?: boolean } = {},
) {
  return createChunk(d, input, {
    chunkId: opts.chunkId ?? newId(),
    ...(opts.usePiiRedaction !== undefined && { usePiiRedaction: opts.usePiiRedaction }),
  });
}

/**
 * The finish signal: queued whatever the conversation, as the Python sent the task; the
 * workflow decides. One run per conversation at a time: a second finish while one is
 * queued or running joins it.
 */
export async function requestFinish(d: Pick<ConversationsDeps, "jobs">, conversationId: string) {
  await d.jobs.enqueue(finishConversation, { conversationId }, { singletonKey: conversationId });
}
