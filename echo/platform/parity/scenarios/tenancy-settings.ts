import { id, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";

const W = "/api/v2/workspaces";
const aDefault = `${W}/${workspaces.aDefault}`;
const aResearch = `${W}/${workspaces.aResearch}`;
const bDefault = `${W}/${workspaces.bDefault}`;
const missing = `${W}/c0000000-0000-4000-8000-000000000999`;
// Seeded workspace memberships, in seed order.
const m = (n: number) => id("e1", n);
const aliceOwnsDefault = m(1);
const erinAdminsDefault = m(2);
const staffMemberOfDefault = m(3);
const erinOwnsResearch = m(4);
const aliceInResearch = m(5);
const bobExternalInResearch = m(6);
const ritaObservesResearch = m(7);
const API_ACCESS = "L-26: workspace:api_access was never enforced and is no longer listed";
const H12 = "H-12: only an owner may demote or remove an owner";

export default scenarios([
  // GET /v2/workspaces/:id/settings
  {
    name: "settings read: owner sees emails and invites",
    as: "alice",
    method: "GET",
    path: `${aDefault}/settings`,
    differs: API_ACCESS,
  },
  {
    name: "settings read: admin",
    as: "erin",
    method: "GET",
    path: `${aDefault}/settings`,
    differs: API_ACCESS,
  },
  {
    name: "settings read: member sees no other emails",
    as: "admin",
    method: "GET",
    path: `${aDefault}/settings`,
  },
  {
    name: "settings read: observer",
    as: "rita",
    method: "GET",
    path: `${aResearch}/settings`,
  },
  {
    name: "settings read: external",
    as: "bob",
    method: "GET",
    path: `${aResearch}/settings`,
  },
  {
    name: "settings read: private workspace, org owner is a plain member",
    as: "alice",
    method: "GET",
    path: `${aResearch}/settings`,
  },
  { name: "settings read: other tenant", as: "bob", method: "GET", path: `${aDefault}/settings` },
  {
    name: "settings read: missing workspace",
    as: "alice",
    method: "GET",
    path: `${missing}/settings`,
  },
  {
    name: "settings read: never onboarded",
    as: "dave",
    method: "GET",
    path: `${aDefault}/settings`,
  },
  {
    name: "settings read: anonymous",
    as: "anonymous",
    method: "GET",
    path: `${aDefault}/settings`,
  },

  // PATCH /v2/workspaces/:id/settings
  {
    name: "settings update: name, description and context",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { name: " Main\nroom ", description: "  Our team  ", context: "   " },
  },
  {
    name: "settings update: whitelabel logo url on changemaker",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { logo_url: "https://cdn.example.org/logo.png" },
  },
  {
    name: "settings update: logo url must be http(s)",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { logo_url: "javascript:alert(1)" },
  },
  {
    name: "settings update: make private on changemaker",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { visibility: "private" },
  },
  {
    name: "settings update: private needs innovator on a free workspace",
    as: "bob",
    method: "PATCH",
    path: `${bDefault}/settings`,
    body: { visibility: "invite_only" },
  },
  {
    name: "settings update: turn support access on",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { allow_support_access: true },
  },
  {
    name: "settings update: support access already off changes nothing but the row",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { allow_support_access: false },
  },
  {
    name: "settings update: consent needs a privacy link",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { legal_basis: "consent" },
  },
  {
    name: "settings update: consent with a privacy link",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { legal_basis: "consent", privacy_policy_url: " https://example.org/privacy " },
  },
  {
    name: "settings update: explicit null clears the legal basis",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { legal_basis: null },
  },
  {
    name: "settings update: dembrane-events is for dembrane accounts",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { legal_basis: "dembrane-events" },
  },
  {
    name: "settings update: unknown legal basis",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { legal_basis: "vibes" },
  },
  {
    name: "settings update: nothing to update",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { inherit_organisation_members: true },
  },
  {
    name: "settings update: member lacks settings:manage",
    as: "admin",
    method: "PATCH",
    path: `${aDefault}/settings`,
    body: { name: "x" },
  },
  {
    name: "settings update: observer lacks settings:manage",
    as: "rita",
    method: "PATCH",
    path: `${aResearch}/settings`,
    body: { name: "x" },
  },

  // PATCH /v2/workspaces/:id/data-ownership
  {
    name: "data ownership: free workspace becomes an external client",
    as: "bob",
    method: "PATCH",
    path: `${bDefault}/data-ownership`,
    body: {
      usage_context: "external",
      data_owner_org_name: "Client Q",
      data_owner_email: " Rep@ClientQ.org ",
      partner_agreement_accepted: true,
    },
  },
  {
    name: "data ownership: paid pooled billing blocks the flip",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/data-ownership`,
    body: {
      usage_context: "external",
      data_owner_org_name: "Client Q",
      data_owner_email: "rep@clientq.org",
      partner_agreement_accepted: true,
    },
  },
  {
    name: "data ownership: external needs an owner email and org",
    as: "bob",
    method: "PATCH",
    path: `${bDefault}/data-ownership`,
    body: { usage_context: "external" },
  },
  {
    name: "data ownership: external needs the partner agreement",
    as: "bob",
    method: "PATCH",
    path: `${bDefault}/data-ownership`,
    body: { usage_context: "external", data_owner_org_name: "Q", data_owner_email: "q@q.org" },
  },
  {
    name: "data ownership: internal stays internal and clears owner fields",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/data-ownership`,
    body: { usage_context: "internal" },
  },
  {
    name: "data ownership: member lacks settings:manage",
    as: "admin",
    method: "PATCH",
    path: `${aDefault}/data-ownership`,
    body: { usage_context: "internal" },
  },

  // POST and DELETE /v2/workspaces/:id/logo
  {
    name: "logo upload: a request without a file",
    as: "alice",
    method: "POST",
    path: `${aDefault}/logo`,
    body: {},
  },
  {
    name: "logo upload: other tenant is stopped before the file",
    as: "bob",
    method: "POST",
    path: `${aDefault}/logo`,
    body: {},
  },
  {
    name: "logo remove: nothing to remove",
    as: "alice",
    method: "DELETE",
    path: `${aDefault}/logo`,
  },
  { name: "logo remove: member refused", as: "admin", method: "DELETE", path: `${aDefault}/logo` },

  // DELETE /v2/workspaces/:id/members/:membership_id
  {
    name: "members remove: owner removes a member who keeps an org role",
    as: "alice",
    method: "DELETE",
    path: `${aDefault}/members/${staffMemberOfDefault}`,
  },
  {
    name: "members remove: owner removes an admin while another manager remains",
    as: "alice",
    method: "DELETE",
    path: `${aDefault}/members/${erinAdminsDefault}`,
  },
  {
    name: "members remove: admin removes the owner",
    as: "erin",
    method: "DELETE",
    path: `${aDefault}/members/${aliceOwnsDefault}`,
    differs: H12,
  },
  {
    name: "members remove: member leaves",
    as: "admin",
    method: "DELETE",
    path: `${aDefault}/members/${staffMemberOfDefault}`,
  },
  {
    name: "members remove: observer leaves",
    as: "rita",
    method: "DELETE",
    path: `${aResearch}/members/${ritaObservesResearch}`,
  },
  {
    name: "members remove: last owner cannot leave",
    as: "erin",
    method: "DELETE",
    path: `${aResearch}/members/${erinOwnsResearch}`,
  },
  {
    name: "members remove: owner removes an external",
    as: "erin",
    method: "DELETE",
    path: `${aResearch}/members/${bobExternalInResearch}`,
  },
  {
    name: "members remove: member cannot remove others",
    as: "alice",
    method: "DELETE",
    path: `${aResearch}/members/${ritaObservesResearch}`,
  },
  {
    name: "members remove: membership of another workspace",
    as: "alice",
    method: "DELETE",
    path: `${aDefault}/members/${aliceInResearch}`,
  },
  {
    name: "members remove: unknown membership",
    as: "alice",
    method: "DELETE",
    path: `${aDefault}/members/${m(99)}`,
  },

  // PATCH /v2/workspaces/:id/members/:membership_id
  {
    name: "members role: owner makes a member billing",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/members/${staffMemberOfDefault}`,
    body: { role: "billing" },
  },
  {
    name: "members role: owner promotes the admin to owner",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/members/${erinAdminsDefault}`,
    body: { role: "owner" },
  },
  {
    name: "members role: admin demotes the owner",
    as: "erin",
    method: "PATCH",
    path: `${aDefault}/members/${aliceOwnsDefault}`,
    body: { role: "admin" },
    differs: H12,
  },
  {
    name: "members role: admin cannot grant owner",
    as: "erin",
    method: "PATCH",
    path: `${aDefault}/members/${staffMemberOfDefault}`,
    body: { role: "owner" },
  },
  {
    name: "members role: an external cannot become a member here",
    as: "erin",
    method: "PATCH",
    path: `${aResearch}/members/${bobExternalInResearch}`,
    body: { role: "member" },
  },
  {
    name: "members role: last owner cannot step down",
    as: "erin",
    method: "PATCH",
    path: `${aResearch}/members/${erinOwnsResearch}`,
    body: { role: "admin" },
  },
  {
    name: "members role: invalid role",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/members/${staffMemberOfDefault}`,
    body: { role: "superuser" },
  },
  {
    name: "members role: role is required",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/members/${staffMemberOfDefault}`,
    body: {},
  },
  {
    name: "members role: member lacks member:manage",
    as: "admin",
    method: "PATCH",
    path: `${aDefault}/members/${erinAdminsDefault}`,
    body: { role: "member" },
  },

  // GET and POST /v2/workspaces/:id/projects
  { name: "projects list: owner", as: "alice", method: "GET", path: `${aDefault}/projects` },
  { name: "projects list: member", as: "admin", method: "GET", path: `${aDefault}/projects` },
  {
    name: "projects list: private project hidden from a member without a share",
    as: "alice",
    method: "GET",
    path: `${aResearch}/projects`,
  },
  {
    name: "projects list: workspace owner sees the private project",
    as: "erin",
    method: "GET",
    path: `${aResearch}/projects`,
  },
  { name: "projects list: observer", as: "rita", method: "GET", path: `${aResearch}/projects` },
  {
    name: "projects list: search by words in any order",
    as: "alice",
    method: "GET",
    path: `${aDefault}/projects`,
    query: { search: "listening CITY" },
  },
  {
    name: "projects list: search with no match",
    as: "alice",
    method: "GET",
    path: `${aDefault}/projects`,
    query: { search: "zzz" },
  },
  {
    name: "projects list: second page",
    as: "alice",
    method: "GET",
    path: `${aDefault}/projects`,
    query: { offset: "1", limit: "1" },
  },
  {
    name: "projects list: limit out of range",
    as: "alice",
    method: "GET",
    path: `${aDefault}/projects`,
    query: { limit: "500" },
  },
  { name: "projects list: other tenant", as: "bob", method: "GET", path: `${aDefault}/projects` },
  {
    name: "projects create: owner with defaults",
    as: "alice",
    method: "POST",
    path: `${aDefault}/projects`,
    body: {},
  },
  {
    name: "projects create: member names it",
    as: "admin",
    method: "POST",
    path: `${aDefault}/projects`,
    body: { name: "Survey", language: "nl" },
  },
  {
    name: "projects create: observer lacks project:create",
    as: "rita",
    method: "POST",
    path: `${aResearch}/projects`,
    body: { name: "x" },
  },
  {
    name: "projects create: external lacks project:create",
    as: "bob",
    method: "POST",
    path: `${aResearch}/projects`,
    body: { name: "x" },
  },
  {
    name: "projects create: name must be a string",
    as: "alice",
    method: "POST",
    path: `${aDefault}/projects`,
    body: { name: 7 },
  },
]);
