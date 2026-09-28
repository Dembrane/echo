import { roleHas } from "@dembrane/access";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  newId,
  PaymentRequiredError,
} from "@dembrane/core";
import { type Signed, v } from "@dembrane/http";
import type { Context } from "hono";
import type { Jobs } from "../deps";
import { sendEmail } from "../jobs";
import {
  accountBlocksSeatAdd,
  accountForWorkspace,
  estimateSeatAddition,
  requestSeatReconcile,
} from "../seats";
import type { InviteCtx } from "./accept";
import { requirePolicy, workspaceAccess } from "./context";
import { inviteAcceptUrl, inviteHash } from "./hash";
import { grantInviteProjectShare, isOutsider, rank, reconcileOutsider } from "./membership";
import type { WorkspaceRow } from "./storage";

const INVITE_LIMIT = { name: "workspace_invite", capacity: 20, windowSeconds: 3600 };
const INVITE_DAYS = 7;
const ROLES = ["admin", "member", "billing", "external", "observer"] as const;

/**
 * A workspace "for an external client" (partner workspace): the only kind with the free
 * observer role. usage_context is the signal; older rows fall back to a named data owner
 * or a hand-off to another team.
 */
export function isExternalClient(ws: WorkspaceRow): boolean {
  const uc = (ws.usage_context ?? "").trim().toLowerCase();
  if (uc) return uc === "external";
  if ((ws.data_owner_email ?? "").trim()) return true;
  return Boolean(ws.billed_to_team_id) && ws.billed_to_team_id !== ws.org_id;
}

/**
 * The invite dialog's cost preview. `emails` (comma separated) makes the server count only
 * net-new seats; the roster itself is never echoed back.
 */
export async function seatEstimate(ctx: InviteCtx, who: Signed, workspaceId: string, c: Context) {
  const access = await workspaceAccess(ctx.deps.db, who, workspaceId, ctx.now);
  const { query } = await v.validate(c, {
    query: { added_seats: v.withDefault(v.int(), 1), emails: v.optional(v.str()) },
  });
  requirePolicy(access, "member:invite");
  const recipients =
    query.emails !== null
      ? query.emails
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean)
      : null;
  const account = await accountForWorkspace(ctx.deps.db, workspaceId);
  if (!account) {
    return {
      active: false,
      added_seats: recipients !== null ? recipients.length : query.added_seats,
      billing_period: "annual",
      currency: "EUR",
      prorated_now_eur: 0.0,
      recurring_delta_eur: 0.0,
    };
  }
  return estimateSeatAddition(
    ctx.deps.db,
    account.id,
    { added: recipients !== null ? 0 : Math.max(1, query.added_seats), recipients },
    ctx.now,
  );
}

type ShareOutcome = "granted" | "pending" | "pending_other_project" | null;

function response(
  status: string,
  email: string,
  userExisted: boolean,
  emailSent: boolean,
  inviteUrl: string | null,
  projectShare: ShareOutcome,
) {
  return {
    status,
    email,
    user_existed: userExisted,
    email_sent: emailSent,
    invite_url: inviteUrl,
    project_share: projectShare,
  };
}

