import { type Capture, hostDistinctId } from "@dembrane/analytics";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import { eq } from "drizzle-orm";
import { UPLOAD_SOURCE } from "./storage";

const { app_user, conversation, directus_users, host_milestone, project } = schema;

/** The milestone server_first_value_reached announces, and the version of its definition. */
export const FIRST_VALUE = "first_value";
export const FIRST_VALUE_DEFINITION = 1;

/** Who a project's events belong to: the host who created it. */
export interface ProjectOwner {
  readonly directusUserId: string | null;
  readonly email: string | null;
  readonly isSample: boolean;
  readonly language: string | null;
}

/** What the host events read and claim; the database in the app, a fake in unit tests. */
export interface HostEventStore {
  projectOwner(projectId: string): Promise<ProjectOwner | null>;
  /** Seconds of audio as measured so far; null until the duration is known. */
  conversationDuration(conversationId: string): Promise<number | null>;
  /** True for exactly one caller per host and milestone, ever. */
  claimMilestone(
    directusUserId: string,
    milestone: string,
    projectId: string,
    at: Date,
  ): Promise<boolean>;
}

export interface HostEventDeps {
  readonly store: HostEventStore;
  readonly capture: Capture;
  readonly logger: Logger;
  readonly now: () => Date;
}

export function hostEventStore(db: Db): HostEventStore {
  return {
    async projectOwner(projectId) {
      const [row] = await db
        .select({
          directusUserId: project.directus_user_id,
          appEmail: app_user.email,
          directusEmail: directus_users.email,
          isSample: project.is_sample,
          language: project.language,
        })
        .from(project)
        .leftJoin(app_user, eq(app_user.directus_user_id, project.directus_user_id))
        .leftJoin(directus_users, eq(directus_users.id, project.directus_user_id))
        .where(eq(project.id, projectId))
        .limit(1);
      if (!row) return null;
      return {
        directusUserId: row.directusUserId,
        email: row.appEmail || row.directusEmail || null,
        isSample: row.isSample,
        language: row.language,
      };
    },

    async conversationDuration(conversationId) {
      const [row] = await db
        .select({ duration: conversation.duration })
        .from(conversation)
        .where(eq(conversation.id, conversationId))
        .limit(1);
      return row?.duration ?? null;
    },

    async claimMilestone(directusUserId, milestone, projectId, at) {
      const rows = await db
        .insert(host_milestone)
        .values({
          directus_user_id: directusUserId,
          milestone,
          project_id: projectId,
          reached_at: at.toISOString(),
        })
        .onConflictDoNothing()
        .returning({ id: host_milestone.directus_user_id });
      return rows.length > 0;
    },
  };
}

/** Where a conversation came from, as the events name it. */
export const conversationOrigin = (source: string | null | undefined): "portal" | "upload" =>
  source === UPLOAD_SOURCE ? "upload" : "portal";

/**
 * A conversation was created through the portal or a dashboard upload:
 * server_conversation_created for the project's creator, and server_first_value_reached
 * the first time any project they created (not a sample) gets one. The milestone row is
 * claimed before the event is sent, so a retry or a second conversation at the same
 * moment never sends it twice; a capture lost on the way is not sent again.
 */
export async function conversationCreated(
  d: HostEventDeps,
  c: { conversationId: string; projectId: string; source: string | null; byHost: boolean },
): Promise<void> {
  const owner = await d.store.projectOwner(c.projectId);
  if (!owner?.directusUserId) return;
  const distinctId = hostDistinctId(owner.email, owner.directusUserId);
  await d.capture(distinctId, "server_conversation_created", {
    conversation_id: c.conversationId,
    project_id: c.projectId,
    source: conversationOrigin(c.source),
    by_host: c.byHost,
  });
  if (owner.isSample) return;
  const first = await d.store.claimMilestone(
    owner.directusUserId,
    FIRST_VALUE,
    c.projectId,
    d.now(),
  );
  if (!first) return;
  await d.capture(distinctId, "server_first_value_reached", {
    project_id: c.projectId,
    definition_version: FIRST_VALUE_DEFINITION,
  });
}

/** Every chunk of a finished conversation is transcribed: server_transcript_ready for its project's creator. */
export async function transcriptReady(
  d: HostEventDeps,
  c: { conversationId: string; projectId: string },
): Promise<void> {
  const owner = await d.store.projectOwner(c.projectId);
  if (!owner?.directusUserId) return;
  const duration = await d.store.conversationDuration(c.conversationId);
  await d.capture(hostDistinctId(owner.email, owner.directusUserId), "server_transcript_ready", {
    conversation_id: c.conversationId,
    project_id: c.projectId,
    duration_s: duration === null ? null : Math.round(duration),
    language: owner.language,
  });
}

/** Runs a host event after the response, as metering does: it never slows or fails the caller. */
export function afterResponse(logger: Logger, event: string, run: () => Promise<void>): void {
  setTimeout(() => {
    run().catch((err) => logger.warn({ err, event }, "host event not sent"));
  }, 0);
}
