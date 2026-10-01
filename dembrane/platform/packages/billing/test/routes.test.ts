import { expect, test } from "bun:test";
import { Access, MemoryAccessStore, MemoryStaffAudit } from "@dembrane/access";
import { PlatformError } from "@dembrane/core";
import type { Env, Signed } from "@dembrane/http";
import { Hono } from "hono";
import { type Billing, billingRoutes } from "../src";
import { ACC, ORG, U, WS1, world } from "./helpers";

const who = (appUserId: string, isStaff = false): Signed => ({
  appUserId,
  directusUserId: `d-${appUserId}`,
  isStaff,
});

/** A workspace-scoped account on WS1 (billed separately), plus the access rows around it. */
function setup(orgScoped = false) {
  const w = world(orgScoped ? {} : { org_id: null, workspace_id: WS1 });
  const access = new MemoryAccessStore();
  access.workspaces.set(WS1, {
    id: WS1,
    orgId: ORG,
    visibility: "open_to_organisation",
    deleted: false,
    stickyRemoved: [],
    inheritOrgMembers: false,
    tier: "changemaker",
  });
  const direct = (appUserId: string, role: string) =>
    access.memberships.push({
      workspaceId: WS1,
      appUserId,
      role,
      customPolicies: [],
      source: "direct",
    });
  direct(U.admin, "admin");
  direct(U.member, "member");
  direct(U.external, "billing");
  // The observer holds the org billing role and no workspace membership.
  w.store.orgMembers.push({
    id: "e0000000-0000-4000-8000-000000000009",
    org_id: ORG,
    user_id: U.observer,
    role: "billing",
  });
  const audit = new MemoryStaffAudit();
  const billing: Billing = {
    service: w.service,
    store: w.store,
    notifier: w.notifier,
    mollie: w.mollie,
  };
  const app = new Hono<Env>();
  let principal: Signed | null = null;
  app.use(async (c, next) => {
    c.set("principal", principal);
    c.set("requestId", "r1");
    await next();
  });
  app.route(
    "/",
    billingRoutes({ db: {} as never, access: new Access(access), staffAudit: audit, billing }),
  );
  app.onError((err, c) =>
    c.json(
      { detail: err instanceof PlatformError ? (err.details ?? err.message) : String(err) },
      (err instanceof PlatformError ? err.status : 500) as 400,
    ),
  );
  const call = async (as: Signed | null, method: string, path: string) => {
    principal = as;
    const res = await app.request(`/api/v2/billing-accounts/${ACC}${path}`, { method });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { w, audit, call };
}

test("M-16: a separately billed workspace follows the workspace's billing policies", async () => {
  const { call } = setup();
  expect((await call(who(U.admin), "GET", "/overview")).status).toBe(200);
  expect((await call(who(U.admin), "POST", "/retry-charge")).body).toEqual({ status: "none" });
  expect((await call(who(U.external), "GET", "/estimate")).status).toBe(200); // workspace billing role
  const member = await call(who(U.member), "GET", "/overview");
  expect(member).toEqual({
    status: 403,
    body: { detail: "You must be an organisation owner, admin, or billing role." },
  });
  // An org billing member no longer reaches a workspace that bills on its own account.
  expect((await call(who(U.observer), "GET", "/overview")).status).toBe(403);
  expect((await call(null, "GET", "/overview")).status).toBe(401);
});

test("org-scoped accounts keep the org billing roles", async () => {
  const { call } = setup(true);
  expect((await call(who(U.observer), "GET", "/overview")).status).toBe(200);
  expect((await call(who(U.owner), "GET", "/overview")).status).toBe(200);
  expect((await call(who(U.member), "GET", "/overview")).status).toBe(403);
});

test("staff pass with staff:billing and every use is on the trail", async () => {
  const { call, audit } = setup();
  const staff = who("a0000000-0000-4000-8000-000000000077", true);
  expect((await call(staff, "GET", "/billing-details")).status).toBe(200);
  expect((await call(staff, "POST", "/retry-charge")).status).toBe(200);
  expect(audit.entries.map((e) => [e.permission, e.action, e.targetId, e.requestId])).toEqual([
    ["staff:billing", "billing_account.details.read", ACC, "r1"],
    ["staff:billing", "billing_account.retry_charge", ACC, "r1"],
  ]);
  const narrow = { ...staff, staffPolicies: ["staff:training"] as const };
  expect((await call(narrow, "GET", "/billing-details")).status).toBe(403);
});
