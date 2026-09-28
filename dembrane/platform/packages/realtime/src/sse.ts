import { RateLimitedError } from "@dembrane/core";
import type { Context } from "hono";
import { stream } from "hono/streaming";
import { boundedEventResponse, type StreamBounds } from "./bounded";
import { encode, type Hub, type LiveEvent } from "./hub";

/** How often an open stream asks `stillAllowed` again. */
export const RECHECK_MS = 15_000;
const HEADERS = {
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export function formatSse(event: LiveEvent, name?: string): string {
  return `event: ${name ?? (typeof event.type === "string" ? event.type : undefined) ?? "update"}\ndata: ${encode(event)}\n\n`;
}

/** Streams open in this process, in total and per caller key; a cap bounds one instance. */
export class OpenStreams {
  total = 0;
  readonly byKey = new Map<string, number>();
  take(key: string | undefined, max?: number, maxPerKey?: number): boolean {
    if (max !== undefined && this.total >= max) return false;
    if (key !== undefined && maxPerKey !== undefined && (this.byKey.get(key) ?? 0) >= maxPerKey)
      return false;
    this.total++;
    if (key !== undefined) this.byKey.set(key, (this.byKey.get(key) ?? 0) + 1);
    return true;
  }
  giveBack(key: string | undefined): void {
    this.total = Math.max(0, this.total - 1);
    if (key === undefined) return;
    const left = (this.byKey.get(key) ?? 0) - 1;
    if (left > 0) this.byKey.set(key, left);
    else this.byKey.delete(key);
  }
}

export const openStreams = new OpenStreams();

export interface SseOptions {
  /** Rename, filter (return null) or reshape an event, e.g. strip fields a public page must not see. */
  readonly transform?: (event: LiveEvent) => LiveEvent | null;
  readonly recheckMs?: number;
  readonly maxStreams?: number;
  readonly key?: string;
  readonly maxStreamsPerKey?: number;
  /** Asked every `recheckMs`; the stream ends once access is withdrawn. Errors count as no. */
  readonly stillAllowed?: () => Promise<boolean>;
  /** Lifetime and keepalive; the shared defaults unless a test shortens them. */
  readonly bounds?: Omit<StreamBounds, "signal">;
}

/**
 * One server-sent event stream fed by channels, closed when the client leaves. Access is
 * checked by the caller before this; `stillAllowed` re-checks it while the stream lives.
 * Subscribes before sending `connected`, because pages reload their state on `connected`.
 * Bounded like every stream: it ends after its lifetime and the page reconnects.
 */
export function sseResponse(
  c: Context,
  hub: Hub,
  channels: readonly string[],
  opts: SseOptions = {},
) {
  if (!openStreams.take(opts.key, opts.maxStreams, opts.maxStreamsPerKey)) {
    throw new RateLimitedError("Too many open streams. Try again later.");
  }
  for (const [k, v] of Object.entries(HEADERS)) c.header(k, v);
  c.header("Content-Type", "text/event-stream");
  return boundedEventResponse(
    stream(c, async (s) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = hub.subscribe(channels, (event) => {
        const shaped = opts.transform ? opts.transform(event) : event;
        if (shaped) {
          queue.push(formatSse(shaped));
          wake?.();
        }
      });
      let closed = false;
      s.onAbort(() => {
        closed = true;
        wake?.();
      });
      try {
        await s.write(formatSse({ type: "connected" }));
        let lastCheck = Date.now();
        const every = opts.recheckMs ?? RECHECK_MS;
        while (!closed) {
          if (queue.length) {
            await s.write(queue.shift() as string);
            continue;
          }
          await new Promise<void>((r) => {
            wake = r;
            if (opts.stillAllowed) setTimeout(r, Math.max(0, every - (Date.now() - lastCheck)));
          });
          wake = null;
          if (closed || queue.length) continue;
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
