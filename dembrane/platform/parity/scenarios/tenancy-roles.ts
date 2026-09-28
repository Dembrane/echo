import { id, orgs, projects, users, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";

// Roles the seed does not hold, set up per scenario: workspace billing, org billing and a
// staff member on a live support grant.
const W = "/api/v2/workspaces";
const aDefault = `${W}/${workspaces.aDefault}`;
const aResearch = `${W}/${workspaces.aResearch}`;
const staffMemberOfDefault = id("e1", 3);
const SUPPORT_ROW = "9c000000-0000-4000-8000-000000000001";

const staffIsBilling = `update workspace_membership set role = 'billing' where id = '${staffMemberOfDefault}'`;
const staffOrgBilling = `update org_membership set role = 'billing' where id = '${id("e0", 4)}'`;
const staffOnSupport = `insert into workspace_membership (id, workspace_id, user_id, role, source, expires_at, created_at, updated_at) values ('${SUPPORT_ROW}', '${workspaces.aResearch}', '${users.admin.app}', 'admin', 'staff_support', now() + interval '20 hours', now(), now())`;
const Q4 = "CTO Q4: a staff support grant never makes the customer's member decisions";

export default scenarios([
  // Workspace billing: finance only, no project data.
  {
    name: "billing role: usage with financials",
    as: "admin",
    method: "GET",
    path: `${aDefault}/usage`,
    setup: [staffIsBilling],
  },
  {
    name: "billing role: settings",
    as: "admin",
    method: "GET",
    path: `${aDefault}/settings`,
    setup: [staffIsBilling],
  },
  {
    name: "billing role: no project list",
    as: "admin",
    method: "GET",
    path: `${aDefault}/projects`,
    setup: [staffIsBilling],
  },
  {
    name: "billing role: no project creation",
    as: "admin",
    method: "POST",
    path: `${aDefault}/projects`,
    body: { name: "x" },
    setup: [staffIsBilling],
  },
  {
    name: "billing role: no project shares",
    as: "admin",
    method: "GET",
    path: `/api/v2/projects/${projects.p1}/members`,
    setup: [staffIsBilling],
    differs: "M-4: workspace billing has no project access, so no share list either",
  },
  {
    name: "billing role: cannot be shared a project",
    as: "alice",
    method: "POST",
    path: `/api/v2/projects/${projects.p2}/members`,
    body: { email: "parity-admin@example.com" },
    setup: [
      `insert into workspace_membership (id, workspace_id, user_id, role, source, created_at, updated_at) values ('9c000000-0000-4000-8000-000000000003', '${workspaces.aResearch}', '${users.admin.app}', 'billing', 'direct', now(), now())`,
      `update workspace_membership set role = 'owner' where id = '${id("e1", 5)}'`,
    ],
  },
  {
    name: "billing role: listed with its role in the workspace list",
    as: "admin",
    method: "GET",
    path: W,
    setup: [staffIsBilling],
  },

  // Org billing: reads the money side of the org.
  {
    name: "org billing: referral ledger",
    as: "admin",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/referral-ledger`,
    setup: [staffOrgBilling],
  },
  {
    name: "org billing: usage of every workspace",
    as: "admin",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/usage`,
    setup: [staffOrgBilling],
  },
  {
    name: "org billing: no org projects",
    as: "admin",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/projects`,
    setup: [staffOrgBilling],
  },
  {
    name: "org billing: request access to an open workspace",
    as: "admin",
    method: "POST",
    path: `${aDefault}/access-requests`,
    setup: [
      staffOrgBilling,
      `update workspace_membership set deleted_at = now() where id = '${staffMemberOfDefault}'`,
    ],
  },

  // Staff on a live support grant (admin role, staff_support source).
  {
    name: "support session: reads settings",
    as: "admin",
    method: "GET",
    path: `${aResearch}/settings`,
    setup: [staffOnSupport],
    differs: "L-26: workspace:api_access was never enforced and is no longer listed",
  },
  {
    name: "support session: lists projects, private ones included",
    as: "admin",
    method: "GET",
    path: `${aResearch}/projects`,
    setup: [staffOnSupport],
  },
  {
    name: "support session: cannot change a member's role",
    as: "admin",
    method: "PATCH",
    path: `${aResearch}/members/${id("e1", 5)}`,
    body: { role: "billing" },
    setup: [staffOnSupport],
    differs: Q4,
  },
  {
    name: "support session: cannot remove a member",
    as: "admin",
    method: "DELETE",
    path: `${aResearch}/members/${id("e1", 6)}`,
    setup: [staffOnSupport],
    differs: Q4,
  },
  {
    name: "support session: cannot turn consent back on",
    as: "admin",
    method: "PATCH",
    path: `${aResearch}/settings`,
    body: { allow_support_access: true },
    setup: [staffOnSupport],
    differs: "H-13: a staff support session cannot grant itself standing consent",
  },
  {
    name: "support session: can leave",
    as: "admin",
    method: "DELETE",
    path: `${aResearch}/members/${SUPPORT_ROW}`,
    setup: [staffOnSupport],
  },
  {
    name: "support session: an expired grant gives no access",
    as: "admin",
    method: "GET",
    path: `${aResearch}/settings`,
    setup: [
      staffOnSupport,
      `update workspace_membership set expires_at = now() - interval '1 minute' where id = '${SUPPORT_ROW}'`,
    ],
  },
]);
