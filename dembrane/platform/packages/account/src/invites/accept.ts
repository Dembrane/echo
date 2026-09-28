import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  TamperedRequestError,
} from "@dembrane/core";
import { directusTime, type Signed } from "@dembrane/http";
import type { Audiences } from "@dembrane/notifications";
import type { AccountDeps } from "../deps";
import { requestSeatReconcile } from "../seats";
import { hashMatches } from "./hash";
import {
  ensureActiveOrgMembership,
  grantInviteProjectShare,
  isOutsider,
  rank,
  reconcileOutsider,
} from "./membership";
import type { AppUser, InviteStorage, OrgInvite, WorkspaceInvite } from "./storage";

/** 60 accepts an hour per user; counted after the seat gates so blocked retries are free. */
export const ACCEPT_LIMIT = { name: "invite_accept", capacity: 60, windowSeconds: 3600 };

const HONEYPOT =
  "Nice try. We noticed the URL tampering. If you enjoy finding edge cases, come work with us: sameer@dembrane.com";

export interface InviteCtx {
  readonly deps: AccountDeps;
  readonly store: InviteStorage;
  readonly audiences: Audiences;
  readonly now: Date;
}

export async function onboardedUser(store: InviteStorage, who: Signed): Promise<AppUser> {
  const u = who.appUserId ? await store.appUser(who.appUserId) : null;
  if (!u) throw new ForbiddenError("access.not_onboarded");
  return u;
}

const expired = (expiresAt: string | null, now: Date) =>
  expiresAt !== null && new Date(expiresAt).getTime() < now.getTime();

// ── list ──

/** Pending workspace and org invites addressed to the caller's verified email, newest first. */
export async function listMyInvites(ctx: InviteCtx, who: Signed) {
  const { store, now } = ctx;
  if (!who.appUserId || !(await store.appUser(who.appUserId))) return [];
  const email = await store.verifiedEmail(who.directusUserId);
  if (!email) return [];
  const [wsInvites, orgInvites] = await Promise.all([
    store.pendingWorkspaceInvites(email, now),
    store.pendingOrgInvites(email, now),
  ]);
  if (!wsInvites.length && !orgInvites.length) return [];

  const workspaces = await store.liveWorkspaces([...new Set(wsInvites.map((i) => i.workspace_id))]);
  const wsMap = new Map(workspaces.map((w) => [w.id, w]));
  const orgIds = new Set<string>();
  for (const w of workspaces) if (w.orgId) orgIds.add(w.orgId);
  for (const i of orgInvites) orgIds.add(i.org_id);
  const orgNames = await store.liveOrgNames([...orgIds]);
  const inviters = await store.appUserNames([
    ...new Set(
      [...wsInvites, ...orgInvites].map((i) => i.invited_by).filter((x): x is string => !!x),
    ),
  ]);

  const out: {
    id: string;
    type: "workspace" | "org";
    workspace_id: string | null;
    workspace_name: string | null;
    org_id: string;
    org_name: string;
    role: string;
    invited_by_name: string | null;
    created_at: string | null;
    expires_at: string | null;
  }[] = [];
  for (const inv of wsInvites) {
    const ws = wsMap.get(inv.workspace_id);
    if (!ws) continue; // workspace deleted: the invite is dropped
    out.push({
      id: inv.id,
      type: "workspace",
      workspace_id: inv.workspace_id,
      workspace_name: ws.name,
      org_id: ws.orgId ?? "",
      org_name: (ws.orgId && orgNames.get(ws.orgId)) || "",
      role: inv.role,
      invited_by_name: (inv.invited_by && inviters.get(inv.invited_by)) || null,
      created_at: directusTime(inv.created_at),
      expires_at: directusTime(inv.expires_at),
    });
  }
  for (const inv of orgInvites) {
    if (!orgNames.has(inv.org_id)) continue; // org deleted
    out.push({
      id: inv.id,
      type: "org",
      workspace_id: null,
      workspace_name: null,
      org_id: inv.org_id,
      org_name: orgNames.get(inv.org_id) ?? "",
      role: inv.role,
      invited_by_name: (inv.invited_by && inviters.get(inv.invited_by)) || null,
      created_at: directusTime(inv.created_at),
      expires_at: directusTime(inv.expires_at),
    });
  }
  // Stable, newest first across both kinds, as Python's sort did.
  return out
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const x = a.r.created_at ? Date.parse(a.r.created_at) : 0;
      const y = b.r.created_at ? Date.parse(b.r.created_at) : 0;
      return y - x || a.i - b.i;
    })
    .map(({ r }) => r);
}

