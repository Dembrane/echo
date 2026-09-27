import { newId } from "@echo/core";
import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import type { Logger } from "@echo/observability";
import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { pyIso } from "./tiers";
import { parseTime } from "./time";

const { recording_overage, billing_account } = schema;

/**
 * Concurrent portal recording overage (old recording_overage.py). An episode is the
 * span during which an account records more conversations at once than its cap. The
 * ping path opens it and raises its peak (observeOverage); the close schedule ends it
 * after CLOSE_QUIET_MS at or below the cap; the notify schedule tells the team once per
 * opening and closing, using the episode's `*_notified_at` columns as its outbox.
 * Every tier's cap is unset today, so no episode opens until pricing sets one.
 */
export const CLOSE_QUIET_MS = 300_000;

/** Live recordings per billing account, from the portal's presence pings. */
export interface LiveRecordings {
  countActive(accountId: string): Promise<number>;
}

/** Counts nothing as live: for tests and callers without a presence store. */
export const noLiveRecordings: LiveRecordings = { countActive: async () => 0 };

/** The team's webhook (the one support requests use); answers the receiver's status. */
export interface Forwarder {
  post(payload: Record<string, unknown>): Promise<{ status: number; text: string }>;
}

type Episode = typeof recording_overage.$inferSelect;

/**
 * Records `count` live recordings against the account's cap: opens an episode on the
 * first count above it, raises the peak on higher counts, and revives an episode closed
 * within the quiet window instead of splitting one rush into two rows. A per-account
 * lock replaces the old Redis claim. Fails open: metering never disturbs recording.
 */
