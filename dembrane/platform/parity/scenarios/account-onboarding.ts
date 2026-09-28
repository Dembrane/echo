import { id, orgs, users, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";

const inv = (k: number) => id("aa", k);
const FUTURE = "'2099-01-01T00:00:00Z'";

// Dave never onboarded: no app_user, one legacy project. Rita is an observer with no org.
const daveInvite = `insert into workspace_invite (id, workspace_id, email, role, invited_by, expires_at, created_at) values ('${inv(20)}', '${workspaces.aDefault}', '${users.dave.email}', 'member', '${users.alice.app}', ${FUTURE}, '2026-09-01T09:00:00Z');`;
const daveOrgInvite = `insert into org_invite (id, org_id, email, role, invited_by, expires_at, created_at) values ('${inv(21)}', '${orgs.b}', '${users.dave.email}', 'admin', '${users.bob.app}', ${FUTURE}, '2026-09-01T09:01:00Z');`;
const daveExternal = `insert into workspace_invite (id, workspace_id, email, role, invited_by, expires_at, created_at) values ('${inv(22)}', '${workspaces.aResearch}', '${users.dave.email}', 'external', '${users.erin.app}', ${FUTURE}, '2026-09-01T09:02:00Z');`;
// Dave without his legacy project, so only invites decide whether he gets an org.
const noLegacy = "update project set directus_user_id = null where workspace_id is null;";

const complete = "/api/v2/onboarding/complete";
const answers = "/api/v2/onboarding/answers";

export default scenarios([
  {
    name: "onboarding: dave with a legacy project gets a personal org and the project moves",
    as: "dave",
    method: "POST",
    path: complete,
    body: { org_name: "  Dave's Org " },
  },
  {
    name: "onboarding: dave accepts a pending invite and still gets his org for the legacy project",
    as: "dave",
    method: "POST",
    path: complete,
    body: { org_name: "Dave's Org" },
    setup: daveInvite,
  },
  {
    name: "onboarding: an invited user without projects joins the inviter's org only",
    as: "dave",
    method: "POST",
    path: complete,
    body: { org_name: "Dave's Org" },
    setup: `${noLegacy}\n${daveInvite}\n${daveOrgInvite}`,
  },
  {
    name: "onboarding: an external invite joins as a guest, no org of their own",
    as: "dave",
    method: "POST",
    path: complete,
    body: { org_name: "Dave's Org" },
    setup: `${noLegacy}\n${daveExternal}`,
  },
  {
    name: "onboarding: a new user with nothing gets a personal org",
    as: "dave",
    method: "POST",
    path: complete,
    body: { org_name: "Fresh" },
    setup: noLegacy,
  },
  {
    name: "onboarding: an owner running it again changes nothing",
    as: "alice",
    method: "POST",
    path: complete,
    body: { org_name: "Again" },
  },
  {
    name: "onboarding: rita (no org) gets one",
    as: "rita",
    method: "POST",
    path: complete,
    body: { org_name: "Rita Org" },
  },
  {
    name: "onboarding: a blank org name is 400",
    as: "dave",
    method: "POST",
    path: complete,
    body: { org_name: "   " },
  },
  {
    name: "onboarding: org name is validated",
    as: "dave",
    method: "POST",
    path: complete,
    body: { org_name: "" },
  },
  {
    name: "onboarding: anonymous",
    as: "anonymous",
    method: "POST",
    path: complete,
    body: { org_name: "x" },
  },

  {
    name: "onboarding: answers needing follow-up are stored and staff are told",
    as: "alice",
    method: "POST",
    path: answers,
    body: { version: "17-jun-26", data: [{ q1: "with clients" }, { q2: "Yes" }, { q3: "no" }] },
    differs:
      "py-staff-audience: the old audience read users.admin_access, which Directus 11 no longer returns, so staff never got the inbox row",
  },
  {
    name: "onboarding: plain answers are stored without follow-up",
    as: "erin",
    method: "POST",
    path: answers,
    body: { data: [{ q1: "internal" }, { q2: "no" }] },
  },
  {
    name: "onboarding: a skip is stored and never followed up",
    as: "alice",
    method: "POST",
    path: answers,
    body: { skipped: true, data: [{ q2: "yes" }] },
  },
  {
    name: "onboarding: answers are validated",
    as: "alice",
    method: "POST",
    path: answers,
    body: { data: [1], skipped: "x", version: 5 },
  },
  {
    name: "onboarding: answers, not onboarded",
    as: "dave",
    method: "POST",
    path: answers,
    body: {},
  },
]);
