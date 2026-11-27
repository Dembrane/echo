import { NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { seedBestPracticesJob } from "@dembrane/samples/jobs";
import { type InviteCtx, notifyWorkspaceJoin, onboardedUser } from "./invites/accept";
import { grantInviteProjectShare, isOutsider } from "./invites/membership";
import { withOrgCreateLock } from "./invites/storage";
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
export async function completeOnboarding(
  ctx: InviteCtx,
  who: Signed,
  body: { org_name?: string | null },
) {
  const { store, now, deps } = ctx;
  await deps.limiter.check(ONBOARDING_LIMIT, who.directusUserId);

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
    // One tx under tenancy's org-create lock, so parallel onboarding or POST /orgs make one org.
    const made = await withOrgCreateLock(deps.db, userId, async (tx) => {
      let id = await tx.ownedOrgId(userId);
      if (!id) {
        // A code sign-in has no name to suggest one, so an unnamed org is named after the email.
        const name = body.org_name?.trim() || defaultOrgName(email ?? profile?.email ?? "");
        id = await tx.createOrg({ name, createdBy: userId }, now);
        await tx.createMembership("org", { orgId: id, userId, role: "owner" }, now);
      }
      let personal = (await tx.defaultWorkspace(id))?.id ?? null;
      const fresh = !personal;
      if (!personal) {
        // The org manages billing: its default workspace attaches to the org's account.
        const accountId =
          (await tx.orgAccountId(id)) ??
          (await tx.createOrgAccount(
            { orgId: id, tier: "free", createdBy: userId, label: "Org billing" },
            now,
          ));
        personal = await tx.createWorkspace(
          {
            orgId: id,
            name: "Default",
            isDefault: true,
            createdBy: userId,
            billingAccountId: accountId,
          },
          now,
        );
      }
      // Repairs a user whose earlier attempt created the workspace but not their row.
      if (!(await tx.workspaceMemberships(personal, userId, { activeOnly: true })).length)
        await tx.createMembership(
          "workspace",
          { workspaceId: personal, userId, role: "owner", source: "direct" },
          now,
        );
      return { orgId: id, personal, fresh };
    });
    orgId = made.orgId;
    const personal = made.personal;
    if (made.fresh) await requestSample(ctx, personal);
    if (hasOwnProjects)
      for (const id of await store.orphanProjectIds(who.directusUserId))
        await store.moveProject(id, personal, now);
    workspaceId = personal;
  }

  return { app_user_id: userId, org_id: orgId ?? "", workspace_id: workspaceId ?? "" };
}

/**
 * Queues the new workspace's copy of the best-practices sample. Best effort: onboarding
 * never waits on or fails with it, and the samples backfill seeds a workspace it missed.
 */
async function requestSample(ctx: InviteCtx, workspaceId: string) {
  try {
    await ctx.deps.jobs.enqueue(
      seedBestPracticesJob,
      { workspaceId },
      { singletonKey: workspaceId },
    );
  } catch (err) {
    ctx.deps.logger?.error({ err, workspaceId }, "sample seed could not be queued");
  }
}

/**
 * The post-registration questionnaire: stored on app_user, and answers that need a partner
 * review or a training get an inbox row for staff and an email to the training owner. The
 * open problem answer (q4) is told to every staff member. Both are best effort and never
 * fail the save.
 */
export async function submitOnboardingAnswers(
  ctx: InviteCtx,
  who: Signed,
  body: { version: string; data: Record<string, unknown>[]; skipped: boolean },
) {
  const { store, deps } = ctx;
  await deps.limiter.check(ANSWERS_LIMIT, who.directusUserId);
  const me = await onboardedUser(store, who);
  const data = cleanProblem(body.data);
  const answers = { version: body.version, data, skipped: body.skipped };
  // The answer already stored is read under the same lock as the write, so two posts of
  // one answer tell staff once.
  let before: string | null = null;
  await accountStorage(deps.db).updateAppUserLocked(me.id, ctx.now, (fresh) => {
    before = storedProblem(fresh.onboarding_answer_json);
    return { onboarding_answer_json: answers };
  });

  const review = flagReview(data);
  const problem = body.skipped ? null : problemFrom(data);
  if (problem && problem !== before) {
    try {
      await shareProblem(ctx, me, problem);
    } catch (err) {
      deps.logger?.error({ err }, "onboarding problem notify failed");
    }
  }
  if (!body.skipped && (review.partner || review.highRisk || review.training !== null)) {
    try {
      await notifyStaff(ctx, me, review, problem);
    } catch (err) {
      deps.logger?.error({ err }, "onboarding follow-up notify failed");
    }
  }
  return { status: "success", onboarding_answer_json: answers };
}