/** Queues an invite email; false when the queue refused it, which the response reports. */
async function queueEmail(
  jobs: Jobs,
  payload: Parameters<typeof jobs.enqueue<typeof sendEmail>>[1],
) {
  try {
    await jobs.enqueue(sendEmail, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Invites someone to a workspace by email. An onboarded user is added at once (no
 * consent step, as today); anyone else gets a pending invite with a 7-day link that
 * registration and onboarding accept. `role` is the single axis: external and observer
 * are outsiders and never get an org membership.
 */
export async function inviteToWorkspace(
  ctx: InviteCtx,
  who: Signed,
  workspaceId: string,
  c: Context,
) {
  const { store, now, deps } = ctx;
  const access = await workspaceAccess(deps.db, who, workspaceId, now);
  const { body } = await v.validate(c, {
    body: {
      email: v.email(),
      role: v.withDefault(v.literal(ROLES), "member"),
      project_id: v.optional(v.str()),
    },
  });
  requirePolicy(access, "member:invite");
  const me = access.appUserId;
  const ws = (await store.workspace(workspaceId)) as WorkspaceRow;
  const email = body.email.trim().toLowerCase();
  const role = body.role;
  const observer = role === "observer";
  const outsider = isOutsider(role);

  if (observer && !isExternalClient(ws)) {
    throw new BadRequestError("invite.observer_internal_workspace");
  }
  // A paid seat needs an active plan; observers are free and always allowed.
  const account = observer ? null : await accountForWorkspace(deps.db, workspaceId);
  if (!observer && accountBlocksSeatAdd(account) === "reactivate_required")
    throw new PaymentRequiredError("billing.plan_inactive");
  if (rank(role) > rank(access.role)) throw new ForbiddenError("member.role_above_own");

  let shareProject: { id: string } | null = null;
  if (body.project_id) {
    requirePolicy(access, "project:share");
    const p = await store.project(body.project_id);
    if (!p || p.deletedAt || p.workspaceId !== workspaceId)
      throw new NotFoundError("project.not_in_workspace");
    if (p.visibility !== "private") throw new BadRequestError("project.share_needs_private");
    if (!roleHas(role, "project:read"))
      throw new BadRequestError("invite.role_cannot_access_projects", {
        details: {
          code: "role_cannot_access_projects",
          message: "Billing members can't open projects. Give them another role first.",
        },
      });
    shareProject = { id: p.id };
  }

  const inviter = await store.appUser(me);
  if (inviter && (inviter.email ?? "").toLowerCase() === email)
    throw new BadRequestError("invite.self");
  await deps.limiter.check(INVITE_LIMIT, me);

  const wsName = ws.name;
  const inviterName = inviter?.display_name || "Your organisation";
  const existingUser = await store.directusUserByEmail(email);
  const userExisted = existingUser !== null;
  const invitee = existingUser ? await store.appUserByDirectusId(existingUser.id) : null;

  if (invitee) {
    const [row] = await store.workspaceMemberships(workspaceId, invitee.id, { activeOnly: false });
    if (row && !row.deleted_at) {
      // Re-inviting an active member changes nothing except sweeping their stale invites.
      try {
        for (const inv of await store.openWorkspaceInvitesFor(workspaceId, email)) {
          await grantInviteProjectShare(store, inv, invitee.id, now, deps.logger);
          await store.updateWorkspaceInvite(inv.id, { accepted_at: now.toISOString() });
        }
      } catch (err) {
        deps.logger?.error({ err, workspaceId }, "already_member: stale invite cleanup failed");
      }
      if (shareProject) await store.upsertProjectShare(shareProject.id, invitee.id, me, now);
      return response("already_member", email, true, false, null, shareProject ? "granted" : null);
    }

    let newlyJoinedOrg = false;
    if (!outsider && ws.org_id) {
      const orgRows = await store.orgMemberships(ws.org_id, invitee.id, { activeOnly: true });
      if (!orgRows.length)
        newlyJoinedOrg = await store.createMembership(
          "org",
          { orgId: ws.org_id, userId: invitee.id, role: "member" },
          now,
        );
    }
    if (outsider && ws.org_id) await reconcileOutsider(store, ws.org_id, invitee.id, now);

    let reactivated = false;
    if (row?.deleted_at) {
      reactivated = await store.updateMembership(
        "workspace",
        row.id,
        { deleted_at: null, role, source: "direct" },
        now,
      );
    } else {
      await store.createMembership(
        "workspace",
        { workspaceId, userId: invitee.id, role, source: "direct" },
        now,
      );
    }
    if (shareProject) await store.upsertProjectShare(shareProject.id, invitee.id, me, now);
    // Observers take no seat, so there is nothing to reconcile for them.
    if (account) await requestSeatReconcile(deps.db, deps.jobs, workspaceId, deps.logger);

    await deps.notifier.emit({
      audienceUserId: invitee.id,
      actorUserId: me,
      eventCode: "WORKSPACE_ADDED",
      title: `You're in ${wsName ?? "a workspace"}`,
      message: `You were added to **${wsName ?? ""}** as ${role}.`,
      action: "NAVIGATE_WS",
      refWorkspaceId: workspaceId,
      refOrgId: ws.org_id,
    });
    if (newlyJoinedOrg && ws.org_id) {
      const admins = await ctx.audiences.organisationAdmins(ws.org_id);
      const org = await store.org(ws.org_id);
      await deps.notifier.emitToAudience(admins, {
        actorUserId: me,
        eventCode: "ORGANISATION_MEMBER_ADDED",
        title: `${invitee.display_name || email || "A new member"} joined ${org?.name || "the organisation"}`,
        message: "They're now a organisation member.",
        action: "NAVIGATE_ORGANISATION_SETTINGS",
        refOrgId: ws.org_id,
      });
    }
    if (outsider) {
      const admins = (await ctx.audiences.workspaceAdmins(workspaceId)).filter(
        (a) => a !== me && a !== invitee.id,
      );
      const name = wsName ?? "your workspace";
      await deps.notifier.emitToAudience(admins, {
        actorUserId: me,
        eventCode: "WORKSPACE_GUEST_ADDED",
        title: observer
          ? `${invitee.display_name || email || "An observer"} joined ${name} as an observer`
          : `${invitee.display_name || email || "An external"} joined ${name} as an external`,
        message: observer
          ? `${email} now has free, read-only observer access. Observers don't count against your seat cap.`
          : `${email} now has external access. Externals count against your tier's seat cap.`,
        action: "NAVIGATE_WORKSPACE_SETTINGS",
        refWorkspaceId: workspaceId,
        refOrgId: ws.org_id,
      });
    }
    const sent = await queueEmail(deps.jobs, {
      to: email,
      subject: `You've been added to ${wsName ?? "a workspace"}`,
      template: "workspace_added",
      data: {
        inviter_name: inviterName,
        workspace_name: wsName ?? "a workspace",
        invite_url: `${deps.settings.dashboardUrl}/w/${workspaceId}/projects`,
      },
      context: `workspace_added / workspace ${workspaceId}`,
    });
    return response(
      reactivated ? "reactivated" : "added",
      email,
      true,
      sent,
      null,
      shareProject ? "granted" : null,
    );
  }

  const existing = await store.pendingWorkspaceInviteFor(workspaceId, email, now);
  const secret = deps.settings.inviteHashSecret;
  const url = (id: string) =>
    inviteAcceptUrl({
      type: "workspace",
      dashboardUrl: deps.settings.dashboardUrl,
      hash: inviteHash(secret, id),
      inviterName,
      subjectName: wsName ?? "",
      role,
      email,
    });

  if (existing) {
    let pending: ShareOutcome = null;
    if (shareProject) {
      // One invite carries one project: never take over a pending share for another project.
      if (existing.project_id === null || existing.project_id === shareProject.id) {
        if (existing.project_id === null)
          await store.updateWorkspaceInvite(existing.id, { project_id: shareProject.id });
        pending = "pending";
      } else pending = "pending_other_project";
    }
    return response("already_invited", email, userExisted, false, url(existing.id), pending);
  }

  const inviteId = newId();
  await store.insertWorkspaceInvite({
    id: inviteId,
    workspace_id: workspaceId,
    email,
    role,
    invited_by: me,
    expires_at: new Date(now.getTime() + INVITE_DAYS * 86_400_000).toISOString(),
    created_at: now.toISOString(),
    ...(shareProject && { project_id: shareProject.id }),
  });
  const inviteUrl = url(inviteId);
  const sent = await queueEmail(deps.jobs, {
    to: email,
    subject: `${inviterName} invited you to collaborate on dembrane`,
    template: "workspace_invite",
    data: {
      inviter_name: inviterName,
      workspace_name: wsName ?? "a workspace",
      invite_url: inviteUrl,
    },
    context: `workspace_invite / workspace ${workspaceId}`,
  });
  return response("invited", email, userExisted, sent, inviteUrl, shareProject ? "pending" : null);
}
