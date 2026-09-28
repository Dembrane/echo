import type { Db } from "@dembrane/db";
import type { Mailer } from "@dembrane/mail";
import type { Logger } from "@dembrane/observability";
import { defineJob, type JobDefinition, type Queue } from "@dembrane/queue";
import { z } from "zod";
import type { Billing } from "./create";
import { previewDowngrade } from "./downgrade";
import { tierExpiredEmail, tierExpiringSoonEmail } from "./emails";
import { emailsOf, workspaceAdminsAndBilling } from "./notify";
import {
  closeFinishedEpisodes,
  type Forwarder,
  filePendingNotifications,
  type LiveRecordings,
} from "./overage";
import { pyIso } from "./tiers";
import { parseTime } from "./time";

/**
 * Billing schedules, one job each, same cadence as the old APScheduler jobs (UTC).
 * All are singletons (one run at a time across instances) and idempotent: the reconcile
 * jobs converge on Mollie's state, tier expiry only selects accounts still on a paid
 * tier, and the pre-warning claims its flag before sending.
 */
const tick = z.object({});
const opts = { policy: "singleton" as const, retryLimit: 2, expireInSeconds: 10 * 60 };
export const reconcilePendingBilling = defineJob("billing.reconcile-pending", tick, opts);
export const reconcileSubscriptionSeats = defineJob("billing.reconcile-seats", tick, opts);
export const expireTiers = defineJob("billing.expire-tiers", tick, opts);
export const tierExpiryPrewarning = defineJob("billing.tier-prewarning", tick, opts);
export const closeOverageEpisodes = defineJob("billing.overage-close", tick, opts);
export const notifyRecordingOverage = defineJob("billing.overage-notify", tick, opts);

/**
 * One account's seats changed: re-price its subscription and charge added seats pro rata,
 * or record the count on a managed account. The account and tenancy namespaces enqueue it
 * in the transaction that changed the seats; `reconcileSubscriptionSeats` is the backstop
 * for a run that was skipped or lost.
 */
export const reconcileAccountSeats = defineJob(
  "billing.reconcile-account-seats",
  z.object({ accountId: z.string() }),
  { policy: "singleton", retryLimit: 5, expireInSeconds: 5 * 60 },
);

/** The billing jobs the API enqueues; its queue client creates exactly these. */
export const billingApiJobs: readonly JobDefinition[] = [reconcileAccountSeats];

export const BILLING_SCHEDULES: readonly [JobDefinition, string][] = [
  [reconcilePendingBilling, "*/5 * * * *"],
  [reconcileSubscriptionSeats, "*/15 * * * *"],
  [expireTiers, "0 * * * *"],
  [tierExpiryPrewarning, "0 * * * *"],
  [closeOverageEpisodes, "*/2 * * * *"],
  // Odd minutes, one after each close run.
  [notifyRecordingOverage, "1-59/2 * * * *"],
];

export interface BillingJobDeps {
  readonly billing: Billing;
  readonly mailer: Mailer;
  readonly logger: Logger;
  /**
   * False outside prod: jobs that email customers, charge them or change their tier
   * log and stop, so an environment running on a copy of prod data never reaches a
   * real customer (echo-next once mailed real customers).
   */
  readonly customerJobs: boolean;
  readonly dashboardUrl: string;
  /** Recording overage: episodes, the live count and the team's webhook (null turns notices off). */
  readonly overage: {
    readonly db: Db;
    readonly live: LiveRecordings;
    readonly forwarder: Forwarder | null;
    readonly environment: string;
  };
  readonly clock?: () => Date;
}

function guard(d: BillingJobDeps, job: string): boolean {
  if (d.customerJobs) return true;
  d.logger.info(
    { job, signal: "billing.customer_jobs_off" },
    "skipped: customer jobs are off here",
  );
  return false;
}

/** Activates accounts whose first payment cleared but whose webhook and return sync were missed. */
export async function runReconcilePending(d: BillingJobDeps): Promise<void> {
  if (!guard(d, reconcilePendingBilling.name)) return;
  for (const id of await d.billing.store.pendingAccountsWithCustomer()) {
    try {
      const status = await d.billing.service.syncAccount(id);
      if (status === "active") d.logger.info({ accountId: id }, "activated via catch-up");
    } catch (err) {
      d.logger.error({ err, accountId: id }, "failed reconciling pending billing account");
    }
  }
}

