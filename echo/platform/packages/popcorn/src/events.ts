import { RateLimitedError } from "@echo/core";
import type { Logger } from "@echo/observability";
import { type Hub, openStreams, publish } from "@echo/realtime";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import type postgres from "postgres";

/**
 * Live nudges for a session. Popcorn shares the canvas generation channel, so a page
 * following either hears the same write; a nudge carries no session data, and every page
 * rereads its bundle when one arrives.
 */

export function generationChannel(reportId: string): string {
  return `canvas:generation:${reportId}`;
}

/** Best effort: a lost nudge is recovered by the page's safety reread and its reconnect. */
export async function publishNudge(
  sql: postgres.Sql | postgres.TransactionSql,
  reportId: string,
  logger?: Logger,
): Promise<void> {
  if (!reportId) return;
  await publish(sql, generationChannel(reportId), { type: "generation" }, logger);
}

export const HEARTBEAT_MS = 15_000;

const HEADERS = {
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** format_sse with Python's json.dumps separators, the bytes the deck has always parsed. */
const frame = (type: string) => `event: ${type}\ndata: {"type": "${type}"}\n\n`;

export interface UpdateStreamOptions {
  readonly maxStreams?: number;
  readonly key?: string;
  readonly maxStreamsPerKey?: number;
  /** Asked at every heartbeat; the stream ends once it answers no. */
  readonly stillAllowed?: () => Promise<boolean>;
  readonly heartbeatMs?: number;
}

/**
 * `connected`, then a bare `update` per nudge on the session's channel, and a comment every
 * fifteen seconds. Subscribed before `connected`, because pages reload on `connected`.
 */
export function updateStream(
  c: Context,
  hub: () => Promise<Hub>,
  reportId: string,
  opts: UpdateStreamOptions = {},
) {
  if (!openStreams.take(opts.key, opts.maxStreams, opts.maxStreamsPerKey))
    throw new RateLimitedError("Too many open streams. Try again later.");
  for (const [k, v] of Object.entries(HEADERS)) c.header(k, v);
  c.header("Content-Type", "text/event-stream; charset=utf-8");
  return stream(c, async (s) => {
    let pending = 0;
    let wake: (() => void) | null = null;
    let unsubscribe = () => {};
    let closed = false;
    s.onAbort(() => {
      closed = true;
      wake?.();
    });
    try {
      const live = await hub();
      unsubscribe = live.subscribe([generationChannel(reportId)], () => {
        pending++;
        wake?.();
      });
      await s.write(frame("connected"));
      const beat = opts.heartbeatMs ?? HEARTBEAT_MS;
      let last = Date.now();
      while (!closed) {
        if (pending > 0) {
          pending--;
          await s.write(frame("update"));
          continue;
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, Math.max(0, beat - (Date.now() - last)));
        });
        wake = null;
        if (closed || pending > 0) continue;
        if (Date.now() - last >= beat) {
          if (opts.stillAllowed && !(await opts.stillAllowed().catch(() => false))) break;
          await s.write(": keep-alive\n\n");
          last = Date.now();
        }
      }
    } finally {
      unsubscribe();
      openStreams.giveBack(opts.key);
    }
  });
}
