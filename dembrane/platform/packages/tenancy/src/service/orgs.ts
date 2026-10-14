import {
  deriveWorkspaceRole,
  ROLE_RANK,
  resolveWorkspace,
  type WorkspaceRole,
} from "@dembrane/access";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  newId,
} from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { localeOfEmail, localesOfAppUsers } from "@dembrane/i18n";
import { isoTimestamp } from "@dembrane/legacy-shape";
import { seedBestPracticesJob } from "@dembrane/samples/jobs";
import { commercial, orgAccountForNewWorkspace, reconcileSeats } from "../billing";
import { type Member, requireOnboarded, WorkspaceContext } from "../context";
import { iso, isUuid } from "../db";
import { clock, type TenancyDeps } from "../deps";
import { orgInviteEmail } from "../emails";
import { emailJob } from "../jobs";
import { inviteAcceptUrl, inviteHash } from "../links";
import { checkLogoFile, deleteLogo, isOwnedFile, saveLogo } from "../logos";
import { derivationView, effectiveMembers, followsOrgAdmins, seatState } from "../members";
import { emit, emitToAll, staffAppUsers } from "../notify";
import { pyInt, pyRound } from "../numbers";
import {
  countPendingInvites,
  insertOrgInvite,
  pendingOrgInvites,
  pendingWorkspaceInvites,
} from "../storage/invites";
import {
  conversationDurationsBetween,
  countExternals,
  countsByWorkspace,
  insertOrg,
  insertOrgMembership,
  liveConversationDurations,
  liveProjectsIn,
  partnerOrgNamesExternalOf,
  pinnedProjects,
  referralLedger,
  softDeleteMembershipsInOrg,
  updateOrg,
  updateOrgMembership,
} from "../storage/orgs";
import {
  appUser,
  appUserByDirectusId,
  appUsersByIds,
  avatars,
  directusUserByEmail,
} from "../storage/people";
import {
  activeOrgMembership,
  anyOrgMembership,
  billingAccountsByIds,
  countOrgMembers,
  countOrgWorkspaces,
  distinctAccountsOf,
  insertMembership,
  insertWorkspace,
  membershipsIn,
  membershipsOfUser,
  orgById,
  orgMembers,
  orgMembershipsOfUser,
  orgsByIds,
  orgWorkspaces,
  orgWorkspacesForCards,
  workspaceNames,
} from "../storage/tenancy";
import { projectsIn } from "../storage/usage";
import { capacityOf } from "../tiers";
import { monthBounds, pyIso } from "../usage";
import { isOrgExternalOnly } from "./access-requests";
import { validLogoUrl } from "./settings";
import { oneLine } from "./workspaces";

const ORG_ROLES = new Set(["member", "admin", "billing", "owner"]);
const MANAGERS = ["admin", "owner"];

