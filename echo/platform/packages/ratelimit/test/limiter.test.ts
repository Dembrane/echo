import { expect, test } from "bun:test";
import { MemoryRateCounter, RateLimiter } from "../src";

test("the hit after capacity is refused until the window passes", async () => {
  let now = new Date("2026-09-27T00:00:00Z");
  const limiter = new RateLimiter(new MemoryRateCounter(), () => now);
  const limit = { name: "t", capacity: 2, windowSeconds: 60 };
  await limiter.check(limit, "u");
  await limiter.check(limit, "u");
  await expect(limiter.check(limit, "u")).rejects.toThrow("Too many requests. Try again later.");
  expect(await limiter.allow(limit, "other")).toBe(true);
  now = new Date(now.getTime() + 61_000);
  await limiter.check(limit, "u");
});

test("an empty identifier is never limited", async () => {
  const limiter = new RateLimiter(new MemoryRateCounter());
  const limit = { name: "t", capacity: 1, windowSeconds: 60 };
  for (let i = 0; i < 3; i++) await limiter.check(limit, "");
});

test("a failing counter store fails open and reports it", async () => {
  const seen: string[] = [];
  const limiter = new RateLimiter(
    { hit: () => Promise.reject(new Error("down")) },
    () => new Date(),
    (_e, l) => seen.push(l.name),
  );
  await limiter.check({ name: "t", capacity: 1, windowSeconds: 60 }, "u");
  expect(seen).toEqual(["t"]);
});
