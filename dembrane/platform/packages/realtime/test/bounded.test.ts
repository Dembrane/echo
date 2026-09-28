import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  boundedEventResponse,
  boundedEventStream,
  type Hub,
  KEEPALIVE_FRAME,
  openStreams,
  RECONNECT_MS,
  silentStream,
  sseResponse,
} from "../src";

const dec = new TextDecoder();
const enc = new TextEncoder();

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of body) text += dec.decode(chunk);
  return text;
}

/** A producer that sends one frame, then waits, recording when it was told to stop. */
function oneFrame(stopped: { at: number | null }) {
  return (signal: AbortSignal) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("event: connected\ndata: {}\n\n"));
        signal.addEventListener("abort", () => {
          stopped.at = Date.now();
          try {
            controller.close();
          } catch {}
        });
      },
    });
}

test("the stream ends at its lifetime, tells EventSource to come back soon, and stops the producer", async () => {
  const stopped = { at: null as number | null };
  const started = Date.now();
  const body = boundedEventStream(oneFrame(stopped), { lifetimeMs: 120, keepaliveMs: 10_000 });
  const text = await readAll(body);
  expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  expect(text).toBe(`event: connected\ndata: {}\n\nretry: ${RECONNECT_MS}\n\n`);
  expect(stopped.at).not.toBeNull();
});

test("a quiet stream carries keepalive comments, and none while frames flow", async () => {
  const body = boundedEventStream(silentStream, { lifetimeMs: 190, keepaliveMs: 50 });
  const text = await readAll(body);
  const beats = text.split(KEEPALIVE_FRAME).length - 1;
  expect(beats).toBeGreaterThanOrEqual(2);
  expect(beats).toBeLessThanOrEqual(3);
  expect(text.endsWith(`retry: ${RECONNECT_MS}\n\n`)).toBe(true);

  // Frames every 20ms keep the 50ms keepalive from ever firing.
  const busy = boundedEventStream(
    (signal) => {
      let timer: ReturnType<typeof setInterval>;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => controller.enqueue(enc.encode("event: tick\ndata: 1\n\n")), 20);
          signal.addEventListener("abort", () => {
            clearInterval(timer);
            controller.close();
          });
        },
      });
    },
    { lifetimeMs: 150, keepaliveMs: 50 },
  );
  expect(await readAll(busy)).not.toContain(KEEPALIVE_FRAME);
});

test("a client leaving stops the stream and the producer at once", async () => {
  const stopped = { at: null as number | null };
  const ac = new AbortController();
  const body = boundedEventStream(oneFrame(stopped), {
    lifetimeMs: 60_000,
    keepaliveMs: 60_000,
    signal: ac.signal,
  });
  const reader = body.getReader();
  expect(dec.decode((await reader.read()).value)).toBe("event: connected\ndata: {}\n\n");
  ac.abort();
  expect((await reader.read()).done).toBe(true);
  expect(stopped.at).not.toBeNull();
});

test("cancelling the reader stops the producer, and an already-aborted request never opens it", async () => {
  const stopped = { at: null as number | null };
  const reader = boundedEventStream(oneFrame(stopped), { lifetimeMs: 60_000 }).getReader();
  await reader.read();
  await reader.cancel();
  expect(stopped.at).not.toBeNull();

  const ac = new AbortController();
  ac.abort();
  let opened = false;
  const body = boundedEventStream(
    (signal) => {
      opened = true;
      return silentStream(signal);
    },
    { signal: ac.signal },
  );
  expect(await readAll(body)).toBe("");
  expect(opened).toBe(false);
});

test("a producer that finishes on its own ends the stream without a retry hint", async () => {
  const body = boundedEventStream(
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      }),
    { lifetimeMs: 60_000 },
  );
  expect(await readAll(body)).toBe("event: done\ndata: {}\n\n");
});

test("a bounded response keeps status and headers", async () => {
  const res = boundedEventResponse(
    new Response(silentStream(new AbortController().signal), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    { lifetimeMs: 30 },
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(await readAll(res.body as ReadableStream<Uint8Array>)).toBe(`retry: ${RECONNECT_MS}\n\n`);
});

test("a hub stream built with hono ends at its lifetime and gives its slot back", async () => {
  let unsubscribed = false;
  const hub = {
    subscribe: () => () => {
      unsubscribed = true;
    },
  } as unknown as Hub;
  const app = new Hono().get("/live", (c) =>
    sseResponse(c, hub, ["run:r1"], { key: "k1", bounds: { lifetimeMs: 100 } }),
  );
  const before = openStreams.total;
  const res = await app.request("/live");
  expect(await readAll(res.body as ReadableStream<Uint8Array>)).toBe(
    `event: connected\ndata: {"type":"connected"}\n\nretry: ${RECONNECT_MS}\n\n`,
  );
  for (let i = 0; i < 20 && openStreams.total !== before; i++) await Bun.sleep(5);
  expect(openStreams.total).toBe(before);
  expect(unsubscribed).toBe(true);
});