export async function observeOverage(
  db: Db,
  p: { accountId: string; cap: number | null; count: number; projectId: string },
  now: Date,
  logger: Logger,
): Promise<void> {
  if (p.cap === null || p.count <= p.cap) return;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`overage:${p.accountId}`}))`);
      const [open] = await tx
        .select()
        .from(recording_overage)
        .where(
          and(
            eq(recording_overage.billing_account_id, p.accountId),
            isNull(recording_overage.ended_at),
          ),
        )
        .orderBy(asc(recording_overage.started_at))
        .limit(1);
      if (open) {
        if (p.count > (open.peak ?? 0))
          await tx
            .update(recording_overage)
            .set({ peak: p.count, excess: p.count - (open.cap ?? p.cap ?? 0) })
            .where(eq(recording_overage.id, open.id));
        return;
      }
      const since = pyIso(new Date(now.getTime() - CLOSE_QUIET_MS));
      const [recent] = await tx
        .select()
        .from(recording_overage)
        .where(
          and(
            eq(recording_overage.billing_account_id, p.accountId),
            gt(recording_overage.ended_at, since),
          ),
        )
        .orderBy(asc(recording_overage.started_at))
        .limit(1);
      if (recent) {
        const cap = recent.cap ?? p.cap ?? 0;
        const peak = Math.max(recent.peak ?? 0, p.count);
        await tx
          .update(recording_overage)
          .set({ ended_at: null, closed_notified_at: null, peak, excess: peak - cap })
          .where(eq(recording_overage.id, recent.id));
        return;
      }
      await tx.insert(recording_overage).values({
        id: newId(),
        billing_account_id: p.accountId,
        started_at: pyIso(now),
        cap: p.cap,
        peak: p.count,
        excess: p.count - (p.cap ?? 0),
        opened_by_project_id: p.projectId,
      });
    });
  } catch (err) {
    logger.warn({ err, accountId: p.accountId }, "overage observe failed open");
  }
}

/**
 * Closes episodes whose count stayed at or below the cap for the quiet window. The
 * quiet clock is per episode and in memory: losing it on a restart only delays a close
 * by one window. Returns how many closed.
 */
export async function closeFinishedEpisodes(
  db: Db,
  live: LiveRecordings,
  quietSince: Map<string, Date>,
  now: Date,
  logger: Logger,
): Promise<number> {
  const rows = await db
    .select()
    .from(recording_overage)
    .where(isNull(recording_overage.ended_at))
    .orderBy(asc(recording_overage.id));
  let closed = 0;
  for (const row of rows) {
    try {
      if (!row.billing_account_id) continue;
      const cap = row.cap ?? 0;
      if ((await live.countActive(row.billing_account_id)) > cap) {
        quietSince.delete(row.id);
        continue;
      }
      const since = quietSince.get(row.id);
      if (!since) {
        quietSince.set(row.id, now);
        continue;
      }
      if (now.getTime() - since.getTime() < CLOSE_QUIET_MS) continue;
      // Re-read: the count may have climbed back over the cap since the first read.
      if ((await live.countActive(row.billing_account_id)) > cap) {
        quietSince.delete(row.id);
        continue;
      }
      // Closing also clears any stale closing stamp, so the corrected closing goes out.
      await db
        .update(recording_overage)
        .set({ ended_at: pyIso(now), closed_notified_at: null })
        .where(eq(recording_overage.id, row.id));
      quietSince.delete(row.id);
      closed += 1;
    } catch (err) {
      logger.warn({ err, episode: row.id }, "overage close failed");
    }
  }
  return closed;
}

const hm = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

export function openingMessage(e: Episode, account: { label: string | null; tier: string | null }) {
  const name = (account.label ?? "").trim() || String(e.billing_account_id);
  const started = parseTime(e.started_at) as Date;
  return `Concurrent recording cap exceeded. Account ${name} on ${account.tier || "unknown tier"} has ${e.peak} recordings, cap ${e.cap}. Since ${hm(started)} UTC.`;
}

export function closingMessage(e: Episode, account: { label: string | null; tier: string | null }) {
  const name = (account.label ?? "").trim() || String(e.billing_account_id);
  const started = parseTime(e.started_at) as Date;
  const ended = parseTime(e.ended_at) as Date;
  return `Cap episode ended. Account ${name} on ${account.tier || "unknown tier"} peaked at ${e.peak} recordings, cap ${e.cap}, ${e.excess} over, from ${hm(started)} to ${hm(ended)} UTC.`;
}

/**
 * The receiver deduplicates on id, so it is composite; the closing id carries ended_at,
 * so a corrected closing after a reopen is new while a retry repeats the same id.
 */
export function notificationId(e: Episode, suffix: "opened" | "closed"): string {
  if (suffix !== "closed") return `${e.id}:${suffix}`;
  const ended = parseTime(e.ended_at);
  if (!ended) return `${e.id}:closed`;
  const stamp = ended.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "");
  return `${e.id}:closed:${stamp}`;
}

/** Posts the pending opening and closing messages and stamps each on delivery. Returns how many filed. */
export async function filePendingNotifications(
  db: Db,
  forwarder: Forwarder | null,
  p: { environment: string; dashboardUrl: string },
  now: Date,
  logger: Logger,
): Promise<number> {
  if (!forwarder) return 0;
  let filed = 0;
  const opening = await db
    .select()
    .from(recording_overage)
    .where(isNull(recording_overage.opened_notified_at))
    .orderBy(asc(recording_overage.id))
    .limit(50);
  const closing = await db
    .select()
    .from(recording_overage)
    .where(and(isNotNull(recording_overage.ended_at), isNull(recording_overage.closed_notified_at)))
    .orderBy(asc(recording_overage.id))
    .limit(50);
  for (const [rows, suffix] of [
    [opening, "opened"],
    [closing, "closed"],
  ] as const) {
    for (const e of rows) {
      try {
        const [account] = e.billing_account_id
          ? await db
              .select({
                label: billing_account.label,
                tier: billing_account.tier,
                workspace_id: billing_account.workspace_id,
              })
              .from(billing_account)
              .where(eq(billing_account.id, e.billing_account_id))
          : [];
        const a = account ?? { label: null, tier: null, workspace_id: null };
        const payload: Record<string, unknown> = {
          id: notificationId(e, suffix),
          environment: p.environment,
          message: suffix === "opened" ? openingMessage(e, a) : closingMessage(e, a),
        };
        if (a.workspace_id) payload.workspace_id = a.workspace_id;
        if (e.opened_by_project_id) payload.project_id = e.opened_by_project_id;
        const base = p.dashboardUrl.replace(/\/+$/, "");
        if (a.workspace_id && e.opened_by_project_id && base)
          payload.origin_link = `${base}/en-US/w/${a.workspace_id}/projects/${e.opened_by_project_id}`;
        let status: number;
        try {
          status = (await forwarder.post(payload)).status;
        } catch (err) {
          logger.warn({ err }, "overage forward failed; the next run retries");
          return filed;
        }
        if (status >= 400 && status < 500) {
          logger.error({ status, id: payload.id }, "overage notification rejected; left unstamped");
          continue;
        }
        if (status < 200 || status >= 300) return filed;
        if (suffix === "opened") {
          await db
            .update(recording_overage)
            .set({ opened_notified_at: pyIso(now) })
            .where(eq(recording_overage.id, e.id));
          filed += 1;
          continue;
        }
        // Stamp only while ended_at is still the one announced: a reopen in between
        // clears it, and its corrected closing must still go out.
        const stamped = await db
          .update(recording_overage)
          .set({ closed_notified_at: pyIso(now) })
          .where(
            and(
              eq(recording_overage.id, e.id),
              e.ended_at
                ? eq(recording_overage.ended_at, e.ended_at)
                : isNull(recording_overage.ended_at),
              isNull(recording_overage.closed_notified_at),
            ),
          )
          .returning({ id: recording_overage.id });
        if (stamped.length) filed += 1;
      } catch (err) {
        logger.warn({ err, episode: e.id }, "overage notification failed");
      }
    }
  }
  return filed;
}
