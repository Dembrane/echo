import { RateLimitedError } from "@dembrane/core";
import type { Logger } from "@dembrane/observability";
import {
  boundedEventResponse,
  type Hub,
  openStreams,
  publish,
  RECHECK_MS,
  type StreamBounds,
} from "@dembrane/realtime";
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
  /** Asked every `recheckMs`; the stream ends once it answers no. */
  readonly stillAllowed?: () => Promise<boolean>;
  readonly recheckMs?: number;
  readonly bounds?: Omit<StreamBounds, "signal">;
}

/**
 * `connected`, then a bare `update` per nudge on the session's channel. Subscribed before
 * `connected`, because pages reload on `connected`. Keepalives and the lifetime come from
 * the shared stream bounds.
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
  return boundedEventResponse(
    stream(c, async (s) => {
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
        const every = opts.recheckMs ?? RECHECK_MS;
        let lastCheck = Date.now();
        while (!closed) {
          if (pending > 0) {
            pending--;
            await s.write(frame("update"));
            continue;
          }
          await new Promise<void>((r) => {
            wake = r;
            if (opts.stillAllowed) setTimeout(r, Math.max(0, every - (Date.now() - lastCheck)));
          });
          wake = null;
          if (closed || pending > 0) continue;
          if (opts.stillAllowed && Date.now() - lastCheck >= every) {
            if (!(await opts.stillAllowed().catch(() => false))) break;
            lastCheck = Date.now();
          }
        }
      } finally {
        unsubscribe();
        openStreams.giveBack(opts.key);
      }
    }),
    { ...opts.bounds, signal: c.req.raw.signal },
  );
}
