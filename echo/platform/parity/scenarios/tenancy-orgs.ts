import { id, orgs, users, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";

const O = "/api/v2/orgs";
const orgA = `${O}/${orgs.a}`;
const orgB = `${O}/${orgs.b}`;
const missingOrg = `${O}/b0000000-0000-4000-8000-000000000999`;
const orgMem = (n: number) => id("e0", n);

const pendingInvites = [
  `insert into org_invite (id, org_id, email, role, invited_by, expires_at, created_at) values ('8a000000-0000-4000-8000-000000000001', '${orgs.a}', 'new.person@example.org', 'admin', '${users.alice.app}', now() + interval '7 days', now() - interval '1 hour')`,
  `insert into workspace_invite (id, workspace_id, email, role, invited_by, expires_at, created_at) values ('8b000000-0000-4000-8000-000000000001', '${workspaces.aDefault}', 'Guest Two@example.org', 'member', '${users.erin.app}', now() + interval '7 days', now())`,
  `insert into workspace_invite (id, workspace_id, email, role, invited_by, expires_at, created_at) values ('8b000000-0000-4000-8000-000000000002', '${workspaces.aResearch}', 'old@example.org', 'member', '${users.erin.app}', now() - interval '1 day', now() - interval '8 days')`,
];

export default scenarios([
  // GET /v2/orgs
  { name: "orgs list: alice", as: "alice", method: "GET", path: O },
  { name: "orgs list: staff member of org A", as: "admin", method: "GET", path: O },
  { name: "orgs list: rita has none", as: "rita", method: "GET", path: O },
  { name: "orgs list: never onboarded", as: "dave", method: "GET", path: O },
  { name: "orgs list: anonymous", as: "anonymous", method: "GET", path: O },

  // POST /v2/orgs
  {
    name: "orgs create: a second org with its default workspace",
    as: "alice",
    method: "POST",
    path: O,
    body: { name: " New\r\nventure " },
  },
  {
    name: "orgs create: an external of a partner org tells staff",
    as: "bob",
    method: "POST",
    path: O,
    body: { name: "Bob's own" },
    setup: [`update org set is_partner = true where id = '${orgs.a}'`],
    differs:
      "staff are found by the Administrator role; the old lookup read admin_access off directus_users, which Directus 11 does not have, so staff were never told",
  },
  {
    name: "orgs create: a name of only line breaks",
    as: "alice",
    method: "POST",
    path: O,
    body: { name: "\n" },
  },
  {
    name: "orgs create: name too long",
    as: "alice",
    method: "POST",
    path: O,
    body: { name: "x".repeat(101) },
  },
  {
    name: "orgs create: never onboarded",
    as: "dave",
    method: "POST",
    path: O,
    body: { name: "Mine" },
  },

  // GET and PATCH /v2/orgs/:id
  { name: "org read: owner", as: "alice", method: "GET", path: orgA },
  { name: "org read: plain member", as: "admin", method: "GET", path: orgA },
  { name: "org read: external is not a member", as: "bob", method: "GET", path: orgA },
  { name: "org read: missing org", as: "alice", method: "GET", path: missingOrg },
  {
    name: "org update: rename, describe and set a logo url",
    as: "erin",
    method: "PATCH",
    path: orgA,
    body: { name: "Org A\nrenamed", description: "  ", logo_url: "https://cdn.example.org/a.png" },
  },
  {
    name: "org update: bad logo url",
    as: "alice",
    method: "PATCH",
    path: orgA,
    body: { logo_url: "data:image/png;base64,AAAA" },
  },
  { name: "org update: nothing to update", as: "alice", method: "PATCH", path: orgA, body: {} },
  { name: "org update: empty name", as: "alice", method: "PATCH", path: orgA, body: { name: "" } },
  {
    name: "org update: member refused",
    as: "admin",
    method: "PATCH",
    path: orgA,
    body: { name: "x" },
  },

  // POST and DELETE /v2/orgs/:id/logo
  {
    name: "org logo upload: without a file",
    as: "alice",
    method: "POST",
    path: `${orgA}/logo`,
    body: {},
  },
  { name: "org logo remove: nothing set", as: "alice", method: "DELETE", path: `${orgA}/logo` },
  {
    name: "org logo remove: external url is cleared, never deleted",
    as: "alice",
    method: "DELETE",
    path: `${orgA}/logo`,
    setup: [`update org set logo_url = 'https://cdn.example.org/a.png' where id = '${orgs.a}'`],
  },
  { name: "org logo remove: member refused", as: "admin", method: "DELETE", path: `${orgA}/logo` },

  // GET /v2/orgs/:id/members
  {
    name: "org members: owner sees emails and the matrix",
    as: "alice",
    method: "GET",
    path: `${orgA}/members`,
  },
  {
    name: "org members: plain member sees a redacted matrix",
    as: "admin",
    method: "GET",
    path: `${orgA}/members`,
  },
  { name: "org members: org B", as: "bob", method: "GET", path: `${orgB}/members` },
  { name: "org members: outsider refused", as: "rita", method: "GET", path: `${orgA}/members` },

  // GET /v2/orgs/:id/pending-invites
  {
    name: "org pending invites: org and workspace invites, newest first",
    as: "alice",
    method: "GET",
    path: `${orgA}/pending-invites`,
    setup: pendingInvites,
  },
  {
    name: "org pending invites: narrowed to one workspace",
    as: "erin",
    method: "GET",
    path: `${orgA}/pending-invites`,
    query: { workspace_id: workspaces.aDefault },
    setup: pendingInvites,
  },
  {
    name: "org pending invites: a workspace of another org",
    as: "alice",
    method: "GET",
    path: `${orgA}/pending-invites`,
    query: { workspace_id: workspaces.bDefault },
    setup: pendingInvites,
  },
  {
    name: "org pending invites: none",
    as: "alice",
    method: "GET",
    path: `${orgA}/pending-invites`,
  },
  {
    name: "org pending invites: member refused",
    as: "admin",
    method: "GET",
    path: `${orgA}/pending-invites`,
  },

  // POST /v2/orgs/:id/invites
  {
    name: "org invite: a new person gets a link",
    as: "alice",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "New.Person@Example.org", role: "admin" },
    // The link's hash is derived from the new invite's id, which each side mints itself.
    ignoreFields: ["invite_url"],
  },
  {
    name: "org invite: an invite is already pending",
    as: "alice",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "new.person@example.org", role: "member" },
    setup: pendingInvites,
  },
  {
    name: "org invite: an onboarded user is added at once",
    as: "erin",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "rita.parity@example.com" },
  },
  {
    name: "org invite: a removed member is re-added",
    as: "alice",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "parity-admin@example.com", role: "billing" },
    setup: [`update org_membership set deleted_at = now() where id = '${orgMem(4)}'`],
  },
  {
    name: "org invite: already a member",
    as: "alice",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "erin.parity@example.com" },
  },
  {
    name: "org invite: a user who never onboarded gets a link",
    as: "alice",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "dave.parity@example.com" },
    ignoreFields: ["invite_url"],
  },
  {
    name: "org invite: an external cannot be made org admin",
    as: "alice",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "bob.parity@example.com", role: "admin" },
    differs: "L-10: an external of the org is refused the admin role, as on role change",
  },
  {
    name: "org invite: admin cannot grant owner",
    as: "erin",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "x@example.org", role: "owner" },
  },
  {
    name: "org invite: yourself",
    as: "alice",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "ALICE.parity@example.com" },
  },
  {
    name: "org invite: bad role",
    as: "alice",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "x@example.org", role: "external" },
  },
  {
    name: "org invite: member refused",
    as: "admin",
    method: "POST",
    path: `${orgA}/invites`,
    body: { email: "x@example.org" },
  },

  // GET /v2/orgs/:id/workspaces
  {
    name: "org workspaces: owner sees all",
    as: "alice",
    method: "GET",
    path: `${orgA}/workspaces`,
  },
  {
    name: "org workspaces: member does not see private ones",
    as: "admin",
    method: "GET",
    path: `${orgA}/workspaces`,
  },
  {
    name: "org workspaces: external guest sees theirs",
    as: "bob",
    method: "GET",
    path: `${orgA}/workspaces`,
  },
  {
    name: "org workspaces: observer guest sees theirs",
    as: "rita",
    method: "GET",
    path: `${orgA}/workspaces`,
  },
  { name: "org workspaces: org B owner", as: "bob", method: "GET", path: `${orgB}/workspaces` },
  { name: "org workspaces: no access", as: "rita", method: "GET", path: `${orgB}/workspaces` },
  {
    name: "org workspaces: pinned projects on the cards",
    as: "alice",
    method: "GET",
    path: `${orgA}/workspaces`,
    setup: [
      "update project set pin_order = 1 where id = 'f0000000-0000-4000-8000-000000000001'",
      "update project set pin_order = 2 where id = 'f0000000-0000-4000-8000-000000000002'",
    ],
  },

  // PATCH /v2/orgs/:id/members/:user_id
  {
    name: "org role: owner makes the member billing",
    as: "alice",
    method: "PATCH",
    path: `${orgA}/members/${users.admin.app}`,
    body: { role: "billing" },
  },
  {
    name: "org role: owner promotes the admin to owner",
    as: "alice",
    method: "PATCH",
    path: `${orgA}/members/${users.erin.app}`,
    body: { role: "owner" },
  },
  {
    name: "org role: admin cannot touch the owner",
    as: "erin",
    method: "PATCH",
    path: `${orgA}/members/${users.alice.app}`,
    body: { role: "member" },
  },
  {
    name: "org role: the last owner cannot step down",
    as: "bob",
    method: "PATCH",
    path: `${orgB}/members/${users.bob.app}`,
    body: { role: "member" },
  },
  {
    name: "org role: an external cannot become admin",
    as: "alice",
    method: "PATCH",
    path: `${orgA}/members/${users.bob.app}`,
    body: { role: "admin" },
    setup: [
      `insert into org_membership (id, org_id, user_id, role, created_at, updated_at) values ('8c000000-0000-4000-8000-000000000001', '${orgs.a}', '${users.bob.app}', 'member', now(), now())`,
    ],
  },
  {
    name: "org role: invalid role",
    as: "alice",
    method: "PATCH",
    path: `${orgA}/members/${users.admin.app}`,
    body: { role: "external" },
  },
  {
    name: "org role: unknown member",
    as: "alice",
    method: "PATCH",
    path: `${orgA}/members/${users.rita.app}`,
    body: { role: "member" },
  },
  {
    name: "org role: member refused",
    as: "admin",
    method: "PATCH",
    path: `${orgA}/members/${users.erin.app}`,
    body: { role: "member" },
  },

  // DELETE /v2/orgs/:id/members/:user_id
  {
    name: "org remove: admin removed with their workspace rows",
    as: "alice",
    method: "DELETE",
    path: `${orgA}/members/${users.erin.app}`,
  },
  {
    name: "org remove: member removed",
    as: "erin",
    method: "DELETE",
    path: `${orgA}/members/${users.admin.app}`,
  },
  {
    name: "org remove: guest loses external rows",
    as: "alice",
    method: "DELETE",
    path: `${orgA}/members/${users.bob.app}`,
  },
  {
    name: "org remove: guest observer loses observer rows",
    as: "alice",
    method: "DELETE",
    path: `${orgA}/members/${users.rita.app}`,
    differs: "L-11: removing a guest from the org also removes their observer rows",
  },
  {
    name: "org remove: admin cannot remove the owner",
    as: "erin",
    method: "DELETE",
    path: `${orgA}/members/${users.alice.app}`,
  },
  {
    name: "org remove: last owner stays",
    as: "bob",
    method: "DELETE",
    path: `${orgB}/members/${users.bob.app}`,
  },
  {
    name: "org remove: unknown person",
    as: "alice",
    method: "DELETE",
    path: `${orgA}/members/${users.dave.directus}`,
  },

  // GET /v2/orgs/:id/usage
  { name: "org usage: owner", as: "alice", method: "GET", path: `${orgA}/usage` },
  {
    name: "org usage: plain member sees only workspaces they reach",
    as: "admin",
    method: "GET",
    path: `${orgA}/usage`,
    differs: "M-9: plain org members no longer see workspaces they cannot reach",
  },
  { name: "org usage: free org", as: "bob", method: "GET", path: `${orgB}/usage` },
  {
    name: "org usage: previous month",
    as: "alice",
    method: "GET",
    path: `${orgA}/usage`,
    query: { month_offset: "2" },
  },
  {
    name: "org usage: month_offset out of range",
    as: "alice",
    method: "GET",
    path: `${orgA}/usage`,
    query: { month_offset: "-1" },
  },
  { name: "org usage: outsider refused", as: "rita", method: "GET", path: `${orgA}/usage` },

  // GET /v2/orgs/:id/projects
  { name: "org projects: owner", as: "alice", method: "GET", path: `${orgA}/projects` },
  { name: "org projects: member refused", as: "admin", method: "GET", path: `${orgA}/projects` },

  // GET /v2/orgs/:id/referral-ledger
  {
    name: "org referral ledger: partner owner reads its terms",
    as: "alice",
    method: "GET",
    path: `${orgA}/referral-ledger`,
    setup: [
      `insert into referral_ledger (workspace_id, partner_team_id, partner_kickback_percent, starts_at, notes) values ('${workspaces.bDefault}', '${orgs.a}', 15, now() - interval '3 days', 'intro deal')`,
    ],
    differs:
      "the old API answered 500 whenever a row existed: the serial id failed its string field",
  },
  {
    name: "org referral ledger: empty",
    as: "erin",
    method: "GET",
    path: `${orgA}/referral-ledger`,
  },
  {
    name: "org referral ledger: member refused",
    as: "admin",
    method: "GET",
    path: `${orgA}/referral-ledger`,
  },
]);
