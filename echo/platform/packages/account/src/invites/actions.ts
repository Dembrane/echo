import { DrizzleAccessStore, resolveWorkspace, roleHas } from "@dembrane/access";
import { BadRequestError, ForbiddenError, NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { sendEmail } from "../jobs";
import { type InviteCtx, onboardedUser } from "./accept";
import { inviteHash, resendAcceptUrl } from "./hash";
import type { InviteStorage, OrgInvite, WorkspaceInvite } from "./storage";

/** Resends are an amplification vector, so tighter than invite creation. */
const RESEND_LIMIT = { name: "invite_resend", capacity: 10, windowSeconds: 3600 };

type Loaded =
  | { type: "workspace"; invite: WorkspaceInvite }
  | { type: "org"; invite: OrgInvite }
  | null;

/** Workspace invites first, the hot path; soft-deleted rows count only when asked for. */
async function load(store: InviteStorage, id: string, includeDeleted: boolean): Promise<Loaded> {
  const ws = await store.workspaceInvite(id, { liveOnly: false });
  if (ws && (includeDeleted || !ws.deleted_at)) return { type: "workspace", invite: ws };
  const org = await store.orgInvite(id, { liveOnly: false });
  if (org && (includeDeleted || !org.deleted_at)) return { type: "org", invite: org };
  return null;
}

/** The org an invite belongs to, still resolved when its workspace was soft-deleted. */
async function orgOf(store: InviteStorage, l: NonNullable<Loaded>): Promise<string | null> {
  if (l.type === "org") return l.invite.org_id;
  return (await store.workspace(l.invite.workspace_id))?.org_id ?? null;
}

/**
 * The inviter while still an org member, or an org admin or owner. A removed member
 * keeps no power over invites they sent.
 */
async function inviterOrOrgAdmin(
  store: InviteStorage,
  orgId: string,
  invitedBy: string | null,
  me: string,
) {
  const rows = await store.orgMemberships(orgId, me, { activeOnly: true });
  const orgAdmin = rows.some((r) => r.role === "admin" || r.role === "owner");
  const inviter = invitedBy === me && (orgAdmin || rows.length > 0);
  return { orgAdmin, inviter };
}

/** Resends the email and pushes the expiry out 7 days. */
export async function resendInvite(ctx: InviteCtx, who: Signed, inviteId: string) {
  const { store, now, deps } = ctx;
  const me = await onboardedUser(store, who);
  const l = await load(store, inviteId, false);
  if (!l) throw new NotFoundError("Invite not found");
  if (l.invite.accepted_at) throw new BadRequestError("Invite has already been accepted");
  const orgId = await orgOf(store, l);
  if (!orgId) throw new NotFoundError("Invite not found");
  const { orgAdmin, inviter } = await inviterOrOrgAdmin(store, orgId, l.invite.invited_by, me.id);
  // Spec L-16: a resend extends the invite, so the inviter must still be allowed to send
  // it: member:invite on the workspace, or org admin for an org invite. An inviter since
  // demoted no longer keeps their old invites alive.
  let stillMayInvite = false;
  if (inviter && l.type === "workspace") {
    const access = await resolveWorkspace(
      new DrizzleAccessStore(deps.db),
      l.invite.workspace_id,
      { appUserId: me.id, directusUserId: who.directusUserId },
      now,
    );
    stillMayInvite = Boolean(access && roleHas(access.role, "member:invite", access.extra));
  }
  if (!(stillMayInvite || orgAdmin))
    throw new ForbiddenError("Only the inviter or an org admin can resend");
  await deps.limiter.check(RESEND_LIMIT, me.id);

  const expires = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  if (l.type === "org") await store.updateOrgInvite(inviteId, { expires_at: expires });
  else await store.updateWorkspaceInvite(inviteId, { expires_at: expires });

  const inviterName = me.display_name || "Your organisation";
  const org = await store.org(orgId);
  const orgName = org?.name || "your organisation";
  const email = l.invite.email.toLowerCase();
  const role = l.invite.role || "member";
  const hash = inviteHash(deps.settings.inviteHashSecret, inviteId);
  const base = { dashboardUrl: deps.settings.dashboardUrl, hash, inviterName, role, email };

  let queued = true;
  try {
    if (l.type === "org") {
      const url = resendAcceptUrl({ ...base, type: "org", subjectName: orgName });
      await deps.jobs.enqueue(sendEmail, {
        to: email,
        subject: `${inviterName} invited you to ${orgName} on dembrane`,
        template: "org_invite",
        data: { inviter_name: inviterName, org_name: orgName, role, invite_url: url },
        context: `resend org_invite / org ${orgId}`,
      });
    } else {
      const ws = await store.workspace(l.invite.workspace_id);
      const wsName = ws?.name || "a workspace";
      const url = resendAcceptUrl({ ...base, type: "workspace", subjectName: wsName });
      await deps.jobs.enqueue(sendEmail, {
        to: email,
        subject: `${inviterName} invited you to collaborate on dembrane`,
        template: "workspace_invite",
        data: { inviter_name: inviterName, workspace_name: wsName, invite_url: url },
        context: `resend workspace_invite / invite ${inviteId}`,
      });
    }
  } catch {
    queued = false;
  }
  return { status: "success", email_sent: queued, type: l.type };
}

/**
 * Soft-deletes a pending invite. The inviter, an org admin or owner, or (workspace invites)
 * a workspace admin or owner may revoke. A second revoke answers already_revoked, after
 * the same permission check, so ids cannot be fingerprinted.
 */
export async function revokeInvite(ctx: InviteCtx, who: Signed, inviteId: string) {
  const { store, now, deps } = ctx;
  const me = await onboardedUser(store, who);
  const l = await load(store, inviteId, true);
  if (!l) throw new NotFoundError("Invite not found");
  if (l.invite.accepted_at) throw new BadRequestError("Invite has already been accepted");
  const orgId = await orgOf(store, l);
  if (!orgId) throw new NotFoundError("Invite not found");
  const { orgAdmin, inviter } = await inviterOrOrgAdmin(store, orgId, l.invite.invited_by, me.id);
  let wsAdmin = false;
  if (l.type === "workspace" && !(inviter || orgAdmin)) {
    const access = await resolveWorkspace(
      new DrizzleAccessStore(deps.db),
      l.invite.workspace_id,
      { appUserId: me.id, directusUserId: who.directusUserId },
      now,
    );
    wsAdmin = access?.role === "admin" || access?.role === "owner";
  }
  if (!(inviter || orgAdmin || wsAdmin))
    throw new ForbiddenError("Only the inviter or a workspace or org admin can revoke");
  if (l.invite.deleted_at) return { status: "already_revoked", type: l.type };
  const patch = { deleted_at: now.toISOString() };
  if (l.type === "org") await store.updateOrgInvite(inviteId, patch);
  else await store.updateWorkspaceInvite(inviteId, patch);
  return { status: "success", type: l.type };
}
