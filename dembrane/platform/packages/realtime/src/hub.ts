import type { Logger } from "@dembrane/observability";
import type postgres from "postgres";

export type LiveEvent = Record<string, unknown>;

/** All live events share one Postgres channel; the named channel travels in the payload. */
const PG_CHANNEL = "echo_live";
// NOTIFY payloads are capped at 8000 bytes. Events are nudges (ids and a type), so a
// payload near the cap means a caller is sending data it should let the page reload.
const MAX_PAYLOAD = 7_900;

export function encode(event: LiveEvent): string {
  return JSON.stringify(event);
}

/**
 * The pg_notify arguments that publish sends, for a caller that folds the nudge into a
 * statement it already makes (the participant ping). Null when there is nothing to send.
 */
export function notification(
  channel: string,
  event: LiveEvent,
  logger?: Logger,
): { pgChannel: string; payload: string } | null {
  if (!channel) return null;
  const payload = JSON.stringify({ c: channel, e: event });
  if (payload.length > MAX_PAYLOAD) {
    logger?.warn({ channel, bytes: payload.length }, "live event too large; send ids, not data");
    return null;
  }
  return { pgChannel: PG_CHANNEL, payload };
}

/**
 * Publishes a nudge on a named channel. Inside a transaction it is delivered on commit, so
 * a page never reloads before the row it will read exists. Best effort, like before: an
 * event nobody listens to is gone, and pages catch up when their stream reconnects.
 */
export async function publish(
  sql: postgres.Sql | postgres.TransactionSql,
  channel: string,
  event: LiveEvent,
  logger?: Logger,
) {
  const n = notification(channel, event, logger);
  if (!n) return;
  try {
    await sql`select pg_notify(${n.pgChannel}, ${n.payload})`;
  } catch (err) {
    logger?.warn({ err, channel }, "live event publish failed");
  }
}

type Listener = (event: LiveEvent) => void;

/**
 * One LISTEN connection per process, fanned out in memory to every open stream. Replaces
 * a Redis subscription per browser tab with one database connection per instance.
 */
export class Hub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private unlisten: (() => Promise<void>) | null = null;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const sub = await this.sql.listen(
      PG_CHANNEL,
      (payload) => this.dispatch(payload),
      () => this.logger.info("live events listening"),
    );
    this.unlisten = () => sub.unlisten();
  }

  /** Registers before returning, so the caller can announce `connected` knowing nothing is missed after it. */
  subscribe(channels: readonly string[], fn: Listener): () => void {
    for (const ch of channels) {
      const set = this.listeners.get(ch) ?? new Set<Listener>();
      set.add(fn);
      this.listeners.set(ch, set);
    }
    return () => {
      for (const ch of channels) {
        const set = this.listeners.get(ch);
        set?.delete(fn);
        if (set?.size === 0) this.listeners.delete(ch);
      }
    };
  }

  dispatch(payload: string): void {
    let msg: { c?: unknown; e?: unknown };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof msg.c !== "string") return;
    const event =
      msg.e && typeof msg.e === "object" && !Array.isArray(msg.e)
        ? (msg.e as LiveEvent)
        : { type: "update" };
    for (const fn of this.listeners.get(msg.c) ?? []) {
      try {
        fn(event);
      } catch (err) {
        this.logger.warn({ err }, "live event listener threw");
      }
    }
  }

  async stop(): Promise<void> {
    await this.unlisten?.();
  }
}
