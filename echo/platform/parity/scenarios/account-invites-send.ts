import { billing, id, orgs, projects, users, workspaces } from "../fixtures";
import { scenarios } from "../runner/scenario";

// Sending, estimating, resending and revoking invites. The minted invite id is in the
// accept URL's hash, so invite_url is compared only where the invite id is fixed.

const inv = (k: number) => id("aa", k);
const FUTURE = "'2099-01-01T00:00:00Z'";
const wsPath = (w: string) => `/api/v2/workspaces/${w}`;

const pending = (
  k: number,
  email: string,
  workspace: string,
  opts: { by?: string; project?: string; accepted?: boolean; deleted?: boolean } = {},
) =>
  `insert into workspace_invite (id, workspace_id, email, role, invited_by, expires_at, created_at, project_id, accepted_at, deleted_at) values ('${inv(k)}', '${workspace}', '${email}', 'member', '${opts.by ?? users.alice.app}', ${FUTURE}, '2026-09-01T09:00:00Z', ${opts.project ? `'${opts.project}'` : "null"}, ${opts.accepted ? "'2026-09-02T00:00:00Z'" : "null"}, ${opts.deleted ? "'2026-09-02T00:00:00Z'" : "null"});`;
const orgPending = (k: number, email: string, opts: { by?: string } = {}) =>
  `insert into org_invite (id, org_id, email, role, invited_by, expires_at, created_at) values ('${inv(k)}', '${orgs.a}', '${email}', 'admin', '${opts.by ?? users.alice.app}', ${FUTURE}, '2026-09-01T09:00:00Z');`;

const NEW = "new.person@example.com";

