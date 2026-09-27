import { orgs, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";

const W = "/api/v2/workspaces";
const aDefault = `${W}/${workspaces.aDefault}`;
const aResearch = `${W}/${workspaces.aResearch}`;
const missing = `${W}/c0000000-0000-4000-8000-000000000999`;
const API_ACCESS = "L-26: workspace:api_access was never enforced and is no longer listed";

export default scenarios([
  // GET /v2/workspaces
  { name: "workspaces list: alice (org owner)", as: "alice", method: "GET", path: W },
  { name: "workspaces list: bob (org B owner, external in A)", as: "bob", method: "GET", path: W },
  { name: "workspaces list: erin (org admin)", as: "erin", method: "GET", path: W },
  { name: "workspaces list: rita (observer, no org)", as: "rita", method: "GET", path: W },
  { name: "workspaces list: staff member", as: "admin", method: "GET", path: W },
  { name: "workspaces list: never onboarded is empty", as: "dave", method: "GET", path: W },
  { name: "workspaces list: anonymous", as: "anonymous", method: "GET", path: W },

  // GET /v2/workspaces/tier-capacities (public)
  {
    name: "workspaces tier capacities: anonymous",
    as: "anonymous",
    method: "GET",
    path: `${W}/tier-capacities`,
  },

  // POST /v2/workspaces
  {
    name: "workspaces create: alice in her org by default",
    as: "alice",
    method: "POST",
    path: W,
    body: { name: "  Field work  " },
  },
  {
    name: "workspaces create: erin (org admin) names org A, invite-only on changemaker",
    as: "erin",
    method: "POST",
    path: W,
    body: { name: "Board", org_id: orgs.a, visibility: "invite_only" },
  },
  {
    name: "workspaces create: external client workspace with a data owner",
    as: "alice",
    method: "POST",
    path: W,
    body: {
      name: "Client X",
      data_owner_org_name: "Client X BV",
      data_owner_email: "Owner@ClientX.org",
      partner_agreement_accepted: true,
    },
  },
  {
    name: "workspaces create: data owner without the owning org name",
    as: "alice",
    method: "POST",
    path: W,
    body: { name: "Client Y", data_owner_email: "a@clienty.org", partner_agreement_accepted: true },
  },
  {
    name: "workspaces create: data owner without the partner agreement",
    as: "alice",
    method: "POST",
    path: W,
    body: { name: "Client Y", data_owner_org_name: "Y", data_owner_email: "a@clienty.org" },
  },
  {
    name: "workspaces create: data owner who is already an org member",
    as: "alice",
    method: "POST",
    path: W,
    body: {
      name: "Client Z",
      data_owner_org_name: "Z",
      data_owner_email: "erin.parity@example.com",
      partner_agreement_accepted: true,
    },
  },
  {
    name: "workspaces create: free org already has its one workspace",
    as: "bob",
    method: "POST",
    path: W,
    body: { name: "Second" },
  },
  {
    name: "workspaces create: staff skips the free tier limit in org B",
    as: "admin",
    method: "POST",
    path: W,
    body: { name: "Staff made", org_id: orgs.b },
  },
  {
    name: "workspaces create: bob is not an admin of org A",
    as: "bob",
    method: "POST",
    path: W,
    body: { name: "Intrusion", org_id: orgs.a },
  },
  {
    name: "workspaces create: rita has no org to create in",
    as: "rita",
    method: "POST",
    path: W,
    body: { name: "Mine" },
  },
  {
    name: "workspaces create: never onboarded",
    as: "dave",
    method: "POST",
    path: W,
    body: { name: "Mine" },
  },
  {
    name: "workspaces create: empty name, bad visibility and email fail validation",
    as: "alice",
    method: "POST",
    path: W,
    body: { name: "", visibility: "secret", data_owner_email: "nope" },
  },
  { name: "workspaces create: missing body", as: "alice", method: "POST", path: W },
  {
    name: "workspaces create: anonymous",
    as: "anonymous",
    method: "POST",
    path: W,
    body: { name: "x" },
  },

  // DELETE /v2/workspaces/:id
  {
    name: "workspaces delete: owner blocked while projects remain",
    as: "alice",
    method: "DELETE",
    path: aDefault,
  },
  { name: "workspaces delete: member refused", as: "admin", method: "DELETE", path: aDefault },
  { name: "workspaces delete: observer refused", as: "rita", method: "DELETE", path: aResearch },
  { name: "workspaces delete: other tenant", as: "bob", method: "DELETE", path: aDefault },
  { name: "workspaces delete: missing workspace", as: "alice", method: "DELETE", path: missing },
  {
    name: "workspaces delete: malformed id",
    as: "alice",
    method: "DELETE",
    path: `${W}/not-a-uuid`,
  },
  { name: "workspaces delete: never onboarded", as: "dave", method: "DELETE", path: aDefault },

  // PATCH /v2/workspaces/:id/tier (staff)
  {
    name: "workspaces tier: staff upgrades to guardian",
    as: "admin",
    method: "PATCH",
    path: `${aDefault}/tier`,
    body: { tier: "guardian", reason: "pilot deal" },
  },
  {
    name: "workspaces tier: staff downgrades to free",
    as: "admin",
    method: "PATCH",
    path: `${aDefault}/tier`,
    body: { tier: "free", reason: "lapsed" },
    differs: API_ACCESS,
  },
  {
    name: "workspaces tier: staff downgrades to innovator",
    as: "admin",
    method: "PATCH",
    path: `${aResearch}/tier`,
    body: { tier: "innovator", reason: "smaller plan" },
    differs: API_ACCESS,
  },
  {
    name: "workspaces tier: same tier changes nothing",
    as: "admin",
    method: "PATCH",
    path: `${aDefault}/tier`,
    body: { tier: "changemaker", reason: "check" },
  },
  {
    name: "workspaces tier: legacy pilot is refused",
    as: "admin",
    method: "PATCH",
    path: `${aDefault}/tier`,
    body: { tier: "pilot", reason: "legacy" },
    differs: "L-17: legacy tiers are refused at validation instead of failing with a 500",
  },
  {
    name: "workspaces tier: owner is not staff",
    as: "alice",
    method: "PATCH",
    path: `${aDefault}/tier`,
    body: { tier: "guardian", reason: "self upgrade" },
  },
  {
    name: "workspaces tier: reason is required",
    as: "admin",
    method: "PATCH",
    path: `${aDefault}/tier`,
    body: { tier: "guardian", reason: "" },
  },
  {
    name: "workspaces tier: missing workspace",
    as: "admin",
    method: "PATCH",
    path: `${missing}/tier`,
    body: { tier: "guardian", reason: "x" },
  },

  // GET /v2/workspaces/:id/tier/preview-downgrade
  {
    name: "workspaces preview downgrade: owner to innovator",
    as: "alice",
    method: "GET",
    path: `${aDefault}/tier/preview-downgrade`,
    query: { to_tier: "innovator" },
    differs: API_ACCESS,
  },
  {
    name: "workspaces preview downgrade: an upgrade has no effects",
    as: "alice",
    method: "GET",
    path: `${aDefault}/tier/preview-downgrade`,
    query: { to_tier: "guardian" },
  },
  {
    name: "workspaces preview downgrade: to_tier is required",
    as: "alice",
    method: "GET",
    path: `${aDefault}/tier/preview-downgrade`,
  },
  {
    name: "workspaces preview downgrade: member lacks settings:manage",
    as: "admin",
    method: "GET",
    path: `${aDefault}/tier/preview-downgrade`,
    query: { to_tier: "guardian" },
  },
  {
    name: "workspaces preview downgrade: other tenant",
    as: "bob",
    method: "GET",
    path: `${aDefault}/tier/preview-downgrade`,
    query: { to_tier: "guardian" },
  },

  // GET /v2/workspaces/:id/usage
  { name: "workspaces usage: owner", as: "alice", method: "GET", path: `${aDefault}/usage` },
  {
    name: "workspaces usage: member sees no financials",
    as: "admin",
    method: "GET",
    path: `${aDefault}/usage`,
  },
  {
    name: "workspaces usage: last month",
    as: "alice",
    method: "GET",
    path: `${aDefault}/usage`,
    query: { month_offset: "1", refresh: "true" },
  },
  {
    name: "workspaces usage: free workspace",
    as: "bob",
    method: "GET",
    path: `${W}/${workspaces.bDefault}/usage`,
  },
  {
    name: "workspaces usage: private workspace, owner",
    as: "erin",
    method: "GET",
    path: `${aResearch}/usage`,
  },
  {
    name: "workspaces usage: observer lacks view_usage",
    as: "rita",
    method: "GET",
    path: `${aResearch}/usage`,
  },
  {
    name: "workspaces usage: external lacks view_usage",
    as: "bob",
    method: "GET",
    path: `${aResearch}/usage`,
  },
  {
    name: "workspaces usage: month_offset out of range",
    as: "alice",
    method: "GET",
    path: `${aDefault}/usage`,
    query: { month_offset: "13" },
  },
  {
    name: "workspaces usage: month_offset not a number",
    as: "alice",
    method: "GET",
    path: `${aDefault}/usage`,
    query: { month_offset: "abc" },
  },
  {
    name: "workspaces usage: anonymous",
    as: "anonymous",
    method: "GET",
    path: `${aDefault}/usage`,
  },

  // POST /v2/workspaces/:id/handoff/*
  {
    name: "workspaces handoff initiate: org-pooled workspace cannot be handed off",
    as: "alice",
    method: "POST",
    path: `${aDefault}/handoff/initiate`,
    body: { target_organisation_id: orgs.b },
  },
  {
    name: "workspaces handoff initiate: member is not a billing org admin",
    as: "admin",
    method: "POST",
    path: `${aDefault}/handoff/initiate`,
    body: { target_organisation_id: orgs.b },
  },
  {
    name: "workspaces handoff initiate: target is required",
    as: "alice",
    method: "POST",
    path: `${aDefault}/handoff/initiate`,
    body: {},
  },
  {
    name: "workspaces handoff accept: nothing pending",
    as: "alice",
    method: "POST",
    path: `${aDefault}/handoff/accept`,
  },
  {
    name: "workspaces handoff cancel: nothing pending",
    as: "alice",
    method: "POST",
    path: `${aDefault}/handoff/cancel`,
  },
  {
    name: "workspaces handoff accept: other tenant",
    as: "bob",
    method: "POST",
    path: `${aDefault}/handoff/accept`,
  },
]);
