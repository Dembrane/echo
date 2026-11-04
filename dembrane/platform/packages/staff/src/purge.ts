import { DELETION_GRACE_DAYS, deletionRequestedOn } from "@dembrane/auth";
import { hasLiveMollieSubscription } from "@dembrane/billing";
import type { Db } from "@dembrane/db";
import { schema } from "@dembrane/db";
import type { Logger } from "@dembrane/observability";
import { defineJob, type Queue } from "@dembrane/queue";
import type { ObjectStorage } from "@dembrane/storage";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { STAFF_ROLE } from "./grant";
import { erasePerson } from "./privacy";
import { type Person, privacyStorage } from "./privacy-storage";

const {
  agent_insight,
  agent_loop,
  agent_loop_run,
  agent_memory,
  billing_account,
  canvas_config_revision,
  canvas_generation,
  conversation,
  conversation_chunk,
  conversation_reply,
  free_usage,
  methodology,
  methodology_version,
  org,
  popcorn_tensions_cache,
  processing_status,
  project,
  project_goal_revision,
  project_report,
  project_report_metric,
  project_report_notification_participants,
  project_webhook,
  verification_topic,
  workspace,
} = schema;

/** Daily: deletes the accounts whose in-app deletion request is past its grace period. */
export const purgeDeletedAccounts = defineJob("staff.purge-deleted-accounts", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 30 * 60,
});

export interface AccountPurgeDeps {
  readonly db: Db;
  /** Participant audio, where the purged conversations' recordings are. */
  readonly audio: ObjectStorage;
  /** The object key of a stored audio path (conversations' AudioUrls.keyOf). */
  readonly audioKeyOf: (path: string) => string;
  /** The file bucket: avatars and exports the erasure deletes. */
  readonly files: ObjectStorage;
  readonly logger: Logger;
  readonly now?: () => Date;
}

interface Due {
  readonly person: Person;
  readonly requestedOn: Date;
}