// ── accept by id ──

/** Accepts a pending workspace or org invite by id; the invite must be addressed to the caller. */
export async function acceptMyInvite(ctx: InviteCtx, who: Signed, inviteId: string) {
  const { store, now } = ctx;
  const me = await onboardedUser(store, who);
  const email = await store.verifiedEmail(who.directusUserId);

  const invite = await store.workspaceInvite(inviteId, { liveOnly: true });
  if (!invite) {
    const orgInv = await store.orgInvite(inviteId, { liveOnly: true });
    if (!orgInv) throw new NotFoundError("invite.not_found");
    return acceptOrgInvite(ctx, me, email, orgInv);
  }

  if (invite.email.toLowerCase() !== email) throw new ForbiddenError("invite.not_for_you");
  if (invite.accepted_at) throw new BadRequestError("invite.already_accepted");
  if (expired(invite.expires_at, now)) throw new BadRequestError("invite.expired");

  const ws = await store.workspace(invite.workspace_id);
  if (!ws || ws.deleted_at) throw new NotFoundError("workspace.deleted");
  const role = invite.role || "member";
  const outsider = isOutsider(role);

  await ctx.deps.limiter.check(ACCEPT_LIMIT, me.id);

  let newlyJoinedOrg = false;
  if (!outsider && ws.org_id) {
    const orgRows = await store.orgMemberships(ws.org_id, me.id, { activeOnly: true });
    if (!orgRows.length)
      newlyJoinedOrg = await store.createMembership(
        "org",
        { orgId: ws.org_id, userId: me.id, role: "member" },
        now,
      );
  }
  if (outsider && ws.org_id) await reconcileOutsider(store, ws.org_id, me.id, now);

  const wsRows = await store.workspaceMemberships(invite.workspace_id, me.id, { activeOnly: true });
  if (!wsRows.length)
    await store.createMembership(
      "workspace",
      { workspaceId: invite.workspace_id, userId: me.id, role, source: "direct" },
      now,
    );
  await grantInviteProjectShare(store, invite, me.id, now, ctx.deps.logger);
  await store.updateWorkspaceInvite(invite.id, { accepted_at: now.toISOString() });
  await requestSeatReconcile(ctx.deps.db, ctx.deps.jobs, invite.workspace_id, ctx.deps.logger);

  await notifyWorkspaceJoin(ctx, {
    me,
    email: me.email ?? "",
    invite,
    ws: { id: ws.id, name: ws.name, orgId: ws.org_id },
    role,
    newlyJoinedOrg,
    guestCopy: "full",
  });

  if (ws.org_id && !outsider)
    await consumePendingInOrg(ctx, {
      email,
      orgId: ws.org_id,
      userId: me.id,
      excludeWorkspaceInviteId: invite.id,
    });

  return {
    status: "success",
    type: "workspace",
    workspace_id: invite.workspace_id,
    workspace_name: ws.name,
    org_id: ws.org_id,
  };
}

