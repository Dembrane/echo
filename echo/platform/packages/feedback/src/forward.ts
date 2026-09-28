import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import type { Logger } from "@echo/observability";
import { defineJob, type Queue } from "@echo/queue";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

const { support_request, workspace } = schema;

/**
 * The support outbox. Every support request (the assistant's reachOutToDembraneSupport,
 * the dashboard's report form, the MCP report_issue tool) is a support_request row with
 * status "new"; this job posts each one to sam, which puts it in #gen-engineering. Without
 * it a host is told "logged for the team" and nobody hears. Every 2 minutes (UTC), one run
 * at a time, so two runs never post the same row at once.
 */
export const forwardSupportRequests = defineJob("feedback.forward-support", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});
export const SUPPORT_FORWARD_CRON = "*/2 * * * *";
const BATCH = 50;

/** Delivers one payload; answers the receiver's status, or throws on a network failure. */
export interface SupportForwarder {
  post(payload: Record<string, unknown>): Promise<{ status: number; text: string }>;
}

export interface SupportRow {
  readonly id: string;
  readonly message: string | null;
  readonly page_context: string | null;
  readonly source: string | null;
  readonly created_at: string | null;
  readonly chat_id: string | null;
  readonly project_id: string | null;
  readonly workspace_id: string | null;
  readonly app_user_id: string | null;
  readonly directus_user_id: string | null;
  /** The workspace's organisation; null when the workspace is unset or unknown. */
  readonly org_id: string | null;
}

/**
 * The webhook payload, the contract sam's product-support recipe reads: id, environment
 * and message always; every other field omitted when empty, never sent as null. No
 * transcript content. Sam deduplicates on id, which makes redelivery safe.
 */
export function supportPayload(
  row: SupportRow,
  environment: string,
  dashboardUrl: string,
): Record<string, unknown> {
  const p: Record<string, unknown> = {
    id: String(row.id),
    environment,
    // sam requires a message; a placeholder keeps an empty row deliverable instead of
    // leaving it at the head of the outbox forever.
    message: row.message || "(empty message)",
  };
  for (const k of [
    "page_context",
    "source",
    "created_at",
    "chat_id",
    "project_id",
    "workspace_id",
    "app_user_id",
    "directus_user_id",
  ] as const) {
    const val = row[k];
    if (val) p[k] = String(val);
  }
  if (row.org_id) p.org_id = String(row.org_id);
  const base = dashboardUrl.replace(/\/+$/, "");
  if (base && row.workspace_id && row.project_id)
    p.origin_link = `${base}/en-US/w/${row.workspace_id}/projects/${row.project_id}`;
  return p;
}

export function supportOutbox(db: Db) {
  return {
    /** Oldest first, so a backlog drains in the order hosts asked. */
    async unforwarded(limit: number): Promise<SupportRow[]> {
      const rows = await db
        .select({
          id: support_request.id,
          message: support_request.message,
          page_context: support_request.page_context,
          source: support_request.source,
          created_at: support_request.created_at,
          chat_id: support_request.chat_id,
          project_id: support_request.project_id,
          workspace_id: support_request.workspace_id,
          app_user_id: support_request.app_user_id,
          directus_user_id: support_request.directus_user_id,
          org_id: workspace.org_id,
        })
        .from(support_request)
        // workspace_id is free text: a malformed id finds no workspace and the row goes
        // without org_id instead of failing the batch.
        .leftJoin(workspace, sql`${workspace.id}::text = ${support_request.workspace_id}`)
        .where(and(eq(support_request.status, "new"), isNull(support_request.forwarded_at)))
        .orderBy(asc(support_request.created_at), asc(support_request.id))
        .limit(limit);
      return rows.map((r) => ({ ...r, org_id: r.org_id ? String(r.org_id) : null }));
    },

    /** Stamps once: a row already stamped keeps its first delivery time. */
    async markForwarded(id: string, at: Date): Promise<void> {
      await db
        .update(support_request)
        .set({ forwarded_at: at.toISOString() })
        .where(and(eq(support_request.id, id), isNull(support_request.forwarded_at)));
    },
  };
}

export type SupportOutbox = ReturnType<typeof supportOutbox>;

export interface SupportForwardDeps {
  readonly outbox: Pick<SupportOutbox, "unforwarded" | "markForwarded">;
  /** Null when SUPPORT_WEBHOOK_URL or ECHO_SUPPORT_WEBHOOK_TOKEN is unset: forwarding is off. */
  readonly forwarder: SupportForwarder | null;
  /** production, echo-next, or the dashboard host: what sam labels the request with. */
  readonly environment: string;
  /** Where origin_link points. */
  readonly dashboardUrl: string;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

/**
 * Posts every unforwarded request and stamps it only on a 2xx, so delivery is at least
 * once and the receiver's dedupe on id makes it exactly once per request. A 4xx is a
 * payload or config bug: logged, left unstamped, and the batch goes on. A 5xx or a network
 * failure means sam is down: the batch stops and the next run retries the same rows.
 * Returns how many were delivered.
 */
export async function runForwardSupport(d: SupportForwardDeps): Promise<number> {
  if (!d.forwarder) return 0;
  const rows = await d.outbox.unforwarded(BATCH);
  let delivered = 0;
  for (const row of rows) {
    let res: { status: number; text: string };
    try {
      res = await d.forwarder.post(supportPayload(row, d.environment, d.dashboardUrl));
    } catch (err) {
      d.logger.warn(
        { err, signal: "support.forward_failed" },
        "support forward failed; stopping batch, next run retries",
      );
      break;
    }
    if (res.status >= 200 && res.status < 300) {
      await d.outbox.markForwarded(row.id, (d.clock ?? (() => new Date()))());
      delivered++;
    } else if (res.status >= 400 && res.status < 500) {
      d.logger.error(
        { id: row.id, status: res.status, body: res.text, signal: "support.forward_rejected" },
        "support forward rejected; row stays unstamped until fixed",
      );
    } else {
      d.logger.warn(
        { status: res.status, signal: "support.forward_failed" },
        "support receiver failed; stopping batch, next run retries",
      );
      break;
    }
  }
  if (delivered) d.logger.info({ delivered }, "support requests forwarded to sam");
  return delivered;
}

export function supportForwardRegistration(d: SupportForwardDeps) {
  return {
    jobs: [forwardSupportRequests],
    async register(queue: Queue) {
      await queue.work(forwardSupportRequests, { concurrency: 1 }, async () => {
        await runForwardSupport(d);
      });
      await queue.schedule(forwardSupportRequests, SUPPORT_FORWARD_CRON, {}, "UTC");
    },
  };
}
