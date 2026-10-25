import { expect, test } from "bun:test";
import type { Embedder } from "@dembrane/llm";
import { embedWithRetry } from "../src/embeddings";

const busy = (retryAfter?: string) =>
  Object.assign(new Error("busy"), {
    statusCode: 429,
    ...(retryAfter && { responseHeaders: { "retry-after": retryAfter } }),
  });

/** An embedder that answers 429 `failures` times, then a vector. */
function embedder(failures: number, error: () => Error = () => busy()) {
  const calls: number[] = [];
  const e: Embedder = {
    model: "m",
    endpoint: "e",
    dimensions: 3,
    async embed() {
      calls.push(Date.now());
      if (calls.length <= failures) throw error();
      return [1, 2, 3];
    },
  };
  return { e, calls };
}

const clock = () => {
  let t = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
  };
};

test("a rate limit that outlasts five tries still succeeds, waiting longer each time", async () => {
  const { e, calls } = embedder(6);
  const c = clock();
  const vector = await embedWithRetry(e, "text", 5, { ...c, random: () => 1 });
  expect(vector).toEqual([1, 2, 3]);
  expect(calls).toHaveLength(7);
  expect(c.waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
});

test("Retry-After sets the floor of the wait", async () => {
  const { e } = embedder(1, () => busy("20"));
  const c = clock();
  await embedWithRetry(e, "text", 5, { ...c, random: () => 0 });
  expect(c.waits).toEqual([20000]);
});

test("one rate limit holds every other caller of the same embedder", async () => {
  const { e } = embedder(1);
  const waits: number[] = [];
  // Time stands still, so the pause the first caller set is still running when the second starts.
  const still = { now: () => 0, sleep: async (ms: number) => void waits.push(ms), random: () => 1 };
  await embedWithRetry(e, "a", 5, still);
  await embedWithRetry(e, "b", 5, still);
  expect(waits).toEqual([1000, 1000]);
});

test("a rate limit that never lifts raises after the last try", async () => {
  const { e, calls } = embedder(100);
  const c = clock();
  await expect(embedWithRetry(e, "text", 5, { ...c, random: () => 1 })).rejects.toThrow("busy");
  expect(calls).toHaveLength(8);
});

test("other failures keep five tries", async () => {
  const { e, calls } = embedder(100, () => new Error("boom"));
  const c = clock();
  await expect(embedWithRetry(e, "text", 5, { ...c, random: () => 1 })).rejects.toThrow("boom");
  expect(calls).toHaveLength(5);
});

test("Retry-After of an hour waits a minute", async () => {
  const { e } = embedder(1, () => busy("3600"));
  const c = clock();
  await embedWithRetry(e, "text", 5, { ...c, random: () => 0 });
  expect(c.waits).toEqual([60000]);
});

test("an HTTP-date Retry-After is read and capped", async () => {
  const date = new Date(Date.now() + 3_600_000).toUTCString();
  const { e } = embedder(1, () => busy(date));
  const c = clock();
  await embedWithRetry(e, "text", 5, { ...c, now: () => Date.now() + 0, random: () => 0 });
  expect(c.waits).toEqual([60000]);
  const near = new Date(Date.now() + 10_000).toUTCString();
  const again = embedder(1, () => busy(near));
  const d = clock();
  await embedWithRetry(again.e, "text", 5, { ...d, now: () => Date.now(), random: () => 0 });
  expect(d.waits[0]).toBeGreaterThan(8000);
  expect(d.waits[0]).toBeLessThanOrEqual(10000);
});

test("a rate limit that outlasts the deadline raises before the last try", async () => {
  const { e, calls } = embedder(100, () => busy("60"));
  const c = clock();
  await expect(embedWithRetry(e, "text", 5, { ...c, random: () => 0 })).rejects.toThrow("busy");
  // 60 s waits: the third would end past 180 s.
  expect(c.waits).toEqual([60000, 60000, 60000]);
  expect(calls).toHaveLength(4);
});