/** The id is the proof here; the email match proves ownership. */
async function acceptOrgInvite(ctx: InviteCtx, me: AppUser, email: string, inv: OrgInvite) {
  const { store, now } = ctx;
  if (inv.email.toLowerCase() !== email) throw new ForbiddenError("invite.not_for_you");
  if (inv.accepted_at) throw new BadRequestError("invite.already_accepted");
  if (expired(inv.expires_at, now)) throw new BadRequestError("invite.expired");
  const role = inv.role || "member";
  const org = await store.org(inv.org_id);
  if (!org || org.deleted_at) throw new NotFoundError("organisation.deleted");
  await ctx.deps.limiter.check(ACCEPT_LIMIT, me.id);
  const status = await ensureActiveOrgMembership(store, inv.org_id, me.id, role, now);
  await store.updateOrgInvite(inv.id, { accepted_at: now.toISOString() });
  await consumePendingInOrg(ctx, {
    email,
    orgId: inv.org_id,
    userId: me.id,
    excludeOrgInviteId: inv.id,
  });
  return {
    status: status === "already_active" ? "already_member" : "success",
    type: "org",
    org_id: inv.org_id,
    org_name: org.name ?? "",
  };
}

// ── decline ──

/** Soft-deletes the invite (like a revoke, keeping the audit trail) and tells the inviter. */
export async function declineMyInvite(ctx: InviteCtx, who: Signed, inviteId: string) {
  const { store, now } = ctx;
  const me = await onboardedUser(store, who);
  const email = await store.verifiedEmail(who.directusUserId);
  const wsInv = await store.workspaceInvite(inviteId, { liveOnly: false });
  const orgInv = wsInv ? null : await store.orgInvite(inviteId, { liveOnly: false });
  const invite = wsInv ?? orgInv;
  if (!invite) throw new NotFoundError("invite.not_found");
  if (invite.email.toLowerCase() !== email) throw new ForbiddenError("invite.not_for_you");
  if (invite.accepted_at) throw new BadRequestError("invite.already_accepted");
  if (invite.deleted_at) throw new NotFoundError("invite.not_found");

  if (invite.invited_by && wsInv) {
    const ws = await store.workspace(wsInv.workspace_id);
    await ctx.deps.notifier.emit({
      audienceUserId: invite.invited_by,
      actorUserId: me.id,
      eventCode: "INVITE_DECLINED",
      title: `${email} declined your invite`,
      message: `They chose not to join **${ws?.name || "a workspace"}**.`,
      action: "NAVIGATE_WORKSPACE_SETTINGS",
      refWorkspaceId: wsInv.workspace_id,
    });
  } else if (invite.invited_by && orgInv) {
    const org = await store.org(orgInv.org_id);
    await ctx.deps.notifier.emit({
      audienceUserId: invite.invited_by,
      actorUserId: me.id,
      eventCode: "INVITE_DECLINED",
      title: `${email} declined your invite`,
      message: `They chose not to join **${org?.name || "an organisation"}**.`,
      action: "NAVIGATE_ORGANISATION_SETTINGS",
      refOrgId: orgInv.org_id,
    });
  }
  const patch = { deleted_at: now.toISOString() };
  if (wsInv) await store.updateWorkspaceInvite(inviteId, patch);
  else await store.updateOrgInvite(inviteId, patch);
  return { status: "success" };
}

// ── by hash ──

type HashState = {
  status: string;
  type: "workspace" | "org" | null;
  workspace_id: string | null;
  workspace_name: string | null;
  org_id: string | null;
  org_name: string | null;
  role: string | null;
  is_member: boolean | null;
  expires_at: string | null;
};

const state = (s: Partial<HashState> & { status: string }): HashState => ({
  type: null,
  workspace_id: null,
  workspace_name: null,
  org_id: null,
  org_name: null,
  role: null,
  is_member: null,
  expires_at: null,
  ...s,
});

async function myEmailOrRaise(store: InviteStorage, who: Signed) {
  const me = await onboardedUser(store, who);
  const email = await store.verifiedEmail(who.directusUserId);
  if (!email) throw new BadRequestError("account.email_missing");
  return { me, email };
}