/** Keeps each live subscription's amount on its seat count; charges added seats pro rata. */
export async function runReconcileSeats(d: BillingJobDeps): Promise<void> {
  if (!guard(d, reconcileSubscriptionSeats.name)) return;
  for (const id of await d.billing.store.activeAccountsWithSubscription()) {
    try {
      await d.billing.service.reconcileAccountSeats(id);
    } catch (err) {
      d.logger.error({ err, accountId: id }, "failed seat reconcile");
    }
  }
}

/** The per-account reconcile; charges customers, so it sits behind the customer switch. */
export async function runReconcileAccountSeats(
  d: BillingJobDeps,
  p: z.output<typeof reconcileAccountSeats.schema>,
): Promise<void> {
  if (!guard(d, reconcileAccountSeats.name)) return;
  await d.billing.service.reconcileAccountSeats(p.accountId);
}

function workspaceUrl(base: string, workspaceId: string): string {
  const b = base.replace(/\/+$/, "");
  return b ? `${b}/w/${workspaceId}/settings/billing` : `/w/${workspaceId}/settings/billing`;
}

async function sendAll(
  d: BillingJobDeps,
  to: readonly string[],
  mail: { subject: string; html: string; text: string },
  tag: string,
) {
  for (const addr of to) {
    try {
      await d.mailer.send({ to: addr, ...mail, tags: [tag] });
    } catch (err) {
      d.logger.warn({ err, tag }, "billing email failed");
    }
  }
}

/** Downgrades accounts whose tier_expires_at has passed and tells each workspace's admins. */
export async function runExpireTiers(d: BillingJobDeps): Promise<void> {
  if (!guard(d, expireTiers.name)) return;
  const { store, notifier } = d.billing;
  const now = (d.clock ?? (() => new Date()))();
  for (const acc of await store.expiredTierAccounts(now)) {
    const fromTier = acc.tier || "pioneer";
    let covered: string[];
    if (acc.workspace_id) covered = [acc.workspace_id];
    else {
      covered = await store.accountWorkspaceIds(acc.id);
      if (!covered.length) {
        // An org account with no workspaces: clear the expiry so it stops matching.
        await store.updateAccount(
          acc.id,
          { tier: "free", tier_expires_at: null, pre_warning_sent: false },
          now,
        );
        d.logger.info({ accountId: acc.id }, "expired org account to free (no workspaces)");
        continue;
      }
    }
    for (const wsId of covered) {
      const ws = await store.workspace(wsId);
      if (!ws || ws.deleted_at) continue;
      const name = ws.name || "Untitled";
      try {
        const effects = previewDowngrade(fromTier, "free");
        if (effects.length) {
          if (effects.some((e) => e.effect === "revert" && e.policy === "workspace:whitelabel"))
            await store.clearWorkspaceLogo(wsId, now);
          await store
            .clearOverCapStamps(wsId, now)
            .catch((err) =>
              d.logger.error({ err, workspaceId: wsId }, "failed to clear over-cap stamps"),
            );
        }
        if (ws.billing_account_id)
          await store.updateAccount(
            ws.billing_account_id,
            {
              tier: "free",
              downgraded_at: pyIso(now),
              downgraded_from_tier: fromTier,
              tier_expires_at: null,
              pre_warning_sent: false,
            },
            now,
          );
        d.logger.info(
          { workspaceId: wsId, fromTier, effects: effects.length },
          "expired workspace tier",
        );

        const audience = await workspaceAdminsAndBilling(store, wsId);
        if (!audience.length) continue;
        await notifier.emitToAudience(
          audience,
          {
            eventCode: "TIER_EXPIRED",
            title: `${name} tier expired`,
            message: `Moved from ${fromTier} to free. Request an upgrade to restore features.`,
            action: "NAVIGATE_WORKSPACE_SETTINGS",
            refWorkspaceId: wsId,
          },
          now,
        );
        const mail = tierExpiredEmail({
          workspaceName: name,
          fromTier,
          freezeItems: effects.filter((e) => e.effect === "freeze").map((e) => e.human),
          revertItems: effects.filter((e) => e.effect === "revert").map((e) => e.human),
          workspaceUrl: workspaceUrl(d.dashboardUrl, wsId),
        });
        await sendAll(d, await emailsOf(store, audience), mail, "tier_expired");
      } catch (err) {
        d.logger.error({ err, workspaceId: wsId }, "failed to expire workspace tier");
      }
    }
  }
}

