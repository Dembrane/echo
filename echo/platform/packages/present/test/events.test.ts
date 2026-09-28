import { expect, test } from "bun:test";
import { updateStream } from "@echo/popcorn";
import type { Hub } from "@echo/realtime";
import { Hono } from "hono";

// The deck's /events routes cannot be captured by the parity runner (the stream never
// ends), so the frames are checked here against the bytes the Python format_sse wrote.
test("deck events: connected, then a bare update per nudge", async () => {
  const listeners: (() => void)[] = [];
  const hub = {
    subscribe(channels: readonly string[], fn: () => void) {
      expect(channels).toEqual(["canvas:generation:7"]);
      listeners.push(fn);
      return () => {};
    },
  } as unknown as Hub;
  const app = new Hono().get("/e", (c) => updateStream(c, async () => hub, "7"));
  const res = await app.request("/e");
  expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const text = new TextDecoder();
  expect(text.decode((await reader.read()).value)).toBe(
    'event: connected\ndata: {"type": "connected"}\n\n',
  );
  for (const fn of listeners) fn();
  expect(text.decode((await reader.read()).value)).toBe(
    'event: update\ndata: {"type": "update"}\n\n',
  );
  await reader.cancel();
});
