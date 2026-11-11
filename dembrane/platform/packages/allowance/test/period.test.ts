import { expect, test } from "bun:test";
import { isFreeTier, monthStart, nextReset, periodStart } from "../src";

test("isFreeTier is exact", () => {
  expect(isFreeTier("free")).toBe(true);
  for (const t of ["innovator", "changemaker", "guardian", "pioneer", "Free", "", null, undefined])
    expect(isFreeTier(t)).toBe(false);
});
test("month boundaries are UTC", () => {
  const now = new Date("2026-10-31T23:30:00-02:00"); // 2026-11-01T01:30Z
  expect(monthStart(now).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  expect(nextReset(new Date("2026-12-15T00:00:00Z")).toISOString()).toBe(
    "2027-01-01T00:00:00.000Z",
  );
});
test("periodStart: downgraded this month starts at downgraded_at", () => {
  const now = new Date("2026-10-25T10:00:00Z");
  expect(periodStart(now, "free", "2026-10-20T12:00:00Z").toISOString()).toBe(
    "2026-10-20T12:00:00.000Z",
  );
});
test("periodStart: downgraded last month starts at the 1st", () => {
  const now = new Date("2026-10-25T10:00:00Z");
  expect(periodStart(now, "free", "2026-09-28T12:00:00Z").toISOString()).toBe(
    "2026-10-01T00:00:00.000Z",
  );
});
test("periodStart ignores downgraded_at on a non-free tier and when null", () => {
  const now = new Date("2026-10-25T10:00:00Z");
  expect(periodStart(now, "innovator", "2026-10-20T12:00:00Z").toISOString()).toBe(
    "2026-10-01T00:00:00.000Z",
  );
  expect(periodStart(now, "free", null).toISOString()).toBe("2026-10-01T00:00:00.000Z");
});
test("periodStart: a future downgraded_at counts from the 1st", () => {
  const now = new Date("2026-10-25T10:00:00Z");
  expect(periodStart(now, "free", "2026-10-26T12:00:00Z").toISOString()).toBe(
    "2026-10-01T00:00:00.000Z",
  );
});
