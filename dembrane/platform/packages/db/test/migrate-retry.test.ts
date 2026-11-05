import { expect, test } from "bun:test";
import { isRetryableLock } from "../src/migrate";

test("a lock timeout or a deadlock retries the run; anything else does not", () => {
  expect(isRetryableLock({ code: "55P03" })).toBe(true);
  expect(isRetryableLock({ code: "40P01" })).toBe(true);
  // Drizzle wraps the Postgres error.
  expect(isRetryableLock({ cause: { code: "40P01" } })).toBe(true);
  expect(isRetryableLock({ cause: { code: "55P03" } })).toBe(true);
  expect(isRetryableLock({ code: "42P01" })).toBe(false);
  expect(isRetryableLock(new Error("boom"))).toBe(false);
  expect(isRetryableLock(null)).toBe(false);
});
