/**
 * Bounds for every server-sent event stream the API serves.
 *
 * Each open stream holds one Cloud Run request slot for as long as it lives, so no stream
 * may live forever: after its lifetime the server ends it cleanly and EventSource (or the
 * dashboard's own reader) reconnects. While it lives, a comment line goes out whenever the
 * stream has been quiet for the keepalive interval, so proxies never close it as idle.
 * Comment lines are invisible to EventSource and to the dashboard's frame parser.
 */

/** How long one stream may stay open before the server ends it. */
export const STREAM_LIFETIME_MS = 10 * 60_000;
/** The longest a stream stays silent before a keepalive comment goes out. */
export const KEEPALIVE_MS = 15_000;
export const KEEPALIVE_FRAME = ": keepalive\n\n";
/**
 * Sent just before a lifetime end: EventSource waits this long before reconnecting,
 * instead of the browser default of several seconds. A frame with only `retry:` dispatches
 * no event.
 */
export const RECONNECT_MS = 1000;

export interface StreamBounds {
  readonly lifetimeMs?: number;
  readonly keepaliveMs?: number;
  /** The request's signal: the client leaving ends the stream. */
  readonly signal?: AbortSignal;
}

const enc = new TextEncoder();
const KEEPALIVE_BYTES = enc.encode(KEEPALIVE_FRAME);

/**
 * One bounded event stream. `open` gets a signal that aborts when the stream ends for any
 * reason (lifetime, client gone, reader cancelled); the producer must stop on it. The
 * producer must emit whole frames per chunk, because keepalives go in between chunks.
 */
export function boundedEventStream(
  open: (signal: AbortSignal) => ReadableStream<Uint8Array>,
  bounds: StreamBounds = {},
): ReadableStream<Uint8Array> {
  const lifetimeMs = bounds.lifetimeMs ?? STREAM_LIFETIME_MS;
  const keepaliveMs = bounds.keepaliveMs ?? KEEPALIVE_MS;
  const stop = new AbortController();
  let finish: (why: "lifetime" | "abort" | "done" | "cancel") => void = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let reader: { cancel(): Promise<void> } | undefined;
      const onAbort = () => finish("abort");
      const life = setTimeout(() => finish("lifetime"), lifetimeMs);
      finish = (why) => {
        if (ended) return;
        ended = true;
        clearTimeout(life);
        clearTimeout(idle);
        bounds.signal?.removeEventListener("abort", onAbort);
        // Abort first: producers guard their writes on this signal, so none lands after
        // the cancel below.
        stop.abort();
        if (why !== "done") void reader?.cancel().catch(() => {});
        if (why === "cancel") return;
        try {
          if (why === "lifetime") controller.enqueue(enc.encode(`retry: ${RECONNECT_MS}\n\n`));
          controller.close();
        } catch {}
      };
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          if (ended) return;
          try {
            controller.enqueue(KEEPALIVE_BYTES);
          } catch {}
          arm();
        }, keepaliveMs);
      };
      if (bounds.signal?.aborted) {
        finish("abort");
        return;
      }
      bounds.signal?.addEventListener("abort", onAbort, { once: true });
      const source = open(stop.signal).getReader();
      reader = source;
      arm();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await source.read();
            if (done || ended) break;
            controller.enqueue(value);
            arm();
          }
        } catch {
        } finally {
          finish("done");
        }
      })();
    },
    cancel() {
      finish("cancel");
    },
  });
}

/**
 * The same bounds for a streaming Response, such as one built with hono's `stream()`:
 * cancelling its body is what tells that producer to stop. Status and headers are kept.
 */
export function boundedEventResponse(res: Response, bounds: StreamBounds = {}): Response {
  const body = res.body;
  if (!body) return res;
  return new Response(
    boundedEventStream(() => body, bounds),
    { status: res.status, headers: res.headers },
  );
}

/** A stream that never sends anything of its own; bounded, it carries only keepalives. */
export function silentStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => {
          try {
            controller.close();
          } catch {}
        },
        { once: true },
      );
    },
  });
}
