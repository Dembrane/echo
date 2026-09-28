import { expect, test } from "bun:test";
import {
  customPolicies,
  meetsTier,
  POLICIES,
  type Policy,
  roleHas,
  stickyRemovedIds,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from "../src";

// Spec 2.4, column by column, with one intended change: billing has no project data.
const Y = true;
const _ = false;
const MATRIX: Record<
  Policy,
  [
    observer: boolean,
    external: boolean,
    member: boolean,
    billing: boolean,
    admin: boolean,
    owner: boolean,
  ]
> = {
  "project:read": [Y, Y, Y, _, Y, Y],
  "project:create": [_, _, Y, _, Y, Y],
  "project:update": [_, Y, Y, _, Y, Y],
  "project:delete": [_, _, _, _, Y, Y],
  "project:share": [_, _, _, _, Y, Y],
  "project:set_private": [_, _, _, _, Y, Y],
  "project:move": [_, _, _, _, Y, Y],
  "conversation:read": [Y, Y, Y, _, Y, Y],
  "conversation:delete": [_, _, Y, _, Y, Y],
  "chat:use": [_, Y, Y, _, Y, Y],
  "report:view": [Y, Y, Y, _, Y, Y],
  "report:generate": [_, Y, Y, _, Y, Y],
  "report:publish": [_, _, Y, _, Y, Y],
  "report:delete": [_, _, _, _, Y, Y],
  "member:invite": [_, _, _, _, Y, Y],
  "member:manage": [_, _, _, _, Y, Y],
  "settings:manage": [_, _, _, _, Y, Y],
  "workspace:view_usage": [_, _, Y, Y, Y, Y],
  "workspace:view_invoices": [_, _, _, Y, Y, Y],
  "workspace:update_payment": [_, _, _, Y, Y, Y],
  "workspace:export": [_, _, _, _, Y, Y],
  "workspace:set_private": [_, _, _, _, Y, Y],
  "workspace:whitelabel": [_, _, _, _, Y, Y],
  "workspace:webhooks": [_, _, _, _, Y, Y],
  "upgrade:request": [_, _, _, Y, Y, Y],
};

test("the matrix covers every policy", () => {
  expect(Object.keys(MATRIX).sort()).toEqual([...POLICIES].sort());
});

for (const policy of POLICIES) {
  test(`${policy} per role`, () => {
    const got = WORKSPACE_ROLES.map((r: WorkspaceRole) => roleHas(r, policy));
    expect(got).toEqual(MATRIX[policy]);
  });
}

test("custom policies only add known policies; '*' and junk are ignored", () => {
  expect(customPolicies(["project:delete", "*", "nonsense", 7])).toEqual(["project:delete"]);
  expect(customPolicies(null)).toEqual([]);
  expect(roleHas("observer", "project:delete", customPolicies(["project:delete"]))).toBe(true);
  expect(roleHas("observer", "project:delete", customPolicies(["*"]))).toBe(false);
});

test("tiers rank free < innovator < changemaker < guardian; legacy literals never pass; no tier is never gated", () => {
  expect(meetsTier("innovator", "innovator")).toBe(true);
  expect(meetsTier("guardian", "changemaker")).toBe(true);
  expect(meetsTier("free", "innovator")).toBe(false);
  expect(meetsTier("pioneer", "innovator")).toBe(false);
  expect(meetsTier(null, "changemaker")).toBe(true);
});

test("sticky removals read the {user_id} tombstones the old API writes, and bare ids", () => {
  expect(
    stickyRemovedIds([
      { user_id: "u1", removed_at: "2026-09-01T00:00:00Z", removed_by: "u9" },
      "u2",
      { removed_at: "no user" },
      7,
    ]),
  ).toEqual(["u1", "u2"]);
  expect(stickyRemovedIds(null)).toEqual([]);
});