/** What one purge removed, logged per account; ids and counts only. */
export interface PurgeResult {
  readonly workspaces_deleted: number;
  readonly workspaces_kept_for_billing: number;
  readonly orgs_deleted: number;
  readonly projects_deleted: number;
  readonly conversations_deleted: number;
  readonly audio_deleted: number;
  readonly audio_not_deleted: number;
  readonly files_deleted: number;
  readonly orgs_left_without_admin: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Suspended accounts whose note is an in-app deletion request older than the grace period. */
async function dueDeletions(db: Db, now: Date): Promise<Due[]> {
  const cutoff = now.getTime() - DELETION_GRACE_DAYS * DAY_MS;
  const rows = await db.execute<{
    id: string;
    email: string | null;
    description: string | null;
    role: string | null;
    app_id: string | null;
  }>(sql`
    select d.id, coalesce(d.email, a.email, u.email) as email, d.description, r.name as role,
      a.id as app_id
    from directus_users d
    left join directus_roles r on r.id = d.role
    left join app_user a on a.directus_user_id = d.id
    left join auth_user u on u.id = d.id
    where d.status = 'suspended'
      and d.description ~ '^deletion requested in-app on [0-9]{4}-[0-9]{2}-[0-9]{2}, purge within [0-9]+ days$'
    order by d.id`);
  const due: Due[] = [];
  for (const r of rows) {
    const requestedOn = deletionRequestedOn(r.description);
    if (!requestedOn || requestedOn.getTime() > cutoff) continue;
    due.push({
      person: {
        id: r.id,
        appId: r.app_id,
        email: (r.email ?? "").trim().toLowerCase(),
        role: r.role,
      },
      requestedOn,
    });
  }
  return due;
}

/**
 * Workspaces only this person could use: they hold a live membership, nobody else holds a
 * live one (staff support sessions aside), nobody else is a member of one of its projects,
 * and nobody else is in its organisation. Anything else belongs to the organisation.
 */
async function soleWorkspaces(db: Db, appId: string) {
  const rows = await db.execute<{
    id: string;
    org_id: string | null;
    billing_account_id: string | null;
  }>(sql`
    select w.id, w.org_id, w.billing_account_id from workspace w
    where exists (
        select 1 from workspace_membership m
        where m.workspace_id = w.id and m.user_id = ${appId} and m.deleted_at is null)
      and not exists (
        select 1 from workspace_membership x
        where x.workspace_id = w.id and x.user_id <> ${appId} and x.deleted_at is null
          and coalesce(x.source, '') <> 'staff_support')
      and not exists (
        select 1 from project p join project_membership pm on pm.project_id = p.id
        where p.workspace_id = w.id and pm.user_id <> ${appId})
      and (w.org_id is null or not exists (
        select 1 from org_membership om
        where om.org_id = w.org_id and om.user_id <> ${appId} and om.deleted_at is null))
    order by w.id`);
  return [...rows];
}

/** Projects from before workspaces that only this person created and nobody else joined. */
async function soleLegacyProjects(db: Db, directusId: string) {
  const rows = await db.execute<{ id: string }>(sql`
    select p.id from project p
    where p.workspace_id is null and p.directus_user_id = ${directusId}
      and not exists (select 1 from project_membership pm where pm.project_id = p.id)`);
  return [...rows].map((r) => r.id);
}

/** Billing rows that are bookkeeping records: a Mollie customer, or an overage period. */
async function billingWithHistory(db: Db, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db
    .select({ id: billing_account.id })
    .from(billing_account)
    .where(
      and(
        inArray(billing_account.id, [...ids]),
        or(
          isNotNull(billing_account.mollie_customer_id),
          isNotNull(billing_account.mollie_subscription_id),
          sql`exists (select 1 from recording_overage o where o.billing_account_id = ${billing_account.id})`,
        ),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** The billing accounts a workspace is tied to, both directions. */
async function billingOf(db: Db, workspaceIds: readonly string[]) {
  if (!workspaceIds.length) return [];
  const linked = await db
    .select({ id: workspace.billing_account_id, ws: workspace.id })
    .from(workspace)
    .where(inArray(workspace.id, [...workspaceIds]));
  const owned = await db
    .select({ id: billing_account.id, ws: billing_account.workspace_id })
    .from(billing_account)
    .where(inArray(billing_account.workspace_id, [...workspaceIds]));
  return [...linked, ...owned].filter((r): r is { id: string; ws: string } =>
    Boolean(r.id && r.ws),
  );
}

/**
 * Deletes projects with everything in them, and returns the audio keys to delete once the
 * transaction commits. Conversations, chunks, chats, tags, analysis and maps go by ON DELETE
 * CASCADE; the rows that only lose their project (reports, webhooks, topics, assistant loops)
 * are deleted here first, since what they hold is the person's content.
 */
async function deleteProjects(
  tx: Tx,
  projectIds: readonly string[],
  audioKeyOf: (path: string) => string,
  logger: Logger,
): Promise<{ projects: number; conversations: number; audioKeys: string[] }> {
  if (!projectIds.length) return { projects: 0, conversations: 0, audioKeys: [] };
  const ids = [...projectIds];
  const convs = await tx
    .select({ id: conversation.id, merged: conversation.merged_audio_path })
    .from(conversation)
    .where(inArray(conversation.project_id, ids));
  const convIds = convs.map((c) => c.id);
  const chunkPaths = convIds.length
    ? await tx
        .select({ path: conversation_chunk.path })
        .from(conversation_chunk)
        .where(inArray(conversation_chunk.conversation_id, convIds))
    : [];
  const audioKeys = new Set<string>();
  for (const path of [...convs.map((c) => c.merged), ...chunkPaths.map((c) => c.path)]) {
    if (!path?.trim()) continue;
    try {
      audioKeys.add(audioKeyOf(path));
    } catch (err) {
      logger.warn({ err }, "account purge: an audio path has no object key");
    }
  }

  const reports = await tx
    .select({ id: project_report.id })
    .from(project_report)
    .where(inArray(project_report.project_id, ids));
  const reportIds = reports.map((r) => r.id);
  // The columns pointing at a report are bigint in number mode; report ids fit in it.
  const reportNums = reportIds.map(Number);
  const loops = await tx
    .select({ id: agent_loop.id })
    .from(agent_loop)
    .where(
      or(
        inArray(agent_loop.project_id, ids),
        ...(reportIds.length ? [inArray(agent_loop.report_id, reportNums)] : []),
      ),
    );
  const loopIds = loops.map((l) => l.id);
  if (loopIds.length) {
    await tx.delete(agent_loop_run).where(inArray(agent_loop_run.loop_id, loopIds));
    await tx.delete(popcorn_tensions_cache).where(inArray(popcorn_tensions_cache.loop_id, loopIds));
    await tx.delete(agent_loop).where(inArray(agent_loop.id, loopIds));
  }
  if (reportIds.length) {
    await tx.delete(canvas_generation).where(inArray(canvas_generation.report_id, reportNums));
    await tx
      .delete(canvas_config_revision)
      .where(inArray(canvas_config_revision.report_id, reportNums));
    await tx
      .delete(project_report_metric)
      .where(inArray(project_report_metric.project_report_id, reportNums));
    await tx.delete(project_report).where(inArray(project_report.id, reportIds));
  }
  if (convIds.length) {
    await tx.delete(conversation_reply).where(inArray(conversation_reply.conversation_id, convIds));
  }
  await tx
    .delete(processing_status)
    .where(
      or(
        inArray(processing_status.project_id, ids),
        ...(convIds.length ? [inArray(processing_status.conversation_id, convIds)] : []),
      ),
    );
  await tx.delete(project_webhook).where(inArray(project_webhook.project_id, ids));
  await tx.delete(verification_topic).where(inArray(verification_topic.project_id, ids));
  await tx.delete(project_goal_revision).where(inArray(project_goal_revision.project_id, ids));
  await tx
    .delete(project_report_notification_participants)
    .where(inArray(project_report_notification_participants.project_id, ids));
  await tx.delete(agent_insight).where(inArray(agent_insight.project_id, ids));
  await tx.delete(agent_memory).where(inArray(agent_memory.project_id, ids));
  await tx.delete(project).where(inArray(project.id, ids));
  return { projects: ids.length, conversations: convIds.length, audioKeys: [...audioKeys] };
}

/**
 * Removes one person's sole workspaces and legacy projects with their content, then erases
 * the person the way a staff erasure does. A workspace whose billing holds bookkeeping
 * records is emptied and marked deleted instead, so those records stay; an organisation is
 * deleted only when nothing of it remains and it holds no billing or customer records.
 */
async function purgeOne(d: AccountPurgeDeps, due: Due): Promise<PurgeResult | "skipped"> {
  const { db, logger } = d;
  const p = due.person;
  const sole = p.appId ? await soleWorkspaces(db, p.appId) : [];
  const soleIds = sole.map((w) => w.id);
  const billing = await billingOf(db, soleIds);
  const billingIds = [...new Set(billing.map((b) => b.id))];
  const accounts = billingIds.length
    ? await db.select().from(billing_account).where(inArray(billing_account.id, billingIds))
    : [];
  // A live subscription keeps charging after the account is gone; staff cancel it first.
  if (accounts.some((a) => hasLiveMollieSubscription(a))) {
    logger.warn(
      { signal: "account.purge_skipped", userId: p.id, reason: "live_subscription" },
      "deleted account not purged: a live subscription needs cancelling first",
    );
    return "skipped";
  }
  const history = await billingWithHistory(db, billingIds);
  const keptForBilling = new Set(billing.filter((b) => history.has(b.id)).map((b) => b.ws));
  const legacy = await soleLegacyProjects(db, p.id);
  const now = (d.now ?? (() => new Date()))();

  const content = await db.transaction(async (tx) => {
    const projectIds = soleIds.length
      ? (
          await tx
            .select({ id: project.id })
            .from(project)
            .where(inArray(project.workspace_id, soleIds))
        ).map((r) => r.id)
      : [];
    const removed = await deleteProjects(tx, [...projectIds, ...legacy], d.audioKeyOf, logger);
    if (soleIds.length) {
      await tx.delete(agent_insight).where(inArray(agent_insight.workspace_id, soleIds));
      await tx.delete(agent_memory).where(inArray(agent_memory.workspace_id, soleIds));
      const methods = await tx
        .select({ id: methodology.id })
        .from(methodology)
        .where(inArray(methodology.workspace_id, soleIds));
      if (methods.length) {
        const mids = methods.map((m) => m.id);
        await tx
          .delete(methodology_version)
          .where(inArray(methodology_version.methodology_id, mids));
        await tx.delete(methodology).where(inArray(methodology.id, mids));
      }
    }
    const hardDelete = soleIds.filter((id) => !keptForBilling.has(id));
    const softDelete = soleIds.filter((id) => keptForBilling.has(id));
    if (softDelete.length)
      await tx
        .update(workspace)
        .set({ deleted_at: now.toISOString(), updated_at: now.toISOString() })
        .where(and(inArray(workspace.id, softDelete), isNull(workspace.deleted_at)));
    if (hardDelete.length) {
      // Their own billing rows go with them (ON DELETE CASCADE on billing_account.workspace_id);
      // a linked row no other workspace uses goes after them, with its free usage.
      const linked = billing
        .filter((b) => hardDelete.includes(b.ws) && !history.has(b.id))
        .map((b) => b.id);
      await tx.delete(workspace).where(inArray(workspace.id, hardDelete));
      for (const id of new Set(linked)) {
        const [still] = await tx
          .select({ id: workspace.id })
          .from(workspace)
          .where(eq(workspace.billing_account_id, id))
          .limit(1);
        if (still) continue;
        await tx.delete(free_usage).where(eq(free_usage.billing_account_id, id));
        await tx.delete(billing_account).where(eq(billing_account.id, id));
      }
    }

    let orgsDeleted = 0;
    const orgIds = [...new Set(sole.map((w) => w.org_id).filter((x): x is string => Boolean(x)))];
    for (const orgId of orgIds) {
      const rows = await tx.execute<{ keep: boolean }>(sql`
        select exists (select 1 from workspace w where w.org_id = ${orgId})
          or exists (select 1 from org_membership m
            where m.org_id = ${orgId} and m.user_id <> ${p.appId} and m.deleted_at is null)
          or exists (select 1 from billing_account b where b.org_id = ${orgId}
            and (b.mollie_customer_id is not null or b.mollie_subscription_id is not null
              or exists (select 1 from recording_overage o where o.billing_account_id = b.id)))
          or exists (select 1 from account_document x where x.org_id = ${orgId})
          or exists (select 1 from account_event x where x.org_id = ${orgId})
          or exists (select 1 from account_task x where x.org_id = ${orgId})
          or exists (select 1 from account_ticket x where x.org_id = ${orgId})
          or exists (select 1 from account_demo x where x.org_id = ${orgId})
          or exists (select 1 from account_signature x where x.org_id = ${orgId})
          or exists (select 1 from referral_ledger x where x.partner_team_id = ${orgId})
          or exists (select 1 from training x where x.org_id = ${orgId})
          or exists (select 1 from training_license x where x.org_id = ${orgId}) as keep`);
      if ([...rows][0]?.keep) continue;
      await tx.delete(org).where(eq(org.id, orgId));
      orgsDeleted++;
    }
    return {
      ...removed,
      workspacesDeleted: hardDelete.length,
      workspacesKept: softDelete.length,
      orgsDeleted,
    };
  });

  let audioDeleted = 0;
  for (const key of content.audioKeys)
    try {
      await d.audio.delete(key);
      audioDeleted++;
    } catch (err) {
      logger.warn({ err, userId: p.id }, "account purge: an audio object was not deleted");
    }

  // Nobody else can manage an organisation they were the last admin of; the person asked
  // for their account to go, so it goes, and the count says how many were left that way.
  const erased = await erasePerson({ store: privacyStorage(db), files: d.files, logger }, p, {
    allowOrphanOrgs: true,
  });
  return {
    workspaces_deleted: content.workspacesDeleted,
    workspaces_kept_for_billing: content.workspacesKept,
    orgs_deleted: content.orgsDeleted,
    projects_deleted: content.projects,
    conversations_deleted: content.conversations,
    audio_deleted: audioDeleted,
    audio_not_deleted: content.audioKeys.length - audioDeleted,
    files_deleted: erased.files_deleted,
    orgs_left_without_admin: erased.sole_admin_orgs.length,
  };
}

/**
 * Purges every account past its grace period. Staff accounts are never purged here (staff
 * access is revoked by hand first); a failure on one account is logged and the rest go on,
 * and the next day's run picks it up again.
 */
export async function runAccountPurge(d: AccountPurgeDeps) {
  const now = (d.now ?? (() => new Date()))();
  let purged = 0;
  let skipped = 0;
  let failed = 0;
  for (const due of await dueDeletions(d.db, now)) {
    const userId = due.person.id;
    if (due.person.role === STAFF_ROLE) {
      d.logger.warn(
        { signal: "account.purge_skipped", userId, reason: "staff" },
        "deleted account not purged: staff access must be revoked first",
      );
      skipped++;
      continue;
    }
    try {
      const result = await purgeOne(d, due);
      if (result === "skipped") {
        skipped++;
        continue;
      }
      d.logger.info(
        {
          signal: "account.purged",
          userId,
          requestedOn: due.requestedOn.toISOString().slice(0, 10),
          ...result,
        },
        "deleted account purged",
      );
      purged++;
    } catch (err) {
      d.logger.error(
        { err, signal: "account.purge_failed", userId },
        "deleted account purge failed",
      );
      failed++;
    }
  }
  return { purged, skipped, failed };
}

export function accountPurgeRegistration(d: AccountPurgeDeps) {
  return {
    jobs: [purgeDeletedAccounts],
    async register(queue: Queue) {
      await queue.work(purgeDeletedAccounts, { concurrency: 1 }, async () => {
        const out = await runAccountPurge(d);
        if (out.purged || out.skipped || out.failed)
          d.logger.info({ signal: "account.purge_run", ...out }, "account purge run");
      });
      await queue.schedule(purgeDeletedAccounts, "23 3 * * *", {}, "UTC");
    },
  };
}
