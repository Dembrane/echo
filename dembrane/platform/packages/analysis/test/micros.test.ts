import { expect, test } from "bun:test";
import { micros } from "../src/db";

test("micros keeps the old timestamp regex results", () => {
  expect(micros("")).toBe(Number.NEGATIVE_INFINITY);
  expect(micros(null)).toBe(Number.NEGATIVE_INFINITY);
  expect(micros("2024-01-02 10:11:12.123456+02")).toBe(1704183072123456);
  expect(micros("2024-01-02T10:11:12Z")).toBe(1704190272000000);
  expect(micros("2024-01-02 10:11:12.5")).toBe(1704190272500000);
  expect(micros("2024-01-02 10:11:12.1234567")).toBe(1704190272123456);
  expect(micros("2024-01-02 10:11:12+05:30")).toBe(1704170472000000);
  // A line break fails the pattern, so Date.parse decides.
  const broken = "2024-01-02 10:11:12.123\n";
  expect(micros(broken)).toBe(Date.parse(broken) * 1000);
  expect(micros("garbage")).toBeNaN();
});

test("micros is fast on a long run of fraction zeros", () => {
  const ts = `2024-01-02 10:11:12.${"00".repeat(50_000)}\n`;
  const t = performance.now();
  expect(micros(ts)).toBe(Date.parse(ts) * 1000);
  expect(micros(`2024-01-02 10:11:12.${"00".repeat(50_000)}`)).toBe(1704190272000000);
  expect(performance.now() - t).toBeLessThan(500);
});
