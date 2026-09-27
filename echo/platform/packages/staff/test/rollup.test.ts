import { expect, test } from "bun:test";
import { accountMonthlyForecast, isTrialAccount, monthWindow } from "../src";

test("month windows walk across year boundaries", () => {
  const now = new Date("2026-01-15T12:00:00Z");
  expect(monthWindow(now, 0)).toEqual(["2026-01-01T00:00:00+00:00", "2026-02-01T00:00:00+00:00"]);
  expect(monthWindow(now, -1)).toEqual(["2025-12-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00"]);
  expect(monthWindow(now, -12)).toEqual(["2025-01-01T00:00:00+00:00", "2025-02-01T00:00:00+00:00"]);
  expect(monthWindow(new Date("2026-12-31T23:00:00Z"))).toEqual([
    "2026-12-01T00:00:00+00:00",
    "2027-01-01T00:00:00+00:00",
  ]);
});

test("trials: flagged, or a comped paid tier with a future expiry", () => {
  const now = new Date("2026-09-27T00:00:00Z");
  const base = { typeDiscount: null, paymentMode: "none", tier: "changemaker", now };
  expect(isTrialAccount({ ...base, typeDiscount: "trial", tierExpiresAt: null })).toBe(true);
  expect(isTrialAccount({ ...base, tierExpiresAt: "2026-10-01 00:00:00+00" })).toBe(true);
  expect(isTrialAccount({ ...base, tierExpiresAt: "2026-09-01 00:00:00+00" })).toBe(false);
  expect(
    isTrialAccount({ ...base, paymentMode: "mollie", tierExpiresAt: "2026-10-01T00:00:00Z" }),
  ).toBe(false);
  expect(isTrialAccount({ ...base, tier: "free", tierExpiresAt: "2026-10-01T00:00:00Z" })).toBe(
    false,
  );
});

test("the staff forecast is the monthly share of what Mollie charges, discounted", () => {
  expect(accountMonthlyForecast("changemaker", 4, "annual", null)).toBe(300);
  expect(accountMonthlyForecast("changemaker", 4, "monthly", 10)).toBe(309.6);
  expect(accountMonthlyForecast("guardian", 0, null, 100)).toBe(0);
  expect(accountMonthlyForecast("free", 10, "annual", null)).toBe(0);
  expect(accountMonthlyForecast("pilot", 10, "annual", null)).toBe(0);
});
