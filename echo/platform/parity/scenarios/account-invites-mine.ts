import { createHmac } from "node:crypto";
import { id, orgs, projects, users, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";

// Invites addressed to the signed-in user: list, accept by id, decline, the email-link
// hash flows, and PATCH /api/v2/me. Invite rows come from setup SQL (the seed has none).

const inv = (k: number) => id("aa", k);
const FUTURE = "'2099-01-01T00:00:00Z'";
const PAST = "'2026-01-01T00:00:00Z'";
const at = (min: number) => `'2026-09-01T09:${String(min).padStart(2, "0")}:00Z'`;

/** The link hash: HMAC-SHA256(invite id) under Directus's secret, 32 hex characters. */
export const hash = (inviteId: string) =>
  createHmac("sha256", process.env.DIRECTUS_SECRET ?? "")
    .update(inviteId)
    .digest("hex")
    .slice(0, 32);

const ws = (
  k: number,
  email: string,
  workspace: string,
  role: string,
  opts: {
    expires?: string;
    accepted?: string;
    deleted?: string;
    project?: string;
    by?: string;
  } = {},
) =>
  `insert into workspace_invite (id, workspace_id, email, role, invited_by, expires_at, created_at, accepted_at, deleted_at, project_id) values ('${inv(k)}', '${workspace}', '${email}', '${role}', '${opts.by ?? users.alice.app}', ${opts.expires ?? FUTURE}, ${at(k)}, ${opts.accepted ?? "null"}, ${opts.deleted ?? "null"}, ${opts.project ? `'${opts.project}'` : "null"});`;

const org = (
  k: number,
  email: string,
  orgId: string,
  role: string,
  opts: { expires?: string; accepted?: string; deleted?: string; by?: string } = {},
) =>
  `insert into org_invite (id, org_id, email, role, invited_by, expires_at, created_at, accepted_at, deleted_at) values ('${inv(k)}', '${orgId}', '${email}', '${role}', '${opts.by ?? users.alice.app}', ${opts.expires ?? FUTURE}, ${at(k)}, ${opts.accepted ?? "null"}, ${opts.deleted ?? "null"});`;

const rita = users.rita.email;
const bob = users.bob.email;

// Rita's inbox: a pending member invite to org A's default workspace, a pending org
// invite to org A, and rows that must not show (expired, revoked, accepted).
const ritaInbox = [
  ws(1, rita, workspaces.aDefault, "member"),
  org(2, rita, orgs.a, "member", { by: users.erin.app }),
  ws(3, rita, workspaces.aDefault, "member", { expires: PAST }),
  ws(4, rita, workspaces.aDefault, "member", { deleted: at(30) }),
  ws(5, rita, workspaces.aDefault, "member", { accepted: at(31) }),
].join("\n");

const me = "/api/v2/me";

export default scenarios([
  // ── PATCH /api/v2/me ──
  {
    name: "account: patch me sets a cleaned display name",
    as: "alice",
    method: "PATCH",
    path: me,
    body: { display_name: "  Alice\nNew  " },
  },
  {
    name: "account: patch me merges settings keys",
    as: "alice",
    method: "PATCH",
    path: me,
    body: { settings: { theme: "dark" } },
    setup: `update app_user set settings = '{"lang": "nl", "theme": "light"}' where id = '${users.alice.app}';`,
  },
  {
    name: "account: patch me with nothing is 400",
    as: "alice",
    method: "PATCH",
    path: me,
    body: {},
  },
  {
    name: "account: patch me validates the name",
    as: "alice",
    method: "PATCH",
    path: me,
    body: { display_name: "", settings: [1] },
  },
  {
    name: "account: patch me, not onboarded",
    as: "dave",
    method: "PATCH",
    path: me,
    body: { display_name: "Dave" },
  },
  { name: "account: patch me, anonymous", as: "anonymous", method: "PATCH", path: me, body: {} },

  // ── GET /api/v2/me/invites ──
  {
    name: "account: rita lists her pending invites",
    as: "rita",
    method: "GET",
    path: `${me}/invites`,
    setup: ritaInbox,
  },
  {
    name: "account: no invites for bob",
    as: "bob",
    method: "GET",
    path: `${me}/invites`,
    setup: ritaInbox,
  },
  {
    name: "account: invites, not onboarded is empty",
    as: "dave",
    method: "GET",
    path: `${me}/invites`,
  },

  // ── accept by id ──
  {
    name: "account: rita accepts a workspace invite and the org invite is swept",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(1)}/accept`,
    setup: ritaInbox,
  },
  {
    name: "account: rita accepts the org invite and the workspace invite is swept",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(2)}/accept`,
    setup: ritaInbox,
  },
  {
    name: "account: bob accepts a member invite and joins org A",
    as: "bob",
    method: "POST",
    path: `${me}/invites/${inv(6)}/accept`,
    setup: ws(6, bob, workspaces.aDefault, "member"),
  },
  {
    name: "account: an external invite leaves no org membership and tells workspace admins",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(7)}/accept`,
    setup: ws(7, rita, workspaces.aDefault, "external"),
  },
  {
    name: "account: an invite carrying a private project share grants it",
    as: "bob",
    method: "POST",
    path: `${me}/invites/${inv(8)}/accept`,
    setup: ws(8, bob, workspaces.aResearch, "member", { project: projects.p2, by: users.erin.app }),
  },
  {
    name: "account: an invite for someone else is 403",
    as: "bob",
    method: "POST",
    path: `${me}/invites/${inv(1)}/accept`,
    setup: ritaInbox,
  },
  {
    name: "account: an accepted invite is 400",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(5)}/accept`,
    setup: ritaInbox,
  },
  {
    name: "account: an expired invite is 400",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(3)}/accept`,
    setup: ritaInbox,
  },
  {
    name: "account: a revoked invite is 404",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(4)}/accept`,
    setup: ritaInbox,
  },
  {
    name: "account: an unknown invite is 404",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(99)}/accept`,
  },
  {
    name: "account: accept, not onboarded",
    as: "dave",
    method: "POST",
    path: `${me}/invites/${inv(1)}/accept`,
  },
  {
    name: "account: an expired org invite is 400",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(9)}/accept`,
    setup: org(9, rita, orgs.a, "member", { expires: PAST }),
  },

  // ── decline ──
  {
    name: "account: rita declines a workspace invite",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(1)}/decline`,
    setup: ritaInbox,
  },
  {
    name: "account: rita declines an org invite",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(2)}/decline`,
    setup: ritaInbox,
  },
  {
    name: "account: declining someone else's invite is 403",
    as: "bob",
    method: "POST",
    path: `${me}/invites/${inv(1)}/decline`,
    setup: ritaInbox,
  },
  {
    name: "account: declining a revoked invite is 404",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(4)}/decline`,
    setup: ritaInbox,
  },
  {
    name: "account: declining an accepted invite is 400",
    as: "rita",
    method: "POST",
    path: `${me}/invites/${inv(5)}/decline`,
    setup: ritaInbox,
  },

  // ── by hash ──
  {
    name: "account: inspect a pending workspace link",
    as: "rita",
    method: "GET",
    path: `${me}/invites/by-hash`,
    query: { h: hash(inv(1)) },
    setup: ritaInbox,
  },
  {
    name: "account: inspect an org link",
    as: "rita",
    method: "GET",
    path: `${me}/invites/by-hash`,
    query: { h: hash(inv(2)) },
    setup: ritaInbox,
  },
  {
    name: "account: inspect an expired link",
    as: "rita",
    method: "GET",
    path: `${me}/invites/by-hash`,
    query: { h: hash(inv(3)) },
    setup: ritaInbox,
  },
  {
    name: "account: inspect an accepted link",
    as: "rita",
    method: "GET",
    path: `${me}/invites/by-hash`,
    query: { h: hash(inv(5)) },
    setup: ritaInbox,
  },
  {
    name: "account: a revoked link reads as not found",
    as: "rita",
    method: "GET",
    path: `${me}/invites/by-hash`,
    query: { h: hash(inv(4)) },
    setup: ritaInbox,
  },
  {
    name: "account: someone else's link reads as not found",
    as: "bob",
    method: "GET",
    path: `${me}/invites/by-hash`,
    query: { h: hash(inv(1)) },
    setup: ritaInbox,
  },
  {
    name: "account: inspect needs h",
    as: "rita",
    method: "GET",
    path: `${me}/invites/by-hash`,
  },
  {
    name: "account: accept a workspace link",
    as: "rita",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { hash: hash(inv(1)) },
    setup: ritaInbox,
  },
  {
    name: "account: accept an org link",
    as: "rita",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { hash: hash(inv(2)), claimed_role: "member" },
    setup: ritaInbox,
  },
  {
    name: "account: a link claiming a higher role is the honeypot",
    as: "rita",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { hash: hash(inv(1)), claimed_role: "admin" },
    setup: ritaInbox,
  },
  {
    name: "account: an org link claiming a higher role is the honeypot",
    as: "rita",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { hash: hash(inv(2)), claimed_role: "owner" },
    setup: ritaInbox,
  },
  {
    name: "account: an accepted link without its membership heals",
    as: "rita",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { hash: hash(inv(5)) },
    setup: ritaInbox,
  },
  {
    name: "account: an accepted link of a member answers already_member",
    as: "bob",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { hash: hash(inv(10)) },
    setup: ws(10, bob, workspaces.aResearch, "external", { accepted: at(40) }),
  },
  {
    name: "account: an accepted org link heals the org membership",
    as: "rita",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { hash: hash(inv(11)) },
    setup: org(11, rita, orgs.a, "admin", { accepted: at(41) }),
  },
  {
    name: "account: an expired, never accepted link no longer heals",
    as: "rita",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { hash: hash(inv(3)) },
    setup: ritaInbox,
    differs:
      "heal-expired: the old heal path turned an expired, never-accepted invite into a membership",
  },
  {
    name: "account: an unknown link is 404",
    as: "rita",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { hash: "0".repeat(32) },
  },
  {
    name: "account: accept-by-hash validates the body",
    as: "rita",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { claimed_role: 5 },
  },
  {
    name: "account: accept-by-hash, not onboarded",
    as: "dave",
    method: "POST",
    path: `${me}/invites/accept-by-hash`,
    body: { hash: "x" },
  },
]);