export default scenarios([
  // ── invite ──
  {
    name: "invite: alice invites a new email",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: "New.Person@Example.COM", role: "member" },
    ignoreFields: ["invite_url"],
  },
  {
    name: "invite: inviting the same email again answers already_invited",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: NEW },
    setup: pending(30, NEW, workspaces.aDefault),
  },
  {
    name: "invite: an onboarded user is added at once and joins the org",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: users.rita.email, role: "member" },
  },
  {
    name: "invite: an onboarded user added as external gets no org membership",
    as: "erin",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: users.rita.email, role: "external" },
  },
  {
    name: "invite: a removed member is reactivated",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: users.bob.email, role: "member" },
    setup: `insert into workspace_membership (id, workspace_id, user_id, role, source, created_at, updated_at, deleted_at) values ('${id("e1", 90)}', '${workspaces.aDefault}', '${users.bob.app}', 'member', 'direct', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z');`,
  },
  {
    name: "invite: an active member answers already_member and stale invites are swept",
    as: "erin",
    method: "POST",
    path: `${wsPath(workspaces.aResearch)}/invite`,
    body: { email: users.bob.email, role: "external" },
    setup: pending(31, users.bob.email, workspaces.aResearch, {
      project: projects.p2,
      by: users.erin.app,
    }),
  },
  {
    name: "invite: a private project share rides on a new invite",
    as: "erin",
    method: "POST",
    path: `${wsPath(workspaces.aResearch)}/invite`,
    body: { email: NEW, role: "member", project_id: projects.p2 },
    ignoreFields: ["invite_url"],
  },
  {
    name: "invite: sharing a workspace-visible project is 400",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: NEW, project_id: projects.p1 },
  },
  {
    name: "invite: a project from another workspace is 404",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: NEW, project_id: projects.p2 },
  },
  {
    name: "invite: sharing a project with billing is 400",
    as: "erin",
    method: "POST",
    path: `${wsPath(workspaces.aResearch)}/invite`,
    body: { email: NEW, role: "billing", project_id: projects.p2 },
  },
  {
    name: "invite: a member without project:share cannot attach a project",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aResearch)}/invite`,
    body: { email: NEW, project_id: projects.p2 },
  },
  {
    name: "invite: inviting yourself is 400",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: users.alice.email },
  },
  {
    name: "invite: observers only exist in external-client workspaces",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: NEW, role: "observer" },
  },
  {
    name: "invite: an observer invite in an external-client workspace",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: NEW, role: "observer" },
    setup: `update workspace set usage_context = 'external' where id = '${workspaces.aDefault}';`,
    ignoreFields: ["invite_url"],
  },
  {
    name: "invite: adding an onboarded observer no longer crashes after the write",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: users.rita.email, role: "observer" },
    setup: `update workspace set usage_context = 'external' where id = '${workspaces.aDefault}';`,
    differs:
      "py-observer-500: the old API raised on an unset billing_account after adding an onboarded observer",
  },
  {
    name: "invite: a canceled plan must reactivate before adding a seat",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: NEW },
    setup: `update billing_account set status = 'canceled' where id = '${billing.a}';`,
  },
  {
    name: "invite: a workspace member without member:invite is refused",
    as: "admin",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: NEW },
  },
  {
    name: "invite: an observer cannot invite",
    as: "rita",
    method: "POST",
    path: `${wsPath(workspaces.aResearch)}/invite`,
    body: { email: NEW },
  },
  {
    name: "invite: a bad body from a member without the policy is still 422",
    as: "admin",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: "bad", role: "owner", project_id: 5 },
  },
  {
    name: "invite: validation, missing email",
    as: "alice",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: {},
  },
  {
    name: "invite: no access to the workspace",
    as: "bob",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: NEW },
    differs: "access-404: no access answers 404 so the workspace's existence is not revealed",
  },
  {
    name: "invite: not onboarded",
    as: "dave",
    method: "POST",
    path: `${wsPath(workspaces.aDefault)}/invite`,
    body: { email: NEW },
  },
  {
    name: "invite: unknown workspace is 404",
    as: "alice",
    method: "POST",
    path: `${wsPath(id("c0", 99))}/invite`,
    body: { email: NEW },
  },

  // ── seat estimate ──
  {
    name: "estimate: an unsubscribed account charges nothing",
    as: "alice",
    method: "GET",
    path: `${wsPath(workspaces.aDefault)}/seat-estimate`,
  },
  {
    name: "estimate: only net-new recipients count",
    as: "alice",
    method: "GET",
    path: `${wsPath(workspaces.aDefault)}/seat-estimate`,
    query: { emails: `${users.erin.email}, ${NEW},other@example.com,` },
  },
  {
    name: "estimate: added_seats is validated",
    as: "alice",
    method: "GET",
    path: `${wsPath(workspaces.aDefault)}/seat-estimate`,
    query: { added_seats: "x" },
  },
  {
    name: "estimate: members without member:invite are refused",
    as: "admin",
    method: "GET",
    path: `${wsPath(workspaces.aDefault)}/seat-estimate`,
  },
  {
    name: "estimate: no access",
    as: "rita",
    method: "GET",
    path: `${wsPath(workspaces.aDefault)}/seat-estimate`,
    differs: "access-404: no access answers 404 so the workspace's existence is not revealed",
  },

  // ── resend ──
  {
    name: "resend: the inviter extends a workspace invite",
    as: "alice",
    method: "POST",
    path: `/api/v2/invites/${inv(32)}/resend`,
    setup: pending(32, NEW, workspaces.aDefault),
  },
  {
    name: "resend: an org admin resends someone else's org invite",
    as: "erin",
    method: "POST",
    path: `/api/v2/invites/${inv(33)}/resend`,
    setup: orgPending(33, NEW),
  },
  {
    name: "resend: a non-member of the org is refused",
    as: "bob",
    method: "POST",
    path: `/api/v2/invites/${inv(32)}/resend`,
    setup: pending(32, NEW, workspaces.aDefault),
  },
  {
    name: "resend: an accepted invite is 400",
    as: "alice",
    method: "POST",
    path: `/api/v2/invites/${inv(34)}/resend`,
    setup: pending(34, NEW, workspaces.aDefault, { accepted: true }),
  },
  {
    name: "resend: a revoked invite is 404",
    as: "alice",
    method: "POST",
    path: `/api/v2/invites/${inv(35)}/resend`,
    setup: pending(35, NEW, workspaces.aDefault, { deleted: true }),
  },
  {
    name: "resend: unknown is 404",
    as: "alice",
    method: "POST",
    path: `/api/v2/invites/${inv(98)}/resend`,
  },
  {
    name: "resend: not onboarded",
    as: "dave",
    method: "POST",
    path: `/api/v2/invites/${inv(98)}/resend`,
  },

  // ── revoke ──
  {
    name: "revoke: the inviter revokes",
    as: "alice",
    method: "DELETE",
    path: `/api/v2/invites/${inv(32)}`,
    setup: pending(32, NEW, workspaces.aDefault),
  },
  {
    name: "revoke: an org admin revokes an org invite",
    as: "erin",
    method: "DELETE",
    path: `/api/v2/invites/${inv(33)}`,
    setup: orgPending(33, NEW),
  },
  {
    name: "revoke: a workspace owner revokes an invite someone else sent",
    as: "erin",
    method: "DELETE",
    path: `/api/v2/invites/${inv(36)}`,
    setup: pending(36, NEW, workspaces.aResearch, { by: users.alice.app }),
  },
  {
    name: "revoke: a plain member who did not send it is refused",
    as: "admin",
    method: "DELETE",
    path: `/api/v2/invites/${inv(32)}`,
    setup: pending(32, NEW, workspaces.aDefault),
  },
  {
    name: "revoke: a second revoke answers already_revoked",
    as: "alice",
    method: "DELETE",
    path: `/api/v2/invites/${inv(35)}`,
    setup: pending(35, NEW, workspaces.aDefault, { deleted: true }),
  },
  {
    name: "revoke: an accepted invite is 400",
    as: "alice",
    method: "DELETE",
    path: `/api/v2/invites/${inv(34)}`,
    setup: pending(34, NEW, workspaces.aDefault, { accepted: true }),
  },
  {
    name: "revoke: unknown is 404",
    as: "alice",
    method: "DELETE",
    path: `/api/v2/invites/${inv(98)}`,
  },
  {
    name: "revoke: anonymous",
    as: "anonymous",
    method: "DELETE",
    path: `/api/v2/invites/${inv(98)}`,
  },
]);
