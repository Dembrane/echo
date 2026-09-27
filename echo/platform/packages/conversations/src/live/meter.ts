import type { Db } from "@echo/db";
import type { Logger } from "@echo/observability";
import type postgres from "postgres";
import { isUuid } from "../storage";
import { NEGATIVE_MARKER, type Presence } from "./presence";

/**
 * The concurrent portal recording meter (participant.py _meter). Initiate registers a
 * conversation under its project's billing account; audio pings keep it counted; a
 * terminal ping, finish or delete closes it. The count is handed to an overage observer
 * (the billing port's observeOverage) when one is wired. Every path fails open: the
 * meter must never refuse or slow a recording.
 */

export interface BillingContext {
  readonly accountId: string;
  readonly accountName: string;
  readonly tier: string | null;
  /** Concurrent recording cap of the tier; null for every tier today. */
  readonly cap: number | null;
  readonly workspaceId: string | null;
}

/** Judges a live count against the cap. Absent until the billing port is merged. */
export type OverageObserver = (
  ctx: BillingContext,
  count: number,
  conversationId: string,
  projectId: string,
) => Promise<void>;

export type MeterAction = "open" | "present" | "refresh" | "close";

// Only portal audio conversations are metered; text and host uploads never are.
const PORTAL_AUDIO = "PORTAL_AUDIO";
// Cached per process like the Python's 60s Redis cache, so pings rarely read the account.
const CONTEXT_TTL_MS = 60_000;

export class RecordingMeter {
  private readonly sql: postgres.Sql;
  private readonly contexts = new Map<string, { at: number; ctx: BillingContext | null }>();

  constructor(
    db: Db,
    private readonly presence: Presence,
    private readonly logger: Logger,
    private readonly observe?: OverageObserver,
    /** Tier to concurrent cap; tier_capacity has none set, so the default caps nothing. */
    private readonly capOf: (tier: string | null) => number | null = () => null,
  ) {
    this.sql = (db as unknown as { $client: postgres.Sql }).$client;
  }

  /** resolve_project_billing_context: project, workspace, billing account. */
  async context(projectId: string): Promise<BillingContext | null> {
    if (!isUuid(projectId)) return null;
    const hit = this.contexts.get(projectId);
    if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return hit.ctx;
    const [row] = await this.sql<
      { workspace_id: string; account_id: string; label: string | null; tier: string | null }[]
    >`
      select p.workspace_id, b.id as account_id, b.label, b.tier
      from project p
      join workspace w on w.id = p.workspace_id
      join billing_account b on b.id = w.billing_account_id
      where p.id = ${projectId}`;
    const ctx = row
      ? {
          accountId: String(row.account_id),
          accountName: row.label || String(row.account_id),
          tier: row.tier,
          cap: this.capOf(row.tier),
          workspaceId: String(row.workspace_id),
        }
      : null;
    this.contexts.set(projectId, { at: Date.now(), ctx });
    return ctx;
  }

  /**
   * A lost mapping recovers from one conversation read; a fabricated or foreign id is
   * marked absent so it is not read again for ten minutes. Only PORTAL_AUDIO recovers.
   */
  private async verifyAndRegister(
    ctx: BillingContext,
    conversationId: string,
    projectId: string,
    now: Date,
  ) {
    const [row] = isUuid(conversationId)
      ? await this.sql<{ project_id: string; source: string | null; deleted_at: unknown }[]>`
          select project_id, source, deleted_at from conversation where id = ${conversationId}`
      : [];
    if (
      row &&
      !row.deleted_at &&
      String(row.project_id) === projectId &&
      row.source === PORTAL_AUDIO
    ) {
      await this.presence.registerConversation(ctx.accountId, conversationId, now);
      return true;
    }
    await this.presence.registerNegative(conversationId, now);
    return false;
  }

  async meter(
    projectId: string,
    conversationId: string,
    action: MeterAction,
    now: Date,
  ): Promise<void> {
    try {
      const ctx = await this.context(projectId);
      if (!ctx) return;
      if (action === "close") {
        await this.presence.closeSession(ctx.accountId, conversationId);
        return;
      }
      if (action === "open") {
        await this.presence.registerConversation(ctx.accountId, conversationId, now);
      } else {
        const known = await this.presence.accountForConversation(conversationId, now);
        if (known === null) {
          if (!(await this.verifyAndRegister(ctx, conversationId, projectId, now))) return;
        } else if (known !== ctx.accountId) {
          // NEGATIVE_MARKER or another account: stale or forged pings, checked once already.
          if (known !== NEGATIVE_MARKER)
            this.logger.debug({ conversationId }, "meter skipped: other account");
          return;
        }
      }
      if (action === "refresh") {
        await this.presence.refreshIfPresent(ctx.accountId, conversationId, now);
        return;
      }
      const count = await this.presence.recordPresence(ctx.accountId, conversationId, now);
      await this.observe?.(ctx, count, conversationId, projectId);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, projectId, conversationId },
        "recording meter failed open",
      );
    }
  }

  /** _meter_upload: a chunk upload refreshes presence from the mapping, never creates one. */
  async meterUpload(conversationId: string, now: Date): Promise<void> {
    try {
      const account = await this.presence.accountForConversation(conversationId, now);
      if (!account || account === NEGATIVE_MARKER) return;
      await this.presence.refreshIfPresent(account, conversationId, now);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, conversationId },
        "recording meter failed open",
      );
    }
  }
}