/**
 * Read-only look at an invite link on page load, so an used link shows as accepted
 * instead of being consumed again. Scoped to the caller's email; the HMAC is the gate.
 */
export async function inspectByHash(ctx: InviteCtx, who: Signed, h: string) {
  const { store, now } = ctx;
  const secret = ctx.deps.settings.inviteHashSecret;
  const { me, email } = await myEmailOrRaise(store, who);

  const target = (await store.liveWorkspaceInvites(email)).find((i) =>
    hashMatches(secret, i.id, h),
  );
  if (!target) {
    const orgTarget = (await store.liveOrgInvites(email)).find((i) => hashMatches(secret, i.id, h));
    if (!orgTarget) return state({ status: "not_found" });
    const org = await store.org(orgTarget.org_id);
    const isMember =
      (await store.orgMemberships(orgTarget.org_id, me.id, { activeOnly: true })).length > 0;
    const base = {
      type: "org" as const,
      org_id: orgTarget.org_id,
      org_name: org?.name || "",
      role: orgTarget.role,
      is_member: isMember,
    };
    if (!org || org.deleted_at) return state({ status: "org_deleted", ...base });
    if (orgTarget.accepted_at) return state({ status: "accepted", ...base });
    if (expired(orgTarget.expires_at, now))
      return state({ status: "expired", ...base, expires_at: directusTime(orgTarget.expires_at) });
    return state({ status: "pending", ...base, expires_at: directusTime(orgTarget.expires_at) });
  }

  const ws = await store.workspace(target.workspace_id);
  if (!ws || ws.deleted_at)
    return state({
      status: "workspace_deleted",
      type: "workspace",
      workspace_name: ws?.name || "",
    });
  const isMember =
    (await store.workspaceMemberships(target.workspace_id, me.id, { activeOnly: true })).length > 0;
  const base = {
    type: "workspace" as const,
    workspace_id: target.workspace_id,
    workspace_name: ws.name || "",
    role: target.role,
  };
  if (target.accepted_at) return state({ status: "accepted", ...base, is_member: isMember });
  if (expired(target.expires_at, now))
    return state({ status: "expired", ...base, expires_at: directusTime(target.expires_at) });
  return state({
    status: "pending",
    ...base,
    is_member: isMember,
    expires_at: directusTime(target.expires_at),
  });
}

/**
 * Accepts the pending invite whose link hash matches. Layers: the caller's verified email
 * (the lookup scope), the HMAC (unforgeable without the secret), and a honeypot on a
 * role claimed in the URL that is higher than the invite's.
 */
