import { expect, test } from "bun:test";
import { flagsHighRisk, trainingStatus } from "../src";

const now = new Date("2026-09-27T00:00:00Z");

test("training: the active licence wins and expiring within 30 days is flagged", () => {
  expect(
    trainingStatus(
      [
        { status: "active", expiresAt: "2026-10-10T00:00:00Z" },
        { status: "expired", expiresAt: "2025-01-01T00:00:00Z" },
      ],
      now,
    ),
  ).toEqual({ trained: true, trained_until: "2026-10-10T00:00:00Z", expiring_soon: true });
});

test("training: a past or revoked licence is not trained and hides its expiry", () => {
  expect(trainingStatus([{ status: "active", expiresAt: "2026-01-01T00:00:00Z" }], now)).toEqual({
    trained: false,
    trained_until: null,
    expiring_soon: false,
  });
  expect(trainingStatus([], now).trained).toBe(false);
});

test("high risk comes only from q2 yes/true", () => {
  expect(flagsHighRisk([{ q1: "x" }, { q2: " Yes " }])).toBe(true);
  expect(flagsHighRisk([{ q2: true }])).toBe(true);
  expect(flagsHighRisk([{ q2: "no" }])).toBe(false);
  expect(flagsHighRisk("junk")).toBe(false);
});
