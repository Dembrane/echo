import { BadRequestError, NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { type InviteCtx, notifyWorkspaceJoin, onboardedUser } from "./invites/accept";
import { grantInviteProjectShare, isOutsider } from "./invites/membership";
import { sendEmail } from "./jobs";
import { requestSeatReconcile } from "./seats";
import { accountStorage } from "./storage";

const ONBOARDING_LIMIT = { name: "onboarding", capacity: 5, windowSeconds: 3600 };
const ANSWERS_LIMIT = { name: "onboarding_answers", capacity: 10, windowSeconds: 3600 };

/**
 * One-time onboarding, safe to repeat. Creates the app_user row, accepts every pending
 * invite for the user's verified email, and creates a personal org with a default
 * workspace only when the user has legacy projects to move or no invite of any kind (an
 * invited user belongs to the inviter's org, not a stray one of their own, on a repeat too).
 */
export async function completeOnboarding(ctx: InviteCtx, who: Signed, body: { org_name: string }) {
  const { store, now, deps } = ctx;
  await deps.limiter.check(ONBOARDING_LIMIT, who.directusUserId);
  const orgName = body.org_name.trim();
  if (!orgName)
    throw new BadRequestError("organisation.name_required", {
      message: "Organization name is required",
    });

  const profile = await store.directusProfile(who.directusUserId);
  let me = await store.appUserByDirectusId(who.directusUserId);
  if (!me) {
    if (!profile) throw new NotFoundError("account.identity_missing");
    try {
      me = await store.createAppUser(
        {
          directusUserId: who.directusUserId,
          email: profile.email,
          displayName: profile.displayName,
        },
        now,
      );
    } catch {
      // A concurrent request created it first.
      me = await store.appUserByDirectusId(who.directusUserId);
    }
    if (!me) throw new Error("Failed to create user profile");
  }
  const userId = me.id;
  // Invites are matched to the verified identity email (spec C-2), never a profile copy.
  const email = await store.verifiedEmail(who.directusUserId);
  const iso = now.toISOString();
  const display = profile?.displayName || email;

  let joinedAnOrg = false;
  let joinedAnyWorkspace = false;
  let hadPendingInvite = false;
  let firstWorkspaceId: string | null = null;

  for (const invite of email ? await store.pendingWorkspaceInvites(email, now, "id") : []) {
    const ws = await store.workspace(invite.workspace_id);
    if (!ws || ws.deleted_at) continue;
    hadPendingInvite = true;
    let role = invite.role || "member";
    const hadOrgRow = ws.org_id
      ? (await store.orgMemberships(ws.org_id, userId, { activeOnly: true })).length > 0
      : false;
    // Already an insider of this org: an outsider invite would contradict ADR-0003, so it becomes member.
    if (isOutsider(role) && hadOrgRow) role = "member";
    const outsider = isOutsider(role);
    const hadWsRow =
      (await store.workspaceMemberships(ws.id, userId, { activeOnly: true })).length > 0;

    try {
      if (!outsider && ws.org_id) {
        if (!hadOrgRow)
          await store.createMembership("org", { orgId: ws.org_id, userId, role: "member" }, now);
        joinedAnOrg = true;
      }
      if (!hadWsRow)
        await store.createMembership(
          "workspace",
          { workspaceId: ws.id, userId, role, source: "direct" },
          now,
        );
      await grantInviteProjectShare(store, invite, userId, now, deps.logger);
      firstWorkspaceId ??= ws.id;
      joinedAnyWorkspace = true;
    } catch (err) {
      deps.logger?.error({ err, inviteId: invite.id }, "auto-accept failed; invite stays pending");
      continue;
    }
    try {
      await store.updateWorkspaceInvite(invite.id, { accepted_at: iso });
    } catch (err) {
      deps.logger?.error(
        { err, inviteId: invite.id },
        "membership written but invite not marked accepted",
      );
    }
    if (!hadWsRow) await requestSeatReconcile(deps.db, deps.jobs, ws.id, deps.logger);
    await notifyWorkspaceJoin(ctx, {
      me,
      email,
      invite,
      ws: { id: ws.id, name: ws.name, orgId: ws.org_id },
      role,
      newlyJoinedOrg: !outsider && !!ws.org_id && !hadOrgRow,
      guestCopy: "external-only",
      displayName: display,
    });
  }

  for (const inv of email ? await store.pendingOrgInvites(email, now, "id") : []) {
    const org = await store.org(inv.org_id);
    if (!org || org.deleted_at) continue;
    try {
      const rows = await store.orgMemberships(inv.org_id, userId, { activeOnly: true });
      if (!rows.length)
        await store.createMembership(
          "org",
          { orgId: inv.org_id, userId, role: inv.role || "member" },
          now,
        );
      await store.updateOrgInvite(inv.id, { accepted_at: iso });
      hadPendingInvite = true;
      joinedAnOrg = true;
    } catch (err) {
      deps.logger?.error({ err, inviteId: inv.id }, "org invite auto-accept failed; stays pending");
    }
  }

  const hasOwnProjects = (await store.orphanProjectIds(who.directusUserId, 1)).length > 0;
  let orgId: string | null = null;
  let workspaceId = firstWorkspaceId;

  const invited = joinedAnOrg || joinedAnyWorkspace || hadPendingInvite;
  const owned = await store.ownedOrgId(userId);
  // A repeat has no invite left to accept: someone who joined on an earlier call still
  // belongs to the inviter's org, and only an owner goes back to an org of their own.
  const belongs = invited || owned ? null : await store.belonging(userId);
  if (belongs) workspaceId = belongs.workspaceId;

  if (hasOwnProjects || (!invited && !belongs)) {
    orgId = owned;
    if (!orgId) {
      orgId = await store.createOrg({ name: orgName, createdBy: userId }, now);
      await store.createMembership("org", { orgId, userId, role: "owner" }, now);
    }
    let personal = (await store.defaultWorkspace(orgId))?.id ?? null;
    if (!personal) {
      // The org manages billing: its default workspace attaches to the org's account.
      const accountId =
        (await store.orgAccountId(orgId)) ??
        (await store.createOrgAccount(
          { orgId, tier: "free", createdBy: userId, label: "Org billing" },
          now,
        ));
      personal = await store.createWorkspace(
        { orgId, name: "Default", isDefault: true, createdBy: userId, billingAccountId: accountId },
        now,
      );
    }
    // Repairs a user whose earlier attempt created the workspace but not their row.
    if (!(await store.workspaceMemberships(personal, userId, { activeOnly: true })).length)
      await store.createMembership(
        "workspace",
        { workspaceId: personal, userId, role: "owner", source: "direct" },
        now,
      );
    if (hasOwnProjects)
      for (const id of await store.orphanProjectIds(who.directusUserId))
        await store.moveProject(id, personal, now);
    workspaceId = personal;
  }

  return { app_user_id: userId, org_id: orgId ?? "", workspace_id: workspaceId ?? "" };
}

/**
 * The post-registration questionnaire: stored on app_user, and answers that need a partner
 * review or a training get an inbox row for staff and an email to the training owner.
 * The follow-up is best effort and never fails the save.
 */
export async function submitOnboardingAnswers(
  ctx: InviteCtx,
  who: Signed,
  body: { version: string; data: Record<string, unknown>[]; skipped: boolean },
) {
  const { store, deps } = ctx;
  await deps.limiter.check(ANSWERS_LIMIT, who.directusUserId);
  const me = await onboardedUser(store, who);
  const answers = { version: body.version, data: body.data, skipped: body.skipped };
  await accountStorage(deps.db).setOnboardingAnswers(me.id, answers, ctx.now);

  const review = flagReview(body.data);
  if (!body.skipped && (review.partner || review.highRisk || review.training !== null)) {
    try {
      await notifyStaff(ctx, me, review);
    } catch (err) {
      deps.logger?.error({ err }, "onboarding follow-up notify failed");
    }
  }
  return { status: "success", onboarding_answer_json: answers };
}

/** q1 mentions clients: partner review. q2 yes: high-risk use. q3: followed a training (yes/no). */
export function flagReview(answers: readonly unknown[]) {
  let partner = false;
  let highRisk = false;
  let training: string | null = null;
  for (const a of answers) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const { q1, q2, q3 } = a as Record<string, unknown>;
    if (typeof q1 === "string" && q1.toLowerCase().includes("client")) partner = true;
    else if (
      Array.isArray(q1) &&
      q1.some((x) => typeof x === "string" && x.toLowerCase().includes("client"))
    )
      partner = true;
    if (typeof q2 === "string" && ["yes", "true"].includes(q2.trim().toLowerCase()))
      highRisk = true;
    else if (q2 === true) highRisk = true;
    if (typeof q3 === "string" && q3.trim()) training = q3.trim().toLowerCase();
  }
  return { partner, highRisk, training };
}

