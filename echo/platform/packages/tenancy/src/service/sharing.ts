import {
  meetsTier,
  resolveWorkspace,
  roleHas,
  TIER_REQUIRED,
  type WorkspaceAccess,
} from "@echo/access";
import { BadRequestError, ForbiddenError, NotFoundError, newId } from "@echo/core";
import type { Signed } from "@echo/http";
import { isoTimestamp } from "@echo/legacy-shape";
import { type Member, requireOnboarded } from "../context";
import { iso } from "../db";
import { clock, type TenancyDeps } from "../deps";
import { effectiveMembers } from "../members";
import { emit } from "../notify";
import { pendingWorkspaceInvites } from "../storage/invites";
import { appUser, appUserByEmail, appUsersByIds, avatars } from "../storage/people";
import {
  deleteShares,
  insertShare,
  projectById,
  shareRowIds,
  sharesOfProject,
} from "../storage/projects";
import { workspaceById } from "../storage/tenancy";

const NOT_A_MEMBER = "not_a_member";
const SHARE_TIER = TIER_REQUIRED["project:share"] ?? "innovator";

/**
 * Sharing a private project with people already on its workspace (never across
 * workspaces). A share only unlocks the project; what the person may do there is their
 * workspace role.
 */
export function sharingService(deps: TenancyDeps) {
  const { db } = deps;

  async function loadProject(id: string) {
    const p = await projectById(db, id);
    if (!p || p.deleted_at) throw new NotFoundError("Project not found");
    return p;
  }

  async function workspaceAccess(
    member: Member,
    workspaceId: string | null,
  ): Promise<WorkspaceAccess> {
    if (!workspaceId) throw new BadRequestError("Project is not attached to a workspace");
    const access = await resolveWorkspace(deps.accessStore, workspaceId, member, clock(deps));
    if (!access) throw new ForbiddenError("No access to this project");
    return access;
  }

  /** The caller may share (role first, so a non-admin is refused even on a lapsed plan); tier reported, not raised. */
  async function shareAdmin(member: Member, workspaceId: string | null) {
    const access = await workspaceAccess(member, workspaceId);
    if (!roleHas(access.role, "project:share", access.extra))
      throw new ForbiddenError("Only workspace admins can share projects");
    const ws = await workspaceById(db, access.workspace.id);
    if (!ws) throw new NotFoundError("Workspace not found");
    return { access, ws, tierOk: meetsTier(access.workspace.tier ?? "pioneer", SHARE_TIER) };
  }

  async function requireShareAdmin(member: Member, workspaceId: string | null) {
    const r = await shareAdmin(member, workspaceId);
    if (!r.tierOk)
      throw new ForbiddenError(`Private project sharing requires the ${SHARE_TIER} plan or above.`);
    // A staff support session reads; it never changes who can see customer data (CTO Q4).
    if (r.access.source === "staff_support") throw new ForbiddenError("Access denied");
    return r;
  }

  async function shareView(
    row: { user_id: string; granted_by: string | null; created_at: string | null },
    workspaceRole: string | null,
  ) {
    const u = await appUser(db, row.user_id);
    if (!u) return null;
    const av = await avatars(db, [u.directus_user_id]);
    return {
      user_id: row.user_id,
      email: u.email ?? "",
      display_name: u.display_name ?? "",
      avatar: av.get(u.directus_user_id ?? "") ?? null,
      workspace_role: workspaceRole,
      granted_by: row.granted_by,
      created_at: isoTimestamp(row.created_at),
    };
  }

  return {
    /**
     * Who the project is shared with. Emails of a private project's shares are for workspace
     * admins and the shared people themselves. Workspace billing has no project access at
     * all (spec M-4).
     */
    async list(who: Signed, projectId: string) {
      const member = requireOnboarded(who);
      const p = await loadProject(projectId);
      const access = await workspaceAccess(member, p.workspace_id);
      if (!roleHas(access.role, "project:read", access.extra))
        throw new ForbiddenError("No access to this project");
      const readerIsAdmin = access.role === "admin" || access.role === "owner";
      const isPrivate = p.visibility === "private";
      const rows = await sharesOfProject(db, p.id);
      if (!rows.length) return [];
      const roles = new Map(
        (await effectiveMembers(db, access.workspace.id)).map((m) => [m.user_id, m.role]),
      );
      const users = new Map(
        (
          await appUsersByIds(
            db,
            rows.map((r) => r.user_id),
          )
        ).map((u) => [u.id, u]),
      );
      const av = await avatars(
        db,
        [...users.values()].map((u) => u.directus_user_id),
      );
      return rows.flatMap((r) => {
        const role = roles.get(r.user_id);
        const u = users.get(r.user_id);
        // A share of someone no longer on the workspace is stale and not shown.
        if (role === undefined || !u) return [];
        const hideEmail = isPrivate && !readerIsAdmin && r.user_id !== member.appUserId;
        return [
          {
            user_id: r.user_id,
            email: hideEmail ? "" : (u.email ?? ""),
            display_name: u.display_name ?? "",
            avatar: av.get(u.directus_user_id ?? "") ?? null,
            workspace_role: role,
            granted_by: r.granted_by,
            created_at: isoTimestamp(r.created_at),
          },
        ];
      });
    },

    /** Pending workspace invites that share this project on accept. Empty on a lapsed plan. */
    async invites(who: Signed, projectId: string) {
      const member = requireOnboarded(who);
      const p = await loadProject(projectId);
      const { ws, tierOk } = await shareAdmin(member, p.workspace_id);
      if (!tierOk) return [];
      const rows = await pendingWorkspaceInvites(db, [ws.id], iso(clock(deps)), {
        projectId: p.id,
      });
      return rows.map((r) => ({
        id: r.id,
        email: r.email || "",
        role: r.role || "member",
        created_at: isoTimestamp(r.created_at),
        expires_at: isoTimestamp(r.expires_at),
      }));
    },

    async add(who: Signed, projectId: string, rawEmail: string) {
      const member = requireOnboarded(who);
      const p = await loadProject(projectId);
      if (p.visibility !== "private")
        throw new BadRequestError(
          "This project is visible to the whole workspace. Mark it private before adding individual shares.",
        );
      const { ws } = await requireShareAdmin(member, p.workspace_id);
      const email = rawEmail.trim().toLowerCase();
      const invitee = await appUserByEmail(db, email);
      if (!invitee)
        throw new NotFoundError("not a member", {
          code: NOT_A_MEMBER,
          message: "That email isn't on this workspace. Invite them to the workspace first.",
        });
      const inviteeAccess = await resolveWorkspace(
        deps.accessStore,
        ws.id,
        { appUserId: invitee.id, directusUserId: invitee.directus_user_id ?? "" },
        clock(deps),
      );
      if (!inviteeAccess)
        throw new NotFoundError("not a member", {
          code: NOT_A_MEMBER,
          message: "That person isn't in this workspace. Invite them first.",
        });
      if (!roleHas(inviteeAccess.role, "project:read"))
        throw new BadRequestError("role cannot access projects", {
          code: "role_cannot_access_projects",
          message: "Billing members can't open projects. Give them another role first.",
        });
      const now = clock(deps);
      await db.transaction(async (tx) => {
        if ((await shareRowIds(tx, p.id, invitee.id)).length) return;
        await insertShare(tx, {
          id: newId(),
          project_id: p.id,
          user_id: invitee.id,
          granted_by: member.appUserId,
          created_at: iso(now),
        });
        if (invitee.id !== member.appUserId)
          await emit(tx, now, invitee.id, {
            actor: member.appUserId,
            event: "PROJECT_SHARE_ADDED",
            title: `${p.name || "a project"} was shared with you`,
            message: `You now have access to this project in ${ws.name ?? "its workspace"}.`,
            action: "NAVIGATE_PROJECT",
            projectId: p.id,
            workspaceId: ws.id,
          });
      });
      return shareView(
        { user_id: invitee.id, granted_by: member.appUserId, created_at: null },
        inviteeAccess.role,
      );
    },

    /** Hard delete of every share row for the pair, so a duplicate cannot survive (spec L-13). */
    async revoke(who: Signed, projectId: string, userId: string) {
      const member = requireOnboarded(who);
      const p = await loadProject(projectId);
      await requireShareAdmin(member, p.workspace_id);
      const ids = await shareRowIds(db, p.id, userId);
      if (!ids.length) throw new NotFoundError("Share not found");
      const now = clock(deps);
      await db.transaction(async (tx) => {
        await deleteShares(tx, ids);
        if (userId !== member.appUserId)
          await emit(tx, now, userId, {
            actor: member.appUserId,
            event: "PROJECT_SHARE_REVOKED",
            title: `Your access to ${p.name || "a project"} was revoked`,
            message: "Ask the project owner if you still need access.",
            action: "NONE",
            projectId: p.id,
            workspaceId: p.workspace_id,
          });
      });
      return { status: "revoked" };
    },
  };
}
