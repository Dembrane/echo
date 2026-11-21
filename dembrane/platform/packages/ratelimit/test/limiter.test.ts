import { expect, test } from "bun:test";
import { ERROR_CATALOG, RateLimitedError } from "@dembrane/core";
import { MemoryRateCounter, RateLimiter, TOO_MANY } from "../src";

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

test("the per-user check refuses a caller without a user id", async () => {
  const limiter = new RateLimiter(new MemoryRateCounter());
  await expect(
    limiter.checkUser({ name: "t", capacity: 1, windowSeconds: 60 }, ""),
  ).rejects.toThrow("Authenticated user required.");
});

test("TOO_MANY is the catalog's detail, so routes that send it by name match the code", () => {
  expect(TOO_MANY).toBe(ERROR_CATALOG["rate_limit.exceeded"].detail);
});

test("the memory counter sweeps expired windows when full and stops tracking past its bound", async () => {
  const counter = new MemoryRateCounter(2);
  const t0 = new Date("2026-09-27T00:00:00Z");
  expect(await counter.hit("a", 60, t0)).toBe(1);
  expect(await counter.hit("b", 10, t0)).toBe(1);
  // Full with both live: a third key goes uncounted, the held ones keep counting.
  expect(await counter.hit("c", 60, t0)).toBe(1);
  expect(await counter.hit("c", 60, t0)).toBe(1);
  expect(await counter.hit("a", 60, t0)).toBe(2);
  expect(counter.size).toBe(2);
  // b's window has passed: the sweep frees its slot for c.
  const later = new Date(t0.getTime() + 11_000);
  expect(await counter.hit("c", 60, later)).toBe(1);
  expect(await counter.hit("c", 60, later)).toBe(2);
  expect(await counter.hit("a", 60, later)).toBe(3);
  expect(counter.size).toBe(2);
});

test("a refusal says how many seconds are left in the window", async () => {
  let now = new Date("2026-11-10T00:00:00Z");
  const limiter = new RateLimiter(new MemoryRateCounter(), () => now);
  const limit = { name: "t", capacity: 1, windowSeconds: 60 };
  await limiter.check(limit, "u");
  now = new Date(now.getTime() + 15_500);
  const refused = await limiter.check(limit, "u").catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(RateLimitedError);
  expect((refused as RateLimitedError).code).toBe("rate_limit.exceeded");
  expect((refused as RateLimitedError).params).toEqual({ retry_after_seconds: 45 });
  // The text stays the catalog's: only the params gained the wait.
  expect((refused as RateLimitedError).message).toBe(TOO_MANY);
});

test("the wait is at least one second, and the limit itself is unchanged", async () => {
  let now = new Date("2026-11-10T00:00:00Z");
  const limiter = new RateLimiter(new MemoryRateCounter(), () => now);
  const limit = { name: "t", capacity: 2, windowSeconds: 10 };
  await limiter.check(limit, "u");
  await limiter.check(limit, "u");
  now = new Date(now.getTime() + 9_999);
  const refused = (await limiter.check(limit, "u").catch((e: unknown) => e)) as RateLimitedError;
  expect(refused.params).toEqual({ retry_after_seconds: 1 });
  now = new Date(now.getTime() + 2);
  await limiter.check(limit, "u");
});

test("a counter that does not know its window refuses without a wait", async () => {
  const limiter = new RateLimiter({ hit: async () => 5 });
  const refused = (await limiter
    .check({ name: "t", capacity: 1, windowSeconds: 60 }, "u")
    .catch((e: unknown) => e)) as RateLimitedError;
  expect(refused.code).toBe("rate_limit.exceeded");
  expect(refused.params).toEqual({});
});

test("the memory counter reports the window's end with each hit", async () => {
  const counter = new MemoryRateCounter();
  const t0 = new Date("2026-11-10T00:00:00Z");
  expect(await counter.hitWindow("a", 60, t0)).toEqual({
    count: 1,
    resetAt: new Date("2026-11-10T00:01:00Z"),
  });
  expect(await counter.hitWindow("a", 60, new Date(t0.getTime() + 5_000))).toEqual({
    count: 2,
    resetAt: new Date("2026-11-10T00:01:00Z"),
  });
});