export function orgService(deps: TenancyDeps) {
  const { db } = deps;

  /**
   * The caller's active role in a live org, or 403. A soft-deleted org is no longer
   * manageable (spec L-15).
   */
  async function requireOrgRole(
    orgId: string,
    member: Member,
    minimum: "member" | "admin" | "owner",
  ) {
    const row = await activeOrgMembership(db, orgId, member.appUserId);
    const org = row ? await orgById(db, orgId) : null;
    if (!row || !org || org.deleted_at) throw new ForbiddenError("organisation.no_access");
    if (minimum === "owner" && row.role !== "owner")
      throw new ForbiddenError("organisation.owner_only");
    if (minimum === "admin" && !MANAGERS.includes(row.role))
      throw new ForbiddenError("organisation.admin_only");
    return row.role;
  }

  async function detail(orgId: string, role: string) {
    const org = await orgById(db, orgId);
    if (!org || org.deleted_at) throw new NotFoundError("organisation.not_found");
    return {
      id: orgId,
      name: org.name ?? "",
      description: org.description,
      logo_url: org.logo_url,
      role,
      member_count: await countOrgMembers(db, orgId),
      workspace_count: await countOrgWorkspaces(db, orgId),
      external_count: await countExternals(db, orgId),
    };
  }

  /** An external on any of the org's workspaces never holds org admin or owner. */
  async function requireNotExternal(orgId: string, userId: string) {
    const ids = (await orgWorkspaces(db, orgId)).map((w) => w.id);
    const ext = await membershipsOfUser(db, userId, { workspaceIds: ids, role: "external" });
    if (ext.length) throw new BadRequestError("organisation.external_cannot_manage");
  }

  /** How many of the org's workspaces each user reaches: a direct row, or derived from their org role. */
  async function reachCounts(orgId: string, userIds: readonly string[]) {
    const counts = new Map(userIds.map((u) => [u, 0]));
    if (!userIds.length) return counts;
    const workspaces = await orgWorkspaces(db, orgId);
    if (!workspaces.length) return counts;
    const roles = new Map<string, string>();
    for (const r of await orgMembers(db, orgId))
      if (userIds.includes(r.user_id)) roles.set(r.user_id, r.role);
    const pairs = new Set(
      (
        await membershipsIn(
          db,
          workspaces.map((w) => w.id),
          { userIds },
        )
      ).map((m) => `${m.workspace_id}:${m.user_id}`),
    );
    for (const w of workspaces) {
      const view = derivationView(w);
      for (const uid of userIds)
        if (pairs.has(`${w.id}:${uid}`) || deriveWorkspaceRole(view, roles.get(uid) ?? null, uid))
          counts.set(uid, (counts.get(uid) ?? 0) + 1);
    }
    return counts;
  }

  /** {user: {workspace: role}} and {user: {workspace: membership id}}; a direct row wins a duplicate pair. */
  async function directRoles(orgId: string, userIds: readonly string[]) {
    const roles = new Map<string, Record<string, string>>();
    const ids = new Map<string, Record<string, string>>();
    if (!userIds.length) return { roles, ids };
    const wsIds = (await orgWorkspaces(db, orgId)).map((w) => w.id);
    const byPair = new Map<string, (typeof rows)[number]>();
    const rows = await membershipsIn(db, wsIds, { userIds });
    for (const m of rows) {
      const key = `${m.workspace_id}:${m.user_id}`;
      const existing = byPair.get(key);
      if (!existing || (m.source === "direct" && existing.source !== "direct")) byPair.set(key, m);
    }
    for (const m of byPair.values()) {
      roles.set(m.user_id, { ...(roles.get(m.user_id) ?? {}), [m.workspace_id]: m.role });
      ids.set(m.user_id, { ...(ids.get(m.user_id) ?? {}), [m.workspace_id]: m.id });
    }
    return { roles, ids };
  }

  return {
    async list(who: Signed) {
      const member = requireOnboarded(who);
      const memberships = await orgMembershipsOfUser(db, member.appUserId);
      if (!memberships.length) return [];
      const orgs = new Map(
        (
          await orgsByIds(
            db,
            memberships.map((m) => m.org_id),
            { live: true },
          )
        ).map((o) => [o.id, o]),
      );
      const roleOf = new Map(memberships.map((m) => [m.org_id, m.role]));
      const out = [];
      for (const m of memberships) {
        const o = orgs.get(m.org_id);
        if (!o) continue;
        out.push({
          id: o.id,
          name: o.name ?? "",
          logo_url: o.logo_url,
          role: roleOf.get(o.id) ?? "member",
          member_count: await countOrgMembers(db, o.id),
          workspace_count: await countOrgWorkspaces(db, o.id),
        });
      }
      return out;
    },

    /** A new org with its owner, a free pooled account and a default workspace. */
    async create(who: Signed, rawName: string) {
      const member = requireOnboarded(who);
      const name = oneLine(rawName);
      if (!name) throw new BadRequestError("organisation.name_required");
      const now = clock(deps);
      const orgId = newId();
      const wsId = newId();
      await db.transaction(async (tx) => {
        await insertOrg(tx, {
          id: orgId,
          name,
          created_by: member.appUserId,
          created_at: iso(now),
          updated_at: iso(now),
        });
        await insertOrgMembership(tx, {
          id: newId(),
          org_id: orgId,
          user_id: member.appUserId,
          role: "owner",
          created_at: iso(now),
          updated_at: iso(now),
        });
        const accountId = await orgAccountForNewWorkspace(tx, now, orgId, member.appUserId);
        await insertWorkspace(tx, {
          id: wsId,
          org_id: orgId,
          name: "Default",
          is_default: true,
          created_by: member.appUserId,
          billing_account_id: accountId,
          created_at: iso(now),
          updated_at: iso(now),
        });
        await insertMembership(tx, {
          id: newId(),
          workspace_id: wsId,
          user_id: member.appUserId,
          role: "owner",
          source: "direct",
          created_at: iso(now),
          updated_at: iso(now),
        });
        // Its copy of the best-practices sample, seeded by the worker once this commits.
        await deps.jobs.enqueue(seedBestPracticesJob, { workspaceId: wsId }, { tx });
        // An external of a partner starting their own org is an upsell signal for staff (ISSUE-028).
        const partners = await partnerOrgNamesExternalOf(tx, member.appUserId);
        if (partners.length) {
          const me = await appUser(tx, member.appUserId);
          const whoName = me?.display_name || me?.email || "An external user";
          await emitToAll(tx, now, await staffAppUsers(tx), {
            actor: member.appUserId,
            event: "EXTERNAL_CREATED_ORG",
            title: `External of a partner created an org: ${name}`,
            message: `${whoName} is an external collaborator of ${partners.join(", ")} and just created their own organisation '${name}'. Possible upsell.`,
            action: "NONE",
          });
        }
      });
      return { org_id: orgId, workspace_id: wsId };
    },

    async get(who: Signed, orgId: string) {
      const member = requireOnboarded(who);
      return detail(orgId, await requireOrgRole(orgId, member, "member"));
    },

    async update(
      who: Signed,
      orgId: string,
      body: { name: string | null; description: string | null; logo_url: string | null },
    ) {
      const member = requireOnboarded(who);
      const role = await requireOrgRole(orgId, member, "admin");
      const patch: Record<string, string | null> = {};
      if (body.name !== null) patch.name = oneLine(body.name);
      if (body.description !== null) patch.description = body.description.trim() || null;
      if (body.logo_url !== null) patch.logo_url = validLogoUrl(body.logo_url) || null;
      if (!Object.keys(patch).length)
        throw new BadRequestError("request.nothing_to_update", { message: "Nothing to update" });
      await updateOrg(db, orgId, { ...patch, updated_at: iso(clock(deps)) });
      return detail(orgId, role);
    },

    async uploadLogo(who: Signed, orgId: string, file: File) {
      const member = requireOnboarded(who);
      await requireOrgRole(orgId, member, "admin");
      checkLogoFile(file);
      const now = clock(deps);
      const prev = (await orgById(db, orgId))?.logo_url ?? "";
      const fileId = await db.transaction(async (tx) => {
        const id = await saveLogo(deps.logos, tx, now, file);
        await updateOrg(tx, orgId, { logo_url: id, updated_at: iso(now) });
        return id;
      });
      if (isOwnedFile(prev)) await deleteLogo(deps.logos, db, prev);
      return { file_id: fileId };
    },

    async removeLogo(who: Signed, orgId: string) {
      const member = requireOnboarded(who);
      await requireOrgRole(orgId, member, "admin");
      const prev = (await orgById(db, orgId))?.logo_url ?? "";
      if (!prev) return { status: "ok" };
      await updateOrg(db, orgId, { logo_url: null, updated_at: iso(clock(deps)) });
      if (isOwnedFile(prev)) await deleteLogo(deps.logos, db, prev);
      return { status: "ok" };
    },

    /**
     * Org members, then the externals who reach its workspaces. Emails and the per-workspace
     * matrix are for org managers; members see roles only on workspaces they are on themselves.
     */
    async members(who: Signed, orgId: string) {
      const member = requireOnboarded(who);
      const callerRole = await requireOrgRole(orgId, member, "member");
      const canManage = MANAGERS.includes(callerRole);
      const memberships = await orgMembers(db, orgId);
      const internalIds = memberships.map((m) => m.user_id);
      const internal = new Set(internalIds);
      const wsIds = (await orgWorkspaces(db, orgId)).map((w) => w.id);
      const externalIds: string[] = [];
      for (const r of await membershipsIn(db, wsIds, { role: "external" }))
        if (!internal.has(r.user_id) && !externalIds.includes(r.user_id))
          externalIds.push(r.user_id);
      const userIds = [...internalIds, ...externalIds];
      if (!userIds.length) return [];
      const users = new Map((await appUsersByIds(db, userIds)).map((u) => [u.id, u]));
      const av = await avatars(
        db,
        [...users.values()].map((u) => u.directus_user_id),
      );
      const counts = await reachCounts(orgId, internalIds);
      let { roles, ids } = await directRoles(orgId, userIds);
      if (!canManage && wsIds.length) {
        const mine = new Set(
          (await membershipsOfUser(db, member.appUserId, { workspaceIds: wsIds })).map(
            (m) => m.workspace_id,
          ),
        );
        const keep = (rec: Record<string, string>) =>
          Object.fromEntries(Object.entries(rec).filter(([w]) => mine.has(w)));
        roles = new Map([...roles].map(([u, r]) => [u, keep(r)]));
        ids = new Map([...ids].map(([u, r]) => [u, keep(r)]));
      }
      const row = (uid: string, role: string, external: boolean) => {
        const u = users.get(uid);
        const showEmail = external ? canManage : canManage || uid === member.appUserId;
        return {
          user_id: uid,
          app_user_id: uid,
          email: showEmail ? (u?.email ?? "") : "",
          display_name: u?.display_name ?? "",
          avatar: u?.directus_user_id ? (av.get(u.directus_user_id) ?? null) : null,
          role,
          accessible_workspace_count: external
            ? Object.keys(roles.get(uid) ?? {}).length
            : (counts.get(uid) ?? 0),
          is_pending: false,
          is_external: external,
          direct_workspace_roles: roles.get(uid) ?? {},
          direct_workspace_membership_ids: ids.get(uid) ?? {},
        };
      };
      return [
        ...memberships.map((m) => row(m.user_id, m.role, false)),
        ...externalIds.map((uid) => row(uid, "external", true)),
      ];
    },

    /** Pending org and workspace invites, newest first; `workspaceId` narrows to one workspace. */
    async pendingInvites(who: Signed, orgId: string, workspaceId: string | null) {
      const member = requireOnboarded(who);
      const wsRows = await orgWorkspaces(db, orgId);
      // A workspace's own list is also for whoever manages its members, as access requests are.
      const access =
        workspaceId !== null && wsRows.some((w) => w.id === workspaceId)
          ? await resolveWorkspace(deps.accessStore, workspaceId, member, clock(deps))
          : null;
      const managesWorkspace =
        !!access &&
        access.source !== "staff_support" &&
        new WorkspaceContext(member, access).allows("member:manage");
      if (!managesWorkspace) await requireOrgRole(orgId, member, "admin");
      else if ((await orgById(db, orgId))?.deleted_at !== null)
        throw new ForbiddenError("organisation.no_access");
      const now = iso(clock(deps));
      const wsName = new Map(wsRows.map((w) => [w.id, w.name ?? ""]));
      let scope = wsRows.map((w) => w.id);
      let includeOrg = true;
      if (workspaceId !== null) {
        // A workspace of another org answers empty rather than confirming anything.
        if (!wsName.has(workspaceId)) return [];
        scope = [workspaceId];
        includeOrg = false;
      }
      const orgInvites = includeOrg ? await pendingOrgInvites(db, orgId, now) : [];
      const wsInvites = await pendingWorkspaceInvites(db, scope, now);
      if (!orgInvites.length && !wsInvites.length) return [];
      const inviters = new Map(
        (
          await appUsersByIds(
            db,
            [...orgInvites, ...wsInvites].map((i) => i.invited_by ?? ""),
          )
        ).map((u) => [u.id, u]),
      );
      const orgName = includeOrg
        ? (await orgById(db, orgId))?.name || "your organisation"
        : "your organisation";
      const shape = (
        i: (typeof wsInvites)[number] | (typeof orgInvites)[number],
        type: "org" | "workspace",
        subject: string,
      ) => {
        const info = inviters.get(i.invited_by ?? "");
        return {
          id: i.id,
          type,
          email: i.email || "",
          role: i.role || "member",
          workspace_id:
            type === "workspace" ? ((i as { workspace_id: string }).workspace_id ?? null) : null,
          workspace_name:
            type === "workspace"
              ? (wsName.get((i as { workspace_id: string }).workspace_id) ?? "")
              : null,
          created_at: isoTimestamp(i.created_at),
          expires_at: isoTimestamp(i.expires_at),
          invite_url: inviteAcceptUrl({
            type,
            dashboardUrl: deps.dashboardUrl,
            hash: inviteHash(i.id, deps.inviteSecret),
            inviterName: info?.display_name || "Your organisation",
            subjectName: subject,
            role: i.role || "member",
            email: i.email || "",
          }),
          invited_by_id: i.invited_by || null,
          invited_by_name: info?.display_name || null,
          invited_by_email: info?.email || null,
        };
      };
      const combined = [
        ...orgInvites.map((i) => shape(i, "org", orgName)),
        ...wsInvites.map((i) => shape(i, "workspace", wsName.get(i.workspace_id) ?? "")),
      ];
      // Newest first by timestamp text, missing ones last; a stable sort keeps org rows ahead on ties.
      return combined.sort((a, b) => {
        const x = a.created_at ?? "";
        const y = b.created_at ?? "";
        return x < y ? 1 : x > y ? -1 : 0;
      });
    },

    /**
     * Invites to the org without any workspace. Everyone not already a member, with or
     * without an account, gets an invite link valid for seven days to accept or decline.
     */
    async invite(who: Signed, orgId: string, body: { email: string; role: string }) {
      const member = requireOnboarded(who);
      const callerRole = await requireOrgRole(orgId, member, "admin");
      const email = body.email.trim().toLowerCase();
      const role = body.role;
      if ((ROLE_RANK[role as WorkspaceRole] ?? 0) > (ROLE_RANK[callerRole as WorkspaceRole] ?? 0))
        throw new ForbiddenError("member.role_above_own");
      const me = await appUser(db, member.appUserId);
      if (me?.email && me.email.toLowerCase() === email) throw new BadRequestError("invite.self");
      const org = await orgById(db, orgId);
      if (!org || org.deleted_at) throw new NotFoundError("organisation.not_found");
      const orgName = org.name || "your organisation";
      const inviterName = me?.display_name || "An admin";
      const now = clock(deps);

      const directusUser = await directusUserByEmail(db, email);
      const invitee = directusUser ? await appUserByDirectusId(db, directusUser.id) : null;
      if (invitee) {
        if (MANAGERS.includes(role)) await requireNotExternal(orgId, invitee.id);
        const existing = await anyOrgMembership(db, orgId, invitee.id);
        if (existing && existing.deleted_at === null)
          return { status: "already_member", email, email_sent: false, invite_url: null };
      }
      // Anyone not already in the organisation, with or without an account, gets the same
      // pending invite, so the answer never shows an account exists.

      const link = (inviteId: string) =>
        inviteAcceptUrl({
          type: "org",
          dashboardUrl: deps.dashboardUrl,
          hash: inviteHash(inviteId, deps.inviteSecret),
          inviterName,
          subjectName: orgName,
          role,
          email,
        });
      const [pending] = await pendingOrgInvites(db, orgId, iso(now), email);
      if (pending)
        return {
          status: "already_invited",
          email,
          email_sent: false,
          invite_url: link(pending.id),
        };
      const inviteId = newId();
      const url = link(inviteId);
      const expiresAt = iso(new Date(now.getTime() + 7 * 86_400_000));
      await db.transaction(async (tx) => {
        await insertOrgInvite(tx, {
          id: inviteId,
          org_id: orgId,
          email,
          role,
          invited_by: member.appUserId,
          expires_at: expiresAt,
          created_at: iso(now),
        });
        // No account yet, or one we can match by email: theirs, else the inviter's.
        const language =
          (await localeOfEmail(tx, email)) ??
          (await localesOfAppUsers(tx, [member.appUserId])).get(member.appUserId);
        const mail = orgInviteEmail({ inviterName, orgName, role, inviteUrl: url }, language);
        await deps.jobs.enqueue(emailJob, { to: email, ...mail, tags: ["org_invite"] }, { tx });
        if (invitee)
          await emit(tx, now, invitee.id, {
            actor: member.appUserId,
            event: "INVITE_RECEIVED",
            title: `${inviterName} invited you to ${orgName}`,
            message: `Accept the invite to join **${orgName}** as ${role}.`,
            action: "NAVIGATE_INVITE",
            orgId,
            expiresAt,
          });
      });
      return {
        status: "invited",
        email,
        email_sent: true,
        invite_url: url,
      };
    },

    /**
     * The org's workspaces as the caller may see them: managers all, members the open ones,
     * guests only those they are on.
     */
    async workspaces(who: Signed, orgId: string) {
      const member = requireOnboarded(who);
      let callerRole: string | null = null;
      try {
        callerRole = await requireOrgRole(orgId, member, "member");
      } catch (e) {
        if (!(e instanceof ForbiddenError)) throw e;
      }
      const isManager = callerRole !== null && MANAGERS.includes(callerRole);
      let isMember = callerRole !== null;
      if (isMember && !isManager && (await isOrgExternalOnly(db, orgId, member.appUserId)))
        isMember = false;
      let accessible: string[] | null = null;
      if (!isMember) {
        accessible = (await membershipsOfUser(db, member.appUserId)).map((m) => m.workspace_id);
        if (!accessible.length) throw new ForbiddenError("organisation.no_access");
      }
      const rows = await orgWorkspacesForCards(db, orgId, accessible);
      if (!rows.length) return [];
      const accounts = await billingAccountsByIds(
        db,
        rows.map((w) => w.billing_account_id),
      );
      const { projects, members } = await countsByWorkspace(
        db,
        rows.map((w) => w.id),
      );
      const now = iso(clock(deps));
      const out = [];
      for (const ws of rows) {
        const isPrivate = !followsOrgAdmins(ws);
        if (isMember && isPrivate && !isManager) continue;
        const account = accounts.get(ws.billing_account_id) ?? null;
        const tier = account?.tier ?? "";
        let seatsUsed = 0;
        if (capacityOf(tier.toLowerCase())) {
          const [seats] = seatState(await effectiveMembers(db, ws.id));
          const [m, e] = await countPendingInvites(db, ws.id, now);
          seatsUsed = seats + m + e;
        }
        out.push({
          id: ws.id,
          name: ws.name ?? "",
          tier: account ? account.tier : "pioneer",
          is_default: ws.is_default,
          project_count: projects.get(ws.id) ?? 0,
          member_count: members.get(ws.id) ?? 0,
          is_private: isPrivate,
          visibility: ws.visibility || "open_to_organisation",
          bills_separately: account !== null && !account.org_id,
          seat_invite_blocked: false,
          seats_used_including_pending: seatsUsed,
          seat_cap: capacityOf(tier.toLowerCase())?.includedSeats ?? null,
          pinned_projects: (await pinnedProjects(db, ws.id, isManager)).map((p) => ({
            id: p.id,
            name: p.name ?? "",
          })),
        });
      }
      return out;
    },

    /** Changes an org role. Only an owner makes or unmakes an owner; the last manager stays. */
    async changeRole(who: Signed, orgId: string, userId: string, role: string) {
      if (!ORG_ROLES.has(role)) throw new BadRequestError("member.invalid_role");
      const member = requireOnboarded(who);
      const callerRole = await requireOrgRole(orgId, member, "admin");
      const target = isUuid(userId) ? await activeOrgMembership(db, orgId, userId) : null;
      if (!target) throw new NotFoundError("member.not_found");
      if ((role === "owner" || target.role === "owner") && callerRole !== "owner")
        throw new ForbiddenError("member.owner_changes_owner");
      if (MANAGERS.includes(target.role) && !MANAGERS.includes(role)) {
        const others = (await orgMembers(db, orgId, MANAGERS)).filter((m) => m.user_id !== userId);
        if (!others.length) throw new BadRequestError("member.last_admin");
      }
      if (MANAGERS.includes(role)) await requireNotExternal(orgId, userId);
      const now = clock(deps);
      await db.transaction(async (tx) => {
        await updateOrgMembership(tx, target.id, { role, updated_at: iso(now) });
        if (userId !== member.appUserId) {
          const orgName = (await orgById(tx, orgId))?.name || "your organisation";
          await emit(tx, now, userId, {
            actor: member.appUserId,
            event: "ORGANISATION_ROLE_CHANGED",
            title: `Your role in ${orgName} changed`,
            message: `You're now a **${role}** in ${orgName}.`,
            action: "NAVIGATE_ORGANISATION_SETTINGS",
            orgId,
          });
        }
      });
      return { status: "updated", role };
    },

    /**
     * Removes someone from the org and every workspace row they hold in it. A guest with no
     * org row loses their external and observer rows (spec L-11: observers used to survive).
     */
    async removeMember(who: Signed, orgId: string, userId: string) {
      const member = requireOnboarded(who);
      const callerRole = await requireOrgRole(orgId, member, "admin");
      const now = clock(deps);
      const target = isUuid(userId) ? await activeOrgMembership(db, orgId, userId) : null;
      if (!target) {
        const removed = isUuid(userId)
          ? await db.transaction((tx) =>
              softDeleteMembershipsInOrg(tx, orgId, userId, iso(now), ["external", "observer"]),
            )
          : [];
        if (!removed.length) throw new NotFoundError("member.not_found");
        return { status: "removed", workspace_memberships_deleted: removed.length };
      }
      if (target.role === "owner") {
        if (callerRole !== "owner") throw new ForbiddenError("member.owner_removes_owner");
        if ((await countOrgMembers(db, orgId, "owner")) <= 1)
          throw new ConflictError("member.last_owner");
      }
      const affected = await db.transaction(async (tx) => {
        await updateOrgMembership(tx, target.id, { deleted_at: iso(now), updated_at: iso(now) });
        const rows = await softDeleteMembershipsInOrg(tx, orgId, userId, iso(now));
        const wsIds = [...new Set(rows.map((r) => r.workspace_id))];
        for (const a of await distinctAccountsOf(tx, wsIds)) await reconcileSeats(deps.jobs, tx, a);
        if (userId !== member.appUserId) {
          const orgName = (await orgById(tx, orgId))?.name || "the organisation";
          await emit(tx, now, userId, {
            actor: member.appUserId,
            event: "ORGANISATION_REMOVED",
            title: `You were removed from ${orgName}`,
            message:
              "Workspace access that depended on your organisation role has ended. Reach out to a organisation admin if this was unexpected.",
            action: "NONE",
            orgId,
          });
        }
        return rows;
      });
      return { status: "removed", workspace_memberships_deleted: affected.length };
    },

    /**
     * Hours, seats and projects across the org for one calendar month. Admins, owners and
     * billing see every workspace; a plain member only the ones they can reach (spec M-9).
     */
    async usage(who: Signed, orgId: string, monthOffset: number) {
      const member = requireOnboarded(who);
      const role = await requireOrgRole(orgId, member, "member");
      if (monthOffset < 0 || monthOffset > 12)
        throw new BadRequestError("request.month_offset_out_of_range");
      const now = clock(deps);
      const [start, end] = monthBounds(now, monthOffset);
      let workspaces = await orgWorkspaces(db, orgId);
      if (!["admin", "owner", "billing"].includes(role)) {
        const reachable = [];
        for (const w of workspaces)
          if (await resolveWorkspace(deps.accessStore, w.id, member, now)) reachable.push(w);
        workspaces = reachable;
      }
      const accounts = await billingAccountsByIds(
        db,
        workspaces.map((w) => w.billing_account_id),
      );
      const wsIds = workspaces.map((w) => w.id);
      const projects = await projectsIn(db, wsIds);
      const projectCount = projects.filter((p) => !p.deleted_at).length;
      const wsOf = new Map(projects.map((p) => [p.id, p.workspace_id ?? ""]));
      const hours = new Map(wsIds.map((w) => [w, 0]));
      for (const c of await conversationDurationsBetween(
        db,
        projects.map((p) => p.id),
        pyIso(start),
        pyIso(end),
      )) {
        const w = wsOf.get(c.project_id);
        if (w) hours.set(w, (hours.get(w) ?? 0) + pyInt(c.duration) / 3600);
      }
      let totalSeats = 0;
      let totalExternals = 0;
      let totalObservers = 0;
      let totalHours = 0;
      const atCap = 0;
      let approaching = 0;
      const rows = [];
      for (const w of workspaces) {
        const [seats, , externals, observers] = seatState(await effectiveMembers(db, w.id));
        totalSeats += seats;
        totalExternals += externals;
        totalObservers += observers;
        const account = accounts.get(w.billing_account_id) ?? null;
        const billing = commercial(account);
        const tier = billing?.tier ?? "";
        const h = hours.get(w.id) ?? 0;
        totalHours += h;
        const cap = capacityOf(tier);
        const included = cap?.includedHours ?? null;
        const seatsIncluded = cap?.includedSeats ?? null;
        let hoursPct: number | null = null;
        let wsApproaching = false;
        if (cap && cap.includedHours !== null) {
          const pct = cap.includedHours ? h / cap.includedHours : 0;
          hoursPct = pyRound(pct, 3);
          if (pct >= 0.8) {
            approaching++;
            wsApproaching = true;
          }
        }
        const seatsPct =
          seatsIncluded !== null && seatsIncluded > 0 ? pyRound(seats / seatsIncluded, 3) : null;
        const seatCapHit = seatsIncluded !== null && seats >= seatsIncluded;
        rows.push({
          id: w.id,
          name: w.name || "",
          tier,
          is_private: !followsOrgAdmins(w),
          audio_hours: pyRound(h, 2),
          hours_included: included,
          hours_pct: hoursPct,
          hours_over: included !== null ? pyRound(Math.max(0, h - included), 2) : 0,
          seat_count: seats,
          seats_included: seatsIncluded,
          seats_pct: seatsPct,
          seat_cap_hit: seatCapHit,
          approaching_seat_cap: seatsPct !== null && seatsPct >= 0.8 && !seatCapHit,
          external_count: externals,
          observer_count: observers,
          at_cap: false,
          approaching_cap: wsApproaching,
          downgraded_at: isoTimestamp(billing?.downgraded_at),
          bills_separately: account !== null && !account.org_id,
        });
      }
      // Hot workspaces first, then by hours; ties keep their order.
      rows.sort(
        (a, b) =>
          (a.approaching_cap ? 1 : 2) - (b.approaching_cap ? 1 : 2) ||
          b.audio_hours - a.audio_hours,
      );
      return {
        cycle_start: pyIso(start),
        cycle_end_exclusive: pyIso(end),
        workspace_count: workspaces.length,
        total_audio_hours: pyRound(totalHours, 2),
        total_seat_count: totalSeats,
        total_external_count: totalExternals,
        total_observer_count: totalObservers,
        total_project_count: projectCount,
        workspaces_at_cap: atCap,
        workspaces_approaching_cap: approaching,
        workspaces: rows,
      };
    },

    /** Every live project across the org's workspaces, for winding workspaces down. */
    async projects(who: Signed, orgId: string) {
      const member = requireOnboarded(who);
      await requireOrgRole(orgId, member, "admin");
      const wsRows = await orgWorkspaces(db, orgId);
      if (!wsRows.length) return [];
      const wsName = new Map(wsRows.map((w) => [w.id, w.name ?? ""]));
      const projects = await liveProjectsIn(db, [...wsName.keys()]);
      const counts = new Map<string, number>();
      const seconds = new Map<string, number>();
      for (const c of await liveConversationDurations(
        db,
        projects.map((p) => p.id),
      )) {
        counts.set(c.project_id, (counts.get(c.project_id) ?? 0) + 1);
        seconds.set(c.project_id, (seconds.get(c.project_id) ?? 0) + (c.duration ?? 0));
      }
      return projects.flatMap((p) =>
        p.workspace_id && wsName.has(p.workspace_id)
          ? [
              {
                id: p.id,
                name: p.name || "",
                workspace_id: p.workspace_id,
                workspace_name: wsName.get(p.workspace_id) ?? "",
                visibility: p.visibility || "workspace",
                conversation_count: counts.get(p.id) ?? 0,
                audio_hours: pyRound((seconds.get(p.id) ?? 0) / 3600, 1),
                created_at: isoTimestamp(p.created_at),
              },
            ]
          : [],
      );
    },

    /** The partner's own kickback terms; financial, so admins, owners and billing only. */
    async referralLedger(who: Signed, orgId: string) {
      const member = requireOnboarded(who);
      const role = await requireOrgRole(orgId, member, "member");
      if (!["admin", "owner", "billing"].includes(role))
        throw new ForbiddenError("organisation.billing_role_only");
      const rows = await referralLedger(db, orgId);
      if (!rows.length) return [];
      const names = await workspaceNames(db, [...new Set(rows.map((r) => r.workspace_id))]);
      return rows.map((r) => ({
        id: String(r.id),
        workspace_id: r.workspace_id,
        workspace_name: names.get(r.workspace_id) ?? "",
        partner_team_id: r.partner_team_id,
        partner_kickback_percent: r.partner_kickback_percent || 20,
        starts_at: isoTimestamp(r.starts_at) || "",
        expires_at: isoTimestamp(r.expires_at),
        notes: r.notes,
      }));
    },
  };
}
