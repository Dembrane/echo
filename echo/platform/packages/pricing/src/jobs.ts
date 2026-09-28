import type { Logger } from "@dembrane/observability";
import { defineJob, type Queue } from "@dembrane/queue";
import { z } from "zod";
import type { PricingRow, PricingStore } from "./storage";
import { buildAnswersSummary } from "./summary";

/**
 * The booking outbox: confirmed pricing bookings go to the team's webhook (the one the
 * support outbox uses) and each row is stamped only on a 2xx. At least once, deduped by
 * the receiver on booking_uid; a run after any failure picks up exactly the unstamped
 * rows. Every 2 minutes (UTC), one run at a time.
 */
export const forwardPricingBookings = defineJob("pricing.forward-bookings", z.object({}), {
  policy: "singleton",
  retryLimit: 0,
  expireInSeconds: 5 * 60,
});
export const FORWARD_CRON = "*/2 * * * *";

/** Delivers one payload; answers the receiver's status, or throws on a network failure. */
export interface Forwarder {
  post(payload: Record<string, unknown>): Promise<{ status: number; text: string }>;
}

export function httpForwarder(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Forwarder {
  return {
    async post(payload) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-echo-support-token": token },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, text: (await res.text()).slice(0, 200) };
    },
  };
}

/** The environment name the receiver shows, derived from the dashboard host (sam_environment). */
export function environmentName(dashboardUrl: string): string {
  const raw = dashboardUrl.toLowerCase().trim();
  let host = "";
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    host = "";
  }
  if (host === "dashboard.dembrane.com") return "production";
  if (host === "dashboard.echo-next.dembrane.com") return "echo-next";
  return host || "development";
}

function bookingStart(row: Pick<PricingRow, "config">): string | null {
  const cfg = row.config;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return null;
  const b = (cfg as Record<string, unknown>).booking;
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const start = (b as Record<string, unknown>).start;
  return start ? String(start) : null;
}

/** The webhook payload: `kind` tells it apart from a support request; absent fields are omitted. */
export function bookingPayload(row: PricingRow, environment: string): Record<string, unknown> {
  const p: Record<string, unknown> = {
    kind: "pricing_booking",
    environment,
    booking_uid: String(row.booking_uid),
    is_internal: Boolean(row.is_internal),
  };
  for (const k of [
    "reference",
    "booking_status",
    "email",
    "locale",
    "workspace_id",
    "org_id",
    "mount",
    "project_id",
  ] as const) {
    const val = row[k];
    if (val) p[k] = String(val);
  }
  const start = bookingStart(row);
  if (start) p.booking_start = start;
  const summary = buildAnswersSummary(row.answers_raw);
  if (summary) p.summary = summary;
  return p;
}

export interface ForwardDeps {
  readonly store: Pick<PricingStore, "unforwardedBookings" | "update">;
  /** Null when SUPPORT_WEBHOOK_URL or ECHO_SUPPORT_WEBHOOK_TOKEN is unset: forwarding is off. */
  readonly forwarder: Forwarder | null;
  readonly environment: string;
  readonly logger: Logger;
  readonly clock?: () => Date;
}

/** Returns how many bookings were delivered. 4xx is a payload bug: logged, left, next row; 5xx or network stops the batch. */
export async function runForwardBookings(d: ForwardDeps): Promise<number> {
  if (!d.forwarder) return 0;
  const rows = await d.store.unforwardedBookings(50);
  let delivered = 0;
  for (const row of rows) {
    if (!row.booking_uid) continue;
    let res: { status: number; text: string };
    try {
      res = await d.forwarder.post(bookingPayload(row, d.environment));
    } catch (err) {
      d.logger.warn({ err }, "pricing booking forward failed; stopping batch, next run retries");
      break;
    }
    if (res.status >= 200 && res.status < 300) {
      const now = (d.clock ?? (() => new Date()))();
      await d.store.update(row.id, { booking_notified_at: now.toISOString() }, now);
      delivered++;
    } else if (res.status >= 400 && res.status < 500) {
      d.logger.error(
        { id: row.id, status: res.status, body: res.text },
        "pricing booking forward rejected; row stays unstamped until fixed",
      );
    } else {
      d.logger.warn({ status: res.status }, "pricing booking receiver failed; stopping batch");
      break;
    }
  }
  return delivered;
}

export function pricingRegistration(d: ForwardDeps) {
  return {
    jobs: [forwardPricingBookings],
    async register(queue: Queue) {
      await queue.work(forwardPricingBookings, { concurrency: 1 }, async () => {
        await runForwardBookings(d);
      });
      await queue.schedule(forwardPricingBookings, FORWARD_CRON, {}, "UTC");
    },
  };
}
