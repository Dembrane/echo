import { beforeEach, expect, test } from "bun:test";
import { MemoryAccessStore } from "@echo/access";
import { ForbiddenError, NotFoundError } from "@echo/core";
import type { Signed } from "@echo/http";
import { workspaceContext } from "../src/context";

const W = "c0000000-0000-4000-8000-000000000001";
const now = new Date("2026-09-27T12:00:00Z");
const ada: Signed = { appUserId: "u-ada", directusUserId: "d-ada", isStaff: false };
let store: MemoryAccessStore;

beforeEach(() => {
  store = new MemoryAccessStore();
  store.workspaces.set(W, {
    id: W,
    orgId: "org",
    visibility: "open_to_organisation",
    deleted: false,
    stickyRemoved: [],
    inheritOrgMembers: false,
    tier: "free",
  });
});

test("the old API's status codes: not onboarded 403, missing 404, no access 403", async () => {
  await expect(workspaceContext(store, { ...ada, appUserId: null }, W, now)).rejects.toThrow(
    "User not onboarded",
  );
  await expect(workspaceContext(store, ada, "not-a-uuid", now)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(workspaceContext(store, ada, W, now)).rejects.toThrow("No access to this workspace");
});

test("policies come from access, with the tier gate", async () => {
  store.memberships.push({
    workspaceId: W,
    appUserId: "u-ada",
    role: "admin",
    customPolicies: null,
    source: "direct",
  });
  const ctx = await workspaceContext(store, ada, W, now);
  expect(ctx.allows("settings:manage")).toBe(true);
  // Free tier: private workspaces need innovator.
  expect(ctx.allows("workspace:set_private")).toBe(false);
  expect(() => ctx.require("workspace:set_private")).toThrow("Access denied");
});

test("a staff support grant never makes the customer's decisions", async () => {
  store.memberships.push({
    workspaceId: W,
    appUserId: "u-ada",
    role: "admin",
    customPolicies: null,
    source: "staff_support",
    expiresAt: new Date("2026-09-28T00:00:00Z"),
  });
  const ctx = await workspaceContext(store, ada, W, now);
  expect(ctx.isSupportSession).toBe(true);
  expect(() => ctx.requireCustomer()).toThrow(ForbiddenError);
});