export async function acceptByHash(
  ctx: InviteCtx,
  who: Signed,
  body: { hash: string; claimed_role: string | null },
) {
  const { store, now } = ctx;
  const secret = ctx.deps.settings.inviteHashSecret;
  const { me, email } = await myEmailOrRaise(store, who);

  const target = (await store.pendingWorkspaceInvites(email, now)).find((i) =>
    hashMatches(secret, i.id, body.hash),
  );

  if (!target) {
    const orgTarget = (await store.pendingOrgInvites(email, now)).find((i) =>
      hashMatches(secret, i.id, body.hash),
    );
    if (orgTarget) {
      const role = orgTarget.role || "member";
      if (body.claimed_role && rank(body.claimed_role, -1) > rank(role)) {
        ctx.deps.logger?.warn({ email, claimed: body.claimed_role, role }, "invite honeypot (org)");
        throw new TamperedRequestError("request.tampered", { message: HONEYPOT });
      }
      const org = await store.org(orgTarget.org_id);
      if (!org || org.deleted_at) throw new NotFoundError("organisation.deleted");
      await ctx.deps.limiter.check(ACCEPT_LIMIT, me.id);
      const status = await ensureActiveOrgMembership(store, orgTarget.org_id, me.id, role, now);
      await store.updateOrgInvite(orgTarget.id, { accepted_at: now.toISOString() });
      await consumePendingInOrg(ctx, {
        email,
        orgId: orgTarget.org_id,
        userId: me.id,
        excludeOrgInviteId: orgTarget.id,
      });
      return {
        status: status === "already_active" ? "already_member" : "success",
        type: "org",
        org_id: orgTarget.org_id,
        org_name: org.name ?? "",
      };
    }
    return healByHash(ctx, me, email, body.hash);
  }

  const role = target.role || "member";
  const outsider = isOutsider(role);
  if (body.claimed_role && rank(body.claimed_role, -1) > rank(role)) {
    ctx.deps.logger?.warn({ email, claimed: body.claimed_role, role }, "invite honeypot");
    throw new TamperedRequestError("request.tampered", { message: HONEYPOT });
  }
  const ws = await store.workspace(target.workspace_id);
  if (!ws || ws.deleted_at) throw new NotFoundError("workspace.deleted");
  await ctx.deps.limiter.check(ACCEPT_LIMIT, me.id);

  let hadOrgRow = false;
  let newlyJoinedOrg = false;
  if (!outsider && ws.org_id) {
    hadOrgRow = (await store.orgMemberships(ws.org_id, me.id, { activeOnly: true })).length > 0;
    if (!hadOrgRow) {
      await store.createMembership("org", { orgId: ws.org_id, userId: me.id, role: "member" }, now);
      newlyJoinedOrg = true;
    }
  }
  if (outsider && ws.org_id) await reconcileOutsider(store, ws.org_id, me.id, now);
  const wsRows = await store.workspaceMemberships(target.workspace_id, me.id, { activeOnly: true });
  if (!wsRows.length)
    await store.createMembership(
      "workspace",
      { workspaceId: target.workspace_id, userId: me.id, role, source: "direct" },
      now,
    );
  await grantInviteProjectShare(store, target, me.id, now, ctx.deps.logger);
  await store.updateWorkspaceInvite(target.id, { accepted_at: now.toISOString() });

  await notifyWorkspaceJoin(ctx, {
    me,
    email,
    invite: target,
    ws: { id: ws.id, name: ws.name, orgId: ws.org_id },
    role,
    newlyJoinedOrg,
    guestCopy: "external-only",
  });

  if (ws.org_id && !outsider)
    await consumePendingInOrg(ctx, {
      email,
      orgId: ws.org_id,
      userId: me.id,
      excludeWorkspaceInviteId: target.id,
    });

  return {
    status: "success",
    type: "workspace",
    workspace_id: target.workspace_id,
    workspace_name: ws.name,
    org_id: ws.org_id,
  };
}

/**
 * Self-heal for an invite already marked accepted whose membership write was lost
 * (partial write or retry): the verified email plus the unforgeable hash prove ownership,
 * so the missing membership is created from the invite's own role. Only accepted invites
 * heal: an expired invite that was never accepted is refused rather than turned into a
 * membership, which the old heal path allowed.
 */
