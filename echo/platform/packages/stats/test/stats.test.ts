import { expect, test } from "bun:test";
import { RateLimiter } from "@echo/http";
import { computeStats, StatsCache, type StatsStore } from "../src";

const store = (seconds: number): StatsStore => ({
  adminUserIds: async () => ["admin"],
  countedProjectIds: async (ex) => (ex.includes("admin") ? ["p1", "p2"] : ["p1", "p2", "p3"]),
  conversationTotals: async (ids) => ({ count: ids.length * 2, seconds }),
});

test("staff projects are excluded and hours round half to even", async () => {
  expect(await computeStats(store(372.5))).toEqual({
    projects_count: 2,
    conversations_count: 4,
    hours_recorded: 0,
  });
  expect((await computeStats(store(9000))).hours_recorded).toBe(2);
  expect((await computeStats(store(12600))).hours_recorded).toBe(4);
});

test("the cache computes once per hour and shares a computation in flight", async () => {
  let now = 0;
  let calls = 0;
  const cache = new StatsCache(
    async () => {
      calls++;
      return { projects_count: calls, conversations_count: 0, hours_recorded: 0 };
    },
    1000,
    () => now,
  );
  await Promise.all([cache.get(), cache.get()]);
  expect(calls).toBe(1);
  now = 1001;
  expect((await cache.get()).projects_count).toBe(2);
});

test("the limiter allows capacity hits per window and then answers 429", () => {
  let now = 0;
  const l = new RateLimiter(2, 60, () => now);
  l.check("ip");
  l.check("ip");
  expect(() => l.check("ip")).toThrow("Too many requests. Try again later.");
  l.check("other");
  now = 60_000;
  l.check("ip");
  expect(() => l.checkUser("")).toThrow("Authenticated user required.");
});
