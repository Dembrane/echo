import { id, orgs, projects, users, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";

const W = "/api/v2/workspaces";
const aDefault = `${W}/${workspaces.aDefault}`;
const aResearch = `${W}/${workspaces.aResearch}`;
const bDefault = `${W}/${workspaces.bDefault}`;
const missing = `${W}/c0000000-0000-4000-8000-000000000999`;
const m = (n: number) => id("e1", n);
const staff = users.admin.app;

// Ids for rows a scenario's setup adds; they are not in the seed.
const REQ = "9a000000-0000-4000-8000-000000000001";
const SUPPORT_REQ = "9b000000-0000-4000-8000-000000000001";
const SUPPORT_ROW = "9c000000-0000-4000-8000-000000000001";
const SHARE = "9d000000-0000-4000-8000-000000000001";
const ACCOUNT = "9e000000-0000-4000-8000-000000000001";

const staffLeftDefault = `update workspace_membership set deleted_at = now() where id = '${m(3)}'`;
const pendingAccessRequest = (ws: string, user: string) =>
  `insert into access_request (id, workspace_id, user_id, status, requested_at) values ('${REQ}', '${ws}', '${user}', 'pending', now())`;
const supportRequest = (ws: string, expires: string) =>
  `insert into support_access_request (id, workspace_id, requested_by, message, status, created_at, expires_at) values ('${SUPPORT_REQ}', '${ws}', '${staff}', 'Checking an import', 'pending', now() - interval '1 hour', ${expires})`;
const bDefaultBillsOnItsOwn = [
  `insert into billing_account (id, tier, payment_mode, workspace_id, created_at, updated_at) values ('${ACCOUNT}', 'free', 'none', '${workspaces.bDefault}', now(), now())`,
  `update workspace set billing_account_id = '${ACCOUNT}', usage_context = 'external', data_owner_email = 'rep@clientq.org', data_owner_org_name = 'Q' where id = '${workspaces.bDefault}'`,
];

export default scenarios([
  // GET /v2/orgs/:org_id/discoverable-workspaces
  {
    name: "discover: org owner sees every workspace",
    as: "alice",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/discoverable-workspaces`,
  },
  {
    name: "discover: org member sees open workspaces only",
    as: "admin",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/discoverable-workspaces`,
  },
  {
    name: "discover: a pending request shows as pending",
    as: "admin",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/discoverable-workspaces`,
    setup: [staffLeftDefault, pendingAccessRequest(workspaces.aDefault, staff)],
  },
  {
    name: "discover: external of the org is not a member",
    as: "bob",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/discoverable-workspaces`,
  },
  {
    name: "discover: never onboarded",
    as: "dave",
    method: "GET",
    path: `/api/v2/orgs/${orgs.a}/discoverable-workspaces`,
  },

  // POST /v2/workspaces/:id/join
  {
    name: "join: org admin rejoins an open workspace",
    as: "erin",
    method: "POST",
    path: `${aDefault}/join`,
    setup: [`update workspace_membership set deleted_at = now() where id = '${m(2)}'`],
  },
  {
    name: "join: already a member",
    as: "alice",
    method: "POST",
    path: `${aDefault}/join`,
  },
  {
    name: "join: org admin into a private workspace",
    as: "erin",
    method: "POST",
    path: `${aResearch}/join`,
    setup: [`update workspace_membership set deleted_at = now() where id = '${m(4)}'`],
    differs: "M-14: org admins may join invite-only workspaces but not private ones",
  },
  {
    name: "join: org member is not an admin",
    as: "admin",
    method: "POST",
    path: `${aDefault}/join`,
  },
  { name: "join: missing workspace", as: "alice", method: "POST", path: `${missing}/join` },
  { name: "join: anonymous", as: "anonymous", method: "POST", path: `${aDefault}/join` },

  // POST /v2/workspaces/:id/access-requests
  {
    name: "request access: org member asks to join an open workspace",
    as: "admin",
    method: "POST",
    path: `${aDefault}/access-requests`,
    setup: [staffLeftDefault],
  },
  {
    name: "request access: already pending",
    as: "admin",
    method: "POST",
    path: `${aDefault}/access-requests`,
    setup: [staffLeftDefault, pendingAccessRequest(workspaces.aDefault, staff)],
  },
  {
    name: "request access: already a member",
    as: "admin",
    method: "POST",
    path: `${aDefault}/access-requests`,
  },
  {
    name: "request access: private workspace answers as missing",
    as: "admin",
    method: "POST",
    path: `${aResearch}/access-requests`,
  },
  {
    name: "request access: org admins join instead",
    as: "erin",
    method: "POST",
    path: `${aDefault}/access-requests`,
  },
  {
    name: "request access: not in the org",
    as: "rita",
    method: "POST",
    path: `${bDefault}/access-requests`,
  },

  // GET /v2/workspaces/:id/access-requests
  {
    name: "access requests list: workspace owner",
    as: "alice",
    method: "GET",
    path: `${aDefault}/access-requests`,
    setup: [staffLeftDefault, pendingAccessRequest(workspaces.aDefault, staff)],
  },
  {
    name: "access requests list: org admin without a row",
    as: "erin",
    method: "GET",
    path: `${aResearch}/access-requests`,
    setup: [
      `update workspace_membership set deleted_at = now() where id = '${m(4)}'`,
      pendingAccessRequest(workspaces.aResearch, users.rita.app),
    ],
  },
  {
    name: "access requests list: member refused",
    as: "admin",
    method: "GET",
    path: `${aDefault}/access-requests`,
  },
  {
    name: "access requests list: other tenant",
    as: "bob",
    method: "GET",
    path: `${aDefault}/access-requests`,
  },

  // POST /v2/workspaces/:id/access-requests/:req_id/approve and /reject
  {
    name: "access request approve: owner grants member",
    as: "alice",
    method: "POST",
    path: `${aDefault}/access-requests/${REQ}/approve`,
    setup: [staffLeftDefault, pendingAccessRequest(workspaces.aDefault, staff)],
  },
  {
    name: "access request approve: an org biller gets the billing role",
    as: "alice",
    method: "POST",
    path: `${aDefault}/access-requests/${REQ}/approve`,
    setup: [
      `insert into org_membership (id, org_id, user_id, role, created_at, updated_at) values ('8c000000-0000-4000-8000-000000000002', '${orgs.a}', '${users.rita.app}', 'billing', now(), now())`,
      pendingAccessRequest(workspaces.aDefault, users.rita.app),
    ],
  },
  {
    name: "access request approve: someone already on the workspace just closes",
    as: "alice",
    method: "POST",
    path: `${aDefault}/access-requests/${REQ}/approve`,
    setup: [pendingAccessRequest(workspaces.aDefault, staff)],
  },
  {
    name: "access request approve: already actioned",
    as: "alice",
    method: "POST",
    path: `${aDefault}/access-requests/${REQ}/approve`,
    setup: [
      pendingAccessRequest(workspaces.aDefault, staff),
      `update access_request set status = 'rejected' where id = '${REQ}'`,
    ],
  },
  {
    name: "access request approve: request of another workspace",
    as: "erin",
    method: "POST",
    path: `${aResearch}/access-requests/${REQ}/approve`,
    setup: [pendingAccessRequest(workspaces.aDefault, staff)],
  },
  {
    name: "access request approve: unknown request",
    as: "alice",
    method: "POST",
    path: `${aDefault}/access-requests/${REQ}/approve`,
  },
  {
    name: "access request approve: member refused",
    as: "admin",
    method: "POST",
    path: `${aDefault}/access-requests/${REQ}/approve`,
    setup: [pendingAccessRequest(workspaces.aDefault, users.rita.app)],
  },
  {
    name: "access request reject: owner rejects silently",
    as: "alice",
    method: "POST",
    path: `${aDefault}/access-requests/${REQ}/reject`,
    setup: [staffLeftDefault, pendingAccessRequest(workspaces.aDefault, staff)],
  },
  {
    name: "access request reject: other tenant",
    as: "bob",
    method: "POST",
    path: `${aDefault}/access-requests/${REQ}/reject`,
    setup: [pendingAccessRequest(workspaces.aDefault, staff)],
  },

  // GET /v2/workspaces/:id/support-access/events
  {
    name: "support events: owner reads the audit trail",
    as: "alice",
    method: "GET",
    path: `${aDefault}/support-access/events`,
    setup: [
      `insert into support_access_event (id, workspace_id, event_code, actor_user_id, staff_user_id, params, created_at) values ('9f000000-0000-4000-8000-000000000001', '${workspaces.aDefault}', 'toggle_enabled', '${users.alice.app}', null, '{}', now() - interval '2 hours'), ('9f000000-0000-4000-8000-000000000002', '${workspaces.aDefault}', 'staff_joined', null, '${staff}', '{"membership_id": "x"}', now() - interval '1 hour')`,
    ],
  },
  {
    name: "support events: paging",
    as: "alice",
    method: "GET",
    path: `${aDefault}/support-access/events`,
    query: { page: "2", limit: "1" },
    setup: [
      `insert into support_access_event (id, workspace_id, event_code, params, created_at) values ('9f000000-0000-4000-8000-000000000001', '${workspaces.aDefault}', 'toggle_enabled', null, now() - interval '2 hours'), ('9f000000-0000-4000-8000-000000000002', '${workspaces.aDefault}', 'toggle_disabled', null, now() - interval '1 hour'), ('9f000000-0000-4000-8000-000000000003', '${workspaces.aDefault}', 'toggle_enabled', null, now())`,
    ],
  },
  {
    name: "support events: limit out of range",
    as: "alice",
    method: "GET",
    path: `${aDefault}/support-access/events`,
    query: { limit: "101" },
  },
  {
    name: "support events: member lacks settings:manage",
    as: "admin",
    method: "GET",
    path: `${aDefault}/support-access/events`,
  },

  // GET /v2/workspaces/:id/support-access/requests
  {
    name: "support requests: owner sees the pending request",
    as: "alice",
    method: "GET",
    path: `${aDefault}/support-access/requests`,
    setup: [supportRequest(workspaces.aDefault, "now() + interval '7 days'")],
  },
  {
    name: "support requests: observer refused",
    as: "rita",
    method: "GET",
    path: `${aResearch}/support-access/requests`,
  },

  // POST .../support-access/requests/:id/approve and /deny
  {
    name: "support approve: grants staff 24 hours of admin",
    as: "erin",
    method: "POST",
    path: `${aResearch}/support-access/requests/${SUPPORT_REQ}/approve`,
    setup: [supportRequest(workspaces.aResearch, "now() + interval '7 days'")],
  },
  {
    name: "support approve: staff already a member keeps the row",
    as: "alice",
    method: "POST",
    path: `${aDefault}/support-access/requests/${SUPPORT_REQ}/approve`,
    setup: [supportRequest(workspaces.aDefault, "now() + interval '7 days'")],
  },
  {
    name: "support approve: an expired request is expired and refused",
    as: "alice",
    method: "POST",
    path: `${aDefault}/support-access/requests/${SUPPORT_REQ}/approve`,
    setup: [supportRequest(workspaces.aDefault, "now() - interval '1 minute'")],
  },
  {
    name: "support approve: request of another workspace",
    as: "erin",
    method: "POST",
    path: `${aResearch}/support-access/requests/${SUPPORT_REQ}/approve`,
    setup: [supportRequest(workspaces.aDefault, "now() + interval '7 days'")],
  },
  {
    name: "support approve: member refused",
    as: "admin",
    method: "POST",
    path: `${aDefault}/support-access/requests/${SUPPORT_REQ}/approve`,
    setup: [supportRequest(workspaces.aDefault, "now() + interval '7 days'")],
  },
  {
    name: "support deny: owner denies",
    as: "alice",
    method: "POST",
    path: `${aDefault}/support-access/requests/${SUPPORT_REQ}/deny`,
    setup: [supportRequest(workspaces.aDefault, "now() + interval '7 days'")],
  },
  {
    name: "support deny: already resolved",
    as: "alice",
    method: "POST",
    path: `${aDefault}/support-access/requests/${SUPPORT_REQ}/deny`,
    setup: [
      supportRequest(workspaces.aDefault, "now() + interval '7 days'"),
      `update support_access_request set status = 'denied' where id = '${SUPPORT_REQ}'`,
    ],
  },

  // Support consent side effects that need state the seed lacks
  {
    name: "settings update: turning support off ends live staff sessions",
    as: "erin",
    method: "PATCH",
    path: `${aResearch}/settings`,
    body: { allow_support_access: false },
    setup: [
      `update workspace set allow_support_access = true where id = '${workspaces.aResearch}'`,
      `insert into workspace_membership (id, workspace_id, user_id, role, source, expires_at, created_at, updated_at) values ('${SUPPORT_ROW}', '${workspaces.aResearch}', '${staff}', 'admin', 'staff_support', now() + interval '20 hours', now(), now())`,
    ],
    differs: "H-13: turning consent off revokes live staff support rows at once",
  },
  {
    name: "settings update: turning support on supersedes pending requests",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { allow_support_access: true },
    setup: [supportRequest(workspaces.aDefault, "now() + interval '7 days'")],
  },

  // GET /v2/projects/:id/members
  {
    name: "shares list: workspace owner of a private project",
    as: "erin",
    method: "GET",
    path: `/api/v2/projects/${projects.p2}/members`,
    setup: [
      `insert into project_membership (id, project_id, user_id, granted_by, created_at) values ('${SHARE}', '${projects.p2}', '${users.alice.app}', '${users.erin.app}', now())`,
    ],
  },
  {
    name: "shares list: a shared member sees their own email only",
    as: "alice",
    method: "GET",
    path: `/api/v2/projects/${projects.p2}/members`,
    setup: [
      `insert into project_membership (id, project_id, user_id, granted_by, created_at) values ('${SHARE}', '${projects.p2}', '${users.alice.app}', '${users.erin.app}', now()), ('9d000000-0000-4000-8000-000000000002', '${projects.p2}', '${users.rita.app}', '${users.erin.app}', now())`,
    ],
  },
  {
    name: "shares list: no shares",
    as: "alice",
    method: "GET",
    path: `/api/v2/projects/${projects.p1}/members`,
  },
  {
    name: "shares list: other tenant",
    as: "bob",
    method: "GET",
    path: `/api/v2/projects/${projects.p1}/members`,
  },
  {
    name: "shares list: legacy project has no workspace",
    as: "dave",
    method: "GET",
    path: `/api/v2/projects/${projects.legacy}/members`,
  },
  {
    name: "shares list: missing project",
    as: "alice",
    method: "GET",
    path: "/api/v2/projects/f0000000-0000-4000-8000-000000000999/members",
  },

  // GET /v2/projects/:id/invites
  {
    name: "share invites: pending invite carrying the project",
    as: "erin",
    method: "GET",
    path: `/api/v2/projects/${projects.p2}/invites`,
    setup: [
      `insert into workspace_invite (id, workspace_id, email, role, invited_by, expires_at, created_at, project_id) values ('9d100000-0000-4000-8000-000000000001', '${workspaces.aResearch}', 'guest@example.org', 'member', '${users.erin.app}', now() + interval '7 days', now(), '${projects.p2}')`,
    ],
  },
  {
    name: "share invites: free workspace answers empty",
    as: "bob",
    method: "GET",
    path: `/api/v2/projects/${projects.p3}/invites`,
  },
  {
    name: "share invites: member is not a share admin",
    as: "admin",
    method: "GET",
    path: `/api/v2/projects/${projects.p1}/invites`,
  },

  // POST /v2/projects/:id/members
  {
    name: "shares add: owner shares the private project with a member",
    as: "erin",
    method: "POST",
    path: `/api/v2/projects/${projects.p2}/members`,
    body: { email: "Alice.Parity@example.com" },
  },
  {
    name: "shares add: sharing twice keeps one row",
    as: "erin",
    method: "POST",
    path: `/api/v2/projects/${projects.p2}/members`,
    body: { email: "alice.parity@example.com" },
    setup: [
      `insert into project_membership (id, project_id, user_id, granted_by, created_at) values ('${SHARE}', '${projects.p2}', '${users.alice.app}', '${users.erin.app}', now())`,
    ],
  },
  {
    name: "shares add: workspace-visible project needs no share",
    as: "alice",
    method: "POST",
    path: `/api/v2/projects/${projects.p1}/members`,
    body: { email: "erin.parity@example.com" },
  },
  {
    name: "shares add: someone outside the workspace",
    as: "erin",
    method: "POST",
    path: `/api/v2/projects/${projects.p2}/members`,
    body: { email: "dave.parity@example.com" },
  },
  {
    name: "shares add: someone on another workspace",
    as: "erin",
    method: "POST",
    path: `/api/v2/projects/${projects.p2}/members`,
    body: { email: "parity-admin@example.com" },
  },
  {
    name: "shares add: member is not a share admin",
    as: "alice",
    method: "POST",
    path: `/api/v2/projects/${projects.p2}/members`,
    body: { email: "erin.parity@example.com" },
  },
  {
    name: "shares add: invalid email",
    as: "erin",
    method: "POST",
    path: `/api/v2/projects/${projects.p2}/members`,
    body: { email: "not an email" },
  },

  // DELETE /v2/projects/:id/members/:user_id
  {
    name: "shares revoke: owner revokes",
    as: "erin",
    method: "DELETE",
    path: `/api/v2/projects/${projects.p2}/members/${users.alice.app}`,
    setup: [
      `insert into project_membership (id, project_id, user_id, granted_by, created_at) values ('${SHARE}', '${projects.p2}', '${users.alice.app}', '${users.erin.app}', now())`,
    ],
  },
  {
    name: "shares revoke: a duplicate share goes too",
    as: "erin",
    method: "DELETE",
    path: `/api/v2/projects/${projects.p2}/members/${users.alice.app}`,
    setup: [
      `insert into project_membership (id, project_id, user_id, granted_by, created_at) values ('${SHARE}', '${projects.p2}', '${users.alice.app}', '${users.erin.app}', now()), ('9d000000-0000-4000-8000-000000000002', '${projects.p2}', '${users.alice.app}', '${users.erin.app}', now())`,
    ],
    differs: "L-13: revoking deletes every share row for the person, not just the first",
  },
  {
    name: "shares revoke: nothing to revoke",
    as: "erin",
    method: "DELETE",
    path: `/api/v2/projects/${projects.p2}/members/${users.alice.app}`,
  },
  {
    name: "shares revoke: free workspace is below the sharing tier",
    as: "bob",
    method: "DELETE",
    path: `/api/v2/projects/${projects.p3}/members/${users.alice.app}`,
  },

  // Workspace flows that need state the seed lacks
  {
    name: "workspaces delete: owner deletes a workspace without live projects",
    as: "bob",
    method: "DELETE",
    path: bDefault,
    setup: [`update project set deleted_at = now() where id = '${projects.p3}'`],
  },
  {
    name: "workspaces handoff initiate: external workspace offered to another org",
    as: "bob",
    method: "POST",
    path: `${bDefault}/handoff/initiate`,
    body: { target_organisation_id: orgs.a, message: "Yours now" },
    setup: bDefaultBillsOnItsOwn,
  },
  {
    name: "workspaces handoff initiate: already pending",
    as: "bob",
    method: "POST",
    path: `${bDefault}/handoff/initiate`,
    body: { target_organisation_id: orgs.a },
    setup: [
      ...bDefaultBillsOnItsOwn,
      `update workspace set handoff_status = 'pending', handoff_target_team_id = '${orgs.a}' where id = '${workspaces.bDefault}'`,
    ],
  },
  {
    name: "workspaces handoff initiate: target is the billing org",
    as: "bob",
    method: "POST",
    path: `${bDefault}/handoff/initiate`,
    body: { target_organisation_id: orgs.b },
    setup: bDefaultBillsOnItsOwn,
  },
  {
    name: "workspaces handoff accept: target org admin accepts",
    as: "alice",
    method: "POST",
    path: `${bDefault}/handoff/accept`,
    setup: [
      ...bDefaultBillsOnItsOwn,
      `update workspace set handoff_status = 'pending', handoff_target_team_id = '${orgs.a}' where id = '${workspaces.bDefault}'`,
      `insert into workspace_membership (id, workspace_id, user_id, role, source, created_at, updated_at) values ('9c000000-0000-4000-8000-000000000002', '${workspaces.bDefault}', '${users.alice.app}', 'external', 'direct', now(), now())`,
    ],
  },
  {
    name: "workspaces handoff cancel: billing org cancels",
    as: "bob",
    method: "POST",
    path: `${bDefault}/handoff/cancel`,
    setup: [
      ...bDefaultBillsOnItsOwn,
      `update workspace set handoff_status = 'pending', handoff_target_team_id = '${orgs.a}' where id = '${workspaces.bDefault}'`,
    ],
  },
  {
    name: "data ownership: external client goes back to the org's plan",
    as: "bob",
    method: "PATCH",
    path: `${bDefault}/data-ownership`,
    body: { usage_context: "internal" },
    setup: bDefaultBillsOnItsOwn,
  },
]);
