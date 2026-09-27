import { expect, test } from "bun:test";
import {
  applyDiscount,
  computeMonthlyBillingPrice,
  money2,
  perIntervalAmount,
  planDescription,
  pyRound,
  subscriptionStartDate,
} from "../src";

test("rounding is Python's: half to even on the exact binary value", () => {
  expect(pyRound(2.5)).toBe(2);
  expect(pyRound(3.5)).toBe(4);
  expect(pyRound(0.125, 2)).toBe(0.12); // exact tie, even digit kept
  expect(pyRound(0.375, 2)).toBe(0.38);
  expect(pyRound(0.135, 2)).toBe(0.14); // 0.135 is stored slightly above the tie
  expect(pyRound(2.675, 2)).toBe(2.67); // stored slightly below the tie
  expect(pyRound(-2.5)).toBe(-2);
  expect(money2(0.125)).toBe("0.12");
  expect(money2(300)).toBe("300.00");
});

test("monthly cadence is the annual rate plus 15%, to whole euros", () => {
  expect(computeMonthlyBillingPrice(20)).toBe(23);
  expect(computeMonthlyBillingPrice(75)).toBe(86); // 86.25
  expect(computeMonthlyBillingPrice(150)).toBe(172); // 172.49999 in binary
});

test("interval amounts: annual bills twelve months once, monthly the surcharged rate", () => {
  expect(perIntervalAmount("changemaker", 4, "annual")).toEqual({
    amount: 3600,
    interval: "12 months",
  });
  expect(perIntervalAmount("changemaker", 4, "monthly")).toEqual({
    amount: 344,
    interval: "1 month",
  });
  expect(perIntervalAmount("guardian", 0, "monthly").amount).toBe(172); // at least one seat
  expect(() => perIntervalAmount("free", 3, "annual")).toThrow("tier free is not payable");
  expect(() => perIntervalAmount("pioneer", 3, "annual")).toThrow();
});

test("discounts clamp to 0..100 and round to cents", () => {
  expect(applyDiscount(3600, 15)).toBe(3060);
  expect(applyDiscount(344, 33)).toBe(230.48);
  expect(applyDiscount(344, null)).toBe(344);
  expect(applyDiscount(344, 150)).toBe(0);
  expect(applyDiscount(344, -10)).toBe(344);
  expect(applyDiscount(10.005, 0)).toBe(10.01);
});

test("plan description reads like a receipt", () => {
  expect(planDescription("changemaker", 1, "monthly")).toBe(
    "Changemaker plan. 1 seat, billed monthly, renews monthly. Cancel anytime.",
  );
  expect(planDescription("GUARDIAN", 3, "annual")).toBe(
    "Guardian plan. 3 seats, billed yearly, renews yearly. Cancel anytime.",
  );
});

test("the first renewal is one full period out, clamped to the month's end", () => {
  expect(subscriptionStartDate("monthly", new Date("2027-01-31T12:00:00Z"))).toBe("2027-02-28");
  expect(subscriptionStartDate("annual", new Date("2028-02-29T12:00:00Z"))).toBe("2029-02-28");
  expect(subscriptionStartDate("monthly", new Date("2026-12-15T00:00:00Z"))).toBe("2027-01-15");
  expect(subscriptionStartDate(null, new Date("2026-09-27T00:00:00Z"))).toBe("2026-10-27");
});

test("pyRound and money2 agree with CPython on 400 recorded values", async () => {
  // Generated with CPython 3: [x, ndigits, round(x, ndigits), "%.2f" % x].
  const rows = (await Bun.file(
    new URL("./fixtures/python-rounding.json", import.meta.url),
  ).json()) as [number, number, number, string][];
  for (const [x, nd, rounded, fixed2] of rows) {
    expect(pyRound(x, nd)).toBe(rounded);
    expect(money2(x)).toBe(fixed2);
  }
});