async function healByHash(ctx: InviteCtx, me: AppUser, email: string, hash: string) {
  const { store, now } = ctx;
  const secret = ctx.deps.settings.inviteHashSecret;

  const inv = (await store.liveWorkspaceInvites(email)).find((i) =>
    hashMatches(secret, i.id, hash),
  );
  if (inv && !inv.accepted_at) throw new BadRequestError("invite.expired");
  if (inv) {
    const ws = await store.workspace(inv.workspace_id);
    if (!ws || ws.deleted_at) throw new NotFoundError("workspace.deleted");
    const already =
      (await store.workspaceMemberships(inv.workspace_id, me.id, { activeOnly: true })).length > 0;
    if (already) {
      if (ws.org_id)
        await consumePendingInOrg(ctx, {
          email,
          orgId: ws.org_id,
          userId: me.id,
          excludeWorkspaceInviteId: inv.id,
        });
      return { status: "already_member", workspace_id: inv.workspace_id, workspace_name: ws.name };
    }
    const role = inv.role || "member";
    const outsider = isOutsider(role);
    ctx.deps.logger?.warn(
      { inviteId: inv.id, workspaceId: inv.workspace_id },
      "accept-by-hash healed a missing workspace membership",
    );
    if (!outsider && ws.org_id) {
      const orgRows = await store.orgMemberships(ws.org_id, me.id, { activeOnly: true });
      if (!orgRows.length)
        await store.createMembership(
          "org",
          { orgId: ws.org_id, userId: me.id, role: "member" },
          now,
        );
    }
    if (outsider && ws.org_id) await reconcileOutsider(store, ws.org_id, me.id, now);
    await store.createMembership(
      "workspace",
      { workspaceId: inv.workspace_id, userId: me.id, role, source: "direct" },
      now,
    );
    await grantInviteProjectShare(store, inv, me.id, now, ctx.deps.logger);
    return {
      status: "healed",
      type: "workspace",
      workspace_id: inv.workspace_id,
      workspace_name: ws.name,
      org_id: ws.org_id,
    };
  }

  const orgInv = (await store.liveOrgInvites(email)).find((i) => hashMatches(secret, i.id, hash));
  if (orgInv && !orgInv.accepted_at) throw new BadRequestError("invite.expired");
  if (orgInv) {
    const org = await store.org(orgInv.org_id);
    if (!org || org.deleted_at) throw new NotFoundError("organisation.deleted");
    ctx.deps.logger?.warn(
      { inviteId: orgInv.id, orgId: orgInv.org_id },
      "accept-by-hash healed a missing org membership",
    );
    const status = await ensureActiveOrgMembership(
      store,
      orgInv.org_id,
      me.id,
      orgInv.role || "member",
      now,
    );
    await consumePendingInOrg(ctx, {
      email,
      orgId: orgInv.org_id,
      userId: me.id,
      excludeOrgInviteId: orgInv.id,
    });
    return {
      status: status === "already_active" ? "already_member" : "healed",
      type: "org",
      org_id: orgInv.org_id,
      org_name: org.name ?? "",
    };
  }
  throw new NotFoundError("invite.not_found", { message: "Invite not found or already handled" });
}

// ── effects ──

/**
 * Inbox rows after someone joins a workspace through an invite: the inviter hears it was
 * accepted, org admins hear about a new org member, workspace admins about a guest.
 * `guestCopy` keeps the two wordings the old accept paths used.
 */
export async function notifyWorkspaceJoin(
  ctx: InviteCtx,
  p: {
    me: AppUser;
    email: string;
    invite: WorkspaceInvite;
    ws: { id: string; name: string | null; orgId: string | null };
    role: string;
    newlyJoinedOrg: boolean;
    guestCopy: "full" | "external-only";
    /** Display name override (onboarding reads it from the Directus profile). */
    displayName?: string;
  },
) {
  const { notifier } = ctx.deps;
  const inviterId = p.invite.invited_by;
  const name = p.displayName || p.me.display_name || p.email;
  const wsName = p.ws.name || "your workspace";
  if (inviterId && inviterId !== p.me.id) {
    await notifier.emit({
      audienceUserId: inviterId,
      actorUserId: p.me.id,
      eventCode: "INVITE_ACCEPTED",
      title: `${name || "Someone"} joined ${wsName}`,
      message: "They accepted your invite and can now collaborate.",
      action: "NAVIGATE_WORKSPACE_SETTINGS",
      refWorkspaceId: p.invite.workspace_id,
      refOrgId: p.ws.orgId,
    });
  }
  if (p.newlyJoinedOrg && p.ws.orgId) {
    const admins = await ctx.audiences.organisationAdmins(p.ws.orgId);
    const org = await ctx.store.org(p.ws.orgId);
    await notifier.emitToAudience(admins, {
      actorUserId: inviterId,
      eventCode: "ORGANISATION_MEMBER_ADDED",
      title: `${name || "A new member"} joined ${org?.name || "the organisation"}`,
      message: "They're now a organisation member.",
      action: "NAVIGATE_ORGANISATION_SETTINGS",
      refOrgId: p.ws.orgId,
    });
  }
  if (isOutsider(p.role)) {
    const admins = (await ctx.audiences.workspaceAdmins(p.invite.workspace_id)).filter(
      (a) => a !== p.me.id && a !== inviterId,
    );
    const label = p.email || "A guest";
    const observer = p.guestCopy === "full" && p.role === "observer";
    await notifier.emitToAudience(admins, {
      actorUserId: p.me.id,
      eventCode: "WORKSPACE_GUEST_ADDED",
      title: observer
        ? `${name || "A guest"} joined ${wsName} as an observer`
        : `${name || (p.guestCopy === "full" ? "A guest" : "An external")} joined ${wsName} as an external`,
      message: observer
        ? `${label} now has free, read-only observer access. Observers don't count against your seat cap.`
        : `${p.guestCopy === "full" ? label : p.email} now has external access. Externals count against your tier's seat cap.`,
      action: "NAVIGATE_WORKSPACE_SETTINGS",
      refWorkspaceId: p.invite.workspace_id,
      refOrgId: p.ws.orgId,
    });
  }
}