/** "15 May 2026" from a stored timestamp, "soon" when it cannot be read. */
export function formatExpiryDate(raw: string | null): string {
  const d = parseTime(raw);
  if (!d) return "soon";
  const month = d.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

/** Warns admins three days before a paid tier lapses, once per expiry. */
export async function runTierPrewarning(d: BillingJobDeps): Promise<void> {
  if (!guard(d, tierExpiryPrewarning.name)) return;
  const { store, notifier } = d.billing;
  const now = (d.clock ?? (() => new Date()))();
  const until = new Date(now.getTime() + 3 * 86_400_000);
  for (const acc of await store.prewarnAccounts(now, until)) {
    const tier = acc.tier || "pioneer";
    if (!acc.workspace_id) {
      d.logger.warn({ accountId: acc.id }, "org-scoped account has no workspace to warn; skipping");
      continue;
    }
    const ws = await store.workspace(acc.workspace_id);
    if (!ws || ws.deleted_at) continue;
    const name = ws.name || "Untitled";
    try {
      // Claim first: a crash after this point can drop a warning but never send two.
      if (!(await store.claimPrewarning(acc.id, now))) continue;
      const audience = await workspaceAdminsAndBilling(store, ws.id);
      if (!audience.length) continue;
      const expiresDate = formatExpiryDate(acc.tier_expires_at);
      await notifier.emitToAudience(
        audience,
        {
          eventCode: "TIER_EXPIRING_SOON",
          title: `${name} tier expires ${expiresDate}`,
          message: `Your ${tier} tier expires on ${expiresDate}. Request an upgrade to keep full features.`,
          action: "NAVIGATE_WORKSPACE_SETTINGS",
          refWorkspaceId: ws.id,
        },
        now,
      );
      const mail = tierExpiringSoonEmail({
        workspaceName: name,
        currentTier: tier,
        expiresDate,
        workspaceUrl: workspaceUrl(d.dashboardUrl, ws.id),
      });
      await sendAll(d, await emailsOf(store, audience), mail, "tier_expiring_soon");
    } catch (err) {
      d.logger.error({ err, workspaceId: ws.id }, "failed to send tier pre-warning");
    }
  }
}

const quietSince = new Map<string, Date>();

/** Ends overage episodes that stayed at or below their cap for the quiet window. */
export async function runCloseOverage(d: BillingJobDeps): Promise<void> {
  const n = await closeFinishedEpisodes(
    d.overage.db,
    d.overage.live,
    quietSince,
    (d.clock ?? (() => new Date()))(),
    d.logger,
  );
  if (n) d.logger.info({ closed: n }, "closed overage episodes");
}

/** Tells the team about overage openings and closings; internal only, so not behind the customer switch. */
export async function runNotifyOverage(d: BillingJobDeps): Promise<void> {
  const n = await filePendingNotifications(
    d.overage.db,
    d.overage.forwarder,
    { environment: d.overage.environment, dashboardUrl: d.dashboardUrl },
    (d.clock ?? (() => new Date()))(),
    d.logger,
  );
  if (n) d.logger.info({ filed: n }, "filed overage notifications");
}

/** The worker's registration: handlers plus their schedules. */
export function billingRegistration(d: BillingJobDeps) {
  const handlers: [JobDefinition, () => Promise<void>][] = [
    [reconcilePendingBilling, () => runReconcilePending(d)],
    [reconcileSubscriptionSeats, () => runReconcileSeats(d)],
    [expireTiers, () => runExpireTiers(d)],
    [tierExpiryPrewarning, () => runTierPrewarning(d)],
    [closeOverageEpisodes, () => runCloseOverage(d)],
    [notifyRecordingOverage, () => runNotifyOverage(d)],
  ];
  return {
    jobs: [...handlers.map(([j]) => j), reconcileAccountSeats],
    async register(queue: Queue) {
      for (const [job, run] of handlers) await queue.work(job, { concurrency: 1 }, run);
      await queue.work(reconcileAccountSeats, { concurrency: 2 }, (p) =>
        runReconcileAccountSeats(d, p),
      );
      for (const [job, cron] of BILLING_SCHEDULES) await queue.schedule(job, cron, {}, "UTC");
    },
  };
}