async function notifyStaff(
  ctx: InviteCtx,
  me: { id: string; display_name: string | null; email: string | null },
  r: ReturnType<typeof flagReview>,
) {
  const who = me.display_name || me.email || "A new user";
  const email = me.email || "";
  const lines: string[] = [];
  if (r.partner) lines.push("Selected serving external clients. Review for the partner flag.");
  if (r.highRisk) lines.push("Flagged a high-risk context. Training is required.");
  if (r.training === "yes") lines.push("Says they followed a training. Verify it.");
  else if (r.training === "no") lines.push("Has not followed a training. Organise one.");
  const summary = lines.join(" ") || "Needs onboarding follow-up.";
  const title = `Onboarding follow-up: ${who}`;

  const staff = await ctx.audiences.staff();
  if (staff.length)
    await ctx.deps.notifier.emitToAudience(staff, {
      actorUserId: me.id,
      eventCode: "ONBOARDING_FOLLOWUP",
      title,
      message: `${email}: ${summary}`.trim(),
      action: "NONE",
    });

  const to = ctx.deps.settings.onboardingFollowupInbox;
  if (to) {
    await ctx.deps.jobs.enqueue(sendEmail, {
      to,
      subject: title,
      template: "plain",
      data: {
        text: `${who} (${email}) just completed onboarding and needs follow-up:\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`,
      },
      context: `onboarding follow-up / ${me.id}`,
    });
  }
}