/**
 * One accept applies every other pending invite for the same email in the same org, so
 * the user gets all promised memberships in one click. Per-invite failures are logged
 * and skipped: the originating accept has already been honoured.
 */
export async function consumePendingInOrg(
  ctx: InviteCtx,
  p: {
    email: string;
    orgId: string;
    userId: string;
    excludeWorkspaceInviteId?: string;
    excludeOrgInviteId?: string;
  },
) {
  const { store, now } = ctx;
  const iso = now.toISOString();
  const wsIds = await store.liveWorkspaceIdsInOrg(p.orgId);
  for (const inv of await store.pendingWorkspaceInvitesIn(
    p.email,
    wsIds,
    now,
    p.excludeWorkspaceInviteId,
  )) {
    try {
      const ws = await store.workspace(inv.workspace_id);
      if (!ws || ws.deleted_at) continue;
      const rows = await store.workspaceMemberships(inv.workspace_id, p.userId, {
        activeOnly: false,
      });
      const active = rows.find((r) => r.deleted_at === null);
      const deleted = rows.find((r) => r.deleted_at !== null);
      if (!active && deleted) {
        await store.updateMembership(
          "workspace",
          deleted.id,
          { deleted_at: null, role: inv.role || "member", source: "direct" },
          now,
        );
      } else if (!active) {
        await store.createMembership(
          "workspace",
          {
            workspaceId: inv.workspace_id,
            userId: p.userId,
            role: inv.role || "member",
            source: "direct",
          },
          now,
        );
      }
      await grantInviteProjectShare(store, inv, p.userId, now, ctx.deps.logger);
      await store.updateWorkspaceInvite(inv.id, { accepted_at: iso });
    } catch (err) {
      ctx.deps.logger?.error(
        { err, inviteId: inv.id },
        "multi-consume: workspace invite not applied",
      );
    }
  }

  const orgInvites = await store.pendingOrgInvitesFor(p.email, p.orgId, now, p.excludeOrgInviteId);
  if (!orgInvites.length) return;
  const [active] = await store.orgMemberships(p.orgId, p.userId, { activeOnly: true });
  let currentRole = active?.role || "member";
  for (const inv of orgInvites) {
    try {
      const role = inv.role || "member";
      // An invite for a higher role promotes the existing membership.
      if (active && rank(role) > rank(currentRole)) {
        await store.updateMembership("org", active.id, { role }, now);
        currentRole = role;
      }
      await store.updateOrgInvite(inv.id, { accepted_at: iso });
    } catch (err) {
      ctx.deps.logger?.error(
        { err, inviteId: inv.id },
        "multi-consume: org invite not marked accepted",
      );
    }
  }
}
