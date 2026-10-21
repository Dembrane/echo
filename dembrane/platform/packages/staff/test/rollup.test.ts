import { expect, test } from "bun:test";
import { accountMonthlyForecast, atRisk, billingRollup, isTrialAccount, monthWindow } from "../src";
import type { StaffStorage } from "../src/storage";

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

// Two workspaces with two hours each this month: one free, one paid.
function fakeStorage(): StaffStorage {
  const ws = (id: string, tier: string) => ({
    id,
    name: id,
    org_id: null,
    visibility: null,
    settings: {},
    billed_to_team_id: null,
    account_id: `acc-${id}`,
    account_org_id: null,
    account_workspace_id: id,
    payment_mode: null,
    label: null,
    tier,
    tier_expires_at: null,
    downgraded_at: null,
    downgraded_from_tier: null,
    percent_discount: null,
    type_discount: null,
    billing_period: null,
  });
  const fake = {
    rollupWorkspaces: async () => [ws("free-ws", "free"), ws("paid-ws", "changemaker")],
    orgs: async () => [],
    liveProjects: async () => [
      { id: "p-free", workspace_id: "free-ws" },
      { id: "p-paid", workspace_id: "paid-ws" },
    ],
    memberships: async () => [],
    orgMembershipsIn: async () => [],
    secondsByProject: async (ids: string[]) =>
      ids.map((project_id) => ({ project_id, seconds: 7200 })),
    appUsers: async () => [],
    recentLoginCount: async () => 0,
  };
  return fake as unknown as StaffStorage;
}

test("the staff rollup shows no free hours cap: the monthly meter lives on the ledger", async () => {
  const now = new Date("2026-10-25T00:00:00Z");
  const rollup = await billingRollup(fakeStorage(), now, 0);
  const free = rollup.rows.find((r) => r.workspace_id === "free-ws");
  expect(free).toMatchObject({
    audio_hours: 2,
    audio_hours_included: null,
    hours_pct: null,
    over_hours: 0,
    at_cap: false,
    approaching_cap: false,
  });
  expect(rollup.rows.find((r) => r.workspace_id === "paid-ws")).toMatchObject({
    audio_hours_included: null,
    at_cap: false,
  });
  expect(await atRisk(fakeStorage(), now)).toEqual([]);
});

test("at-risk lists a free workspace at its monthly audio limit from the ledger", async () => {
  const now = new Date("2026-10-25T00:00:00Z");
  const atCap = new Map([["free-ws", { used: 18000, limit: 18000 }]]);
  expect(await atRisk(fakeStorage(), now, atCap)).toEqual([
    {
      workspace_id: "free-ws",
      workspace_name: "free-ws",
      org_id: "",
      org_name: "",
      tier: "free",
      reason: "at_cap",
      detail: "5.0h / 5h free monthly limit",
    },
  ]);
});