/** The same ceiling as the box in About you. */
const PROBLEM_MAX_CHARS = 5000;

const problemText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, PROBLEM_MAX_CHARS);
  return text || null;
};

const isEntry = (a: unknown): a is Record<string, unknown> =>
  !!a && typeof a === "object" && !Array.isArray(a);

/** The problem they want to solve: the last string q4, trimmed and cut, or null. */
export function problemFrom(answers: readonly unknown[]): string | null {
  let last: string | null = null;
  for (const a of answers) if (isEntry(a) && typeof a.q4 === "string") last = a.q4;
  return problemText(last);
}

/** The q4 a stored answers JSON holds, read by the same rule. */
function storedProblem(json: unknown): string | null {
  const j = typeof json === "string" ? safeParse(json) : json;
  if (!isEntry(j) || !Array.isArray(j.data)) return null;
  return problemFrom(j.data);
}

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Stores q4 by the rule staff read it with: trimmed and cut, and dropped when unusable. */
function cleanProblem(data: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const a of data) {
    if (!isEntry(a) || !("q4" in a)) {
      out.push(a);
      continue;
    }
    const { q4, ...rest } = a;
    const text = problemText(q4);
    if (text) out.push({ ...rest, q4: text });
    else if (Object.keys(rest).length) out.push(rest);
  }
  return out;
}

/** q1 mentions clients: partner review. q2 yes: high-risk use. q3: followed a training (yes/no). */
export function flagReview(answers: readonly unknown[]) {
  let partner = false;
  let highRisk = false;
  let training: string | null = null;
  for (const a of answers) {
    if (!isEntry(a)) continue;
    const { q1, q2, q3 } = a;
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

type Answerer = { id: string; display_name: string | null; email: string | null };

/** Every staff member hears the answer in the bell, quoted, at info severity. */
async function shareProblem(ctx: InviteCtx, me: Answerer, problem: string) {
  const staff = await ctx.audiences.staff();
  if (!staff.length) return;
  await ctx.deps.notifier.emitToAudience(staff, {
    actorUserId: me.id,
    eventCode: "ONBOARDING_PROBLEM_SHARED",
    title: `Problem to solve: ${me.display_name || me.email || "A new user"}`,
    message: `${me.email || ""}: ${problem}`.trim(),
    action: "NONE",
  });
}

async function notifyStaff(
  ctx: InviteCtx,
  me: Answerer,
  r: ReturnType<typeof flagReview>,
  problem: string | null,
) {
  const who = me.display_name || me.email || "A new user";
  const email = me.email || "";
  const lines: string[] = [];
  if (r.partner) lines.push("Selected serving external clients. Review for the partner flag.");
  if (r.highRisk) lines.push("Flagged a high-risk context. Training is required.");
  if (r.training === "yes") lines.push("Says they followed a training. Verify it.");
  else if (r.training === "no") lines.push("Has not followed a training. Organise one.");
  const summary = lines.join(" ") || "Needs onboarding follow-up.";
  // The mail is the one place the training owner reads; the bell notice stays as it was.
  // Line breaks in the answer would break the list, so they become spaces.
  const mailLines = problem
    ? [...lines, `Problem they want to solve: ${problem.replace(/\s*[\r\n]+\s*/g, " ")}`]
    : lines;
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
        text: `${who} (${email}) just completed onboarding and needs follow-up:\n\n${mailLines.map((l) => `- ${l}`).join("\n")}\n`,
      },
      context: `onboarding follow-up / ${me.id}`,
    });
  }
}

/** "jane's Organisation" for jane@acme.com. */
export function defaultOrgName(email: string): string {
  const local = email.split("@")[0]?.trim();
  return local ? `${local}'s Organisation`.slice(0, 100) : "My Organisation";
}
