import { expect, test } from "bun:test";
import { retryAfterMs, SpeechGate } from "../src/speech-gate";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("live goes before upload, and uploads leave the live reserve alone", async () => {
  const gate = new SpeechGate({ secondsPerMinute: 100, concurrency: 1, liveReserve: 0.3 });
  const order: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const first = gate.run(10, "upload", async () => {
    order.push("first");
    await hold;
  });
  await tick();
  const upload = gate.run(10, "upload", async () => void order.push("upload"));
  const live = gate.run(10, "live", async () => void order.push("live"));
  await tick();
  release();
  await Promise.all([first, upload, live]);
  expect(order).toEqual(["first", "live", "upload"]);
});

test("background work stops at its share of the minute while live still fits", async () => {
  const gate = new SpeechGate({ secondsPerMinute: 100, concurrency: 8, windowMs: 80 });
  const done: string[] = [];
  const bg = [1, 2, 3].map((i) => gate.run(30, "upload", async () => void done.push(`u${i}`)));
  await tick();
  // 70 seconds are for background (100 x 0.7): two pieces of 30 fit, the third waits for the window.
  expect(done).toEqual(["u1", "u2"]);
  await gate.run(30, "live", async () => void done.push("live"));
  expect(done).toEqual(["u1", "u2", "live"]);
  await Promise.all(bg);
  expect(done.at(-1)).toBe("u3");
});

test("a 429 pause holds every caller and Retry-After is read as seconds or a date", async () => {
  const gate = new SpeechGate({ secondsPerMinute: 1000 });
  gate.pause(60);
  let ran = false;
  const p = gate.run(1, "live", async () => {
    ran = true;
  });
  await tick();
  expect(ran).toBe(false);
  await p;
  expect(ran).toBe(true);
  expect(retryAfterMs("7")).toBe(7000);
  expect(
    retryAfterMs("Wed, 21 Oct 2026 07:28:10 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")),
  ).toBe(10_000);
  expect(retryAfterMs(null)).toBeNull();
});
