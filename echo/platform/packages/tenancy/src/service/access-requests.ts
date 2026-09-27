import { resolveWorkspace } from "@echo/access";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, newId } from "@echo/core";
import type { Signed } from "@echo/http";
import { isoTimestamp } from "@echo/legacy-shape";
import { requireOnboarded, WorkspaceContext } from "../context";
import { type Conn, iso } from "../db";
import { clock, type TenancyDeps } from "../deps";
import { derivationView, workspaceAdmins } from "../members";
import { emit, emitToAll, orgAdmins } from "../notify";
import {
  accessRequestById,
  insertAccessRequest,
  pendingRequestFor,
  pendingRequests,
  pendingRequestsOfUser,
  updateAccessRequest,
} from "../storage/access-requests";
import { countsByWorkspace } from "../storage/orgs";
import { appUsersByIds } from "../storage/people";
import {
  activeMembership,
  discoverableWorkspaces,
  insertMembership,
  membershipsOfUser,
  orgRole,
  orgWorkspaces,
  workspaceById,
} from "../storage/tenancy";

const INTERNAL = new Set(["member", "billing", "admin", "owner"]);
const OUTSIDER = new Set(["external", "observer"]);

/** Roles the user holds on live workspaces of the org. */
async function rolesInOrg(db: Conn, orgId: string, userId: string) {
  const ids = (await orgWorkspaces(db, orgId)).map((w) => w.id);
  return (await membershipsOfUser(db, userId, { workspaceIds: ids })).map((m) => m.role);
}

/**
 * An outsider in this org: no admin, owner or billing org role, at least one external or
 * observer row, and no internal row. Robust to a stale org row left behind on conversion.
 */
export async function isOrgExternalOnly(db: Conn, orgId: string, userId: string) {
  const role = await orgRole(db, orgId, userId);
  if (role && ["admin", "owner", "billing"].includes(role)) return false;
  const roles = await rolesInOrg(db, orgId, userId);
  return roles.some((r) => OUTSIDER.has(r)) && !roles.some((r) => INTERNAL.has(r));
}

/** Finance-only people: an org biller, or billing rows with no operational role in the org. */
export async function isOrgBillingOnly(db: Conn, orgId: string, userId: string) {
  const role = await orgRole(db, orgId, userId);
  if (role === "billing") return true;
  if (role === "admin" || role === "owner") return false;
  const roles = await rolesInOrg(db, orgId, userId);
  return roles.includes("billing") && !roles.some((r) => ["member", "admin", "owner"].includes(r));
}

export function accessRequestService(deps: TenancyDeps) {
  const { db } = deps;

  async function loadWorkspace(id: string) {
    const ws = await workspaceById(db, id);
    if (!ws || ws.deleted_at) throw new NotFoundError("Workspace not found");
    return ws;
  }

  /**
   * Approving is for whoever manages the workspace's members (resolved by @echo/access, so an
   * expired support grant no longer counts, spec L-9) or an org admin or owner. A staff
   * support session never decides who joins (CTO Q4).
   */
  async function requireCanAction(
    who: Signed & { appUserId: string },
    wsId: string,
    orgId: string,
  ) {
    const access = await resolveWorkspace(deps.accessStore, wsId, who, clock(deps));
    if (access && access.source !== "staff_support") {
      const ctx = new WorkspaceContext(who, access);
      if (ctx.allows("member:manage")) return;
    }
    const role = await orgRole(db, orgId, who.appUserId);
    if (role === "admin" || role === "owner") return;
    throw new ForbiddenError("Access denied");
  }

  async function loadPending(wsId: string, reqId: string) {
    const req = await accessRequestById(db, reqId);
    if (!req || req.deleted_at || req.workspace_id !== wsId)
      throw new NotFoundError("Request not found");
    if (req.status !== "pending") throw new ConflictError("Request already actioned");
    return req;
  }

  return {
    /**
     * An org admin or owner joins a workspace of their org as admin, no approval. Invite-only
     * is open to them; a private workspace only to the org owner; a removal tombstone to
     * nobody (spec M-14, CTO Q3).
     */
    async join(who: Signed, workspaceId: string) {
      const member = requireOnboarded(who);
      const now = clock(deps);
      const ws = await loadWorkspace(workspaceId);
      const role = await orgRole(db, ws.org_id, member.appUserId);
      if (role !== "admin" && role !== "owner")
        throw new ForbiddenError("Organisation admins only");
      if (await activeMembership(db, ws.id, member.appUserId))
        return { status: "already_member", workspace_id: ws.id, role: "admin" };
      const view = derivationView(ws);
      if (view.stickyRemoved.includes(member.appUserId))
        throw new ForbiddenError(
          "You were removed from this workspace. Ask a workspace admin to invite you back.",
        );
      if (view.visibility === "private" && role !== "owner")
        throw new ForbiddenError("This workspace is private. Ask a workspace admin to invite you.");
      await db.transaction(async (tx) => {
        await insertMembership(tx, {
          id: newId(),
          workspace_id: ws.id,
          user_id: member.appUserId,
          role: "admin",
          source: "direct",
          created_at: iso(now),
          updated_at: iso(now),
        });
        // A quiet entry in the joiner's own feed; joining one's own org's workspace is not news.
        await emit(tx, now, member.appUserId, {
          actor: member.appUserId,
          event: "WORKSPACE_JOINED",
          title: `You joined ${ws.name || "a workspace"}`,
          message: "You're in as an admin.",
          action: "NAVIGATE_WS",
          workspaceId: ws.id,
          orgId: ws.org_id,
        });
      });
      return { status: "joined", workspace_id: ws.id, role: "admin" };
    },

    /** An org member asks to join an open workspace; its managers and the org admins are told. */
    async request(who: Signed, workspaceId: string) {
      const member = requireOnboarded(who);
      const now = clock(deps);
      const ws = await loadWorkspace(workspaceId);
      // Anything but open answers as missing, so a restricted workspace's existence stays hidden.
      if (ws.visibility !== "open_to_organisation") throw new NotFoundError("Workspace not found");
      const role = await orgRole(db, ws.org_id, member.appUserId);
      if (role === null) throw new ForbiddenError("Not a member of this organisation");
      if (role === "admin" || role === "owner")
        throw new BadRequestError("Organisation admins can join directly, no approval needed");
      if (await isOrgExternalOnly(db, ws.org_id, member.appUserId))
        throw new ForbiddenError("Not a member of this organisation");
      if (await activeMembership(db, ws.id, member.appUserId))
        return { status: "already_member", request_id: null };
      const pending = await pendingRequestFor(db, ws.id, member.appUserId);
      if (pending) return { status: "already_pending", request_id: pending.id };
      const id = newId();
      await db.transaction(async (tx) => {
        await insertAccessRequest(tx, {
          id,
          workspace_id: ws.id,
          user_id: member.appUserId,
          status: "pending",
          requested_at: iso(now),
        });
        const audience = [
          ...new Set([...(await workspaceAdmins(tx, ws.id)), ...(await orgAdmins(tx, ws.org_id))]),
        ].sort();
        const [me] = await appUsersByIds(tx, [member.appUserId]);
        const requester = me?.display_name || me?.email || "Someone";
        const wsName = ws.name || "a workspace";
        await emitToAll(tx, now, audience, {
          actor: member.appUserId,
          event: "MEMBERSHIP_REQUESTED",
          title: `${requester} wants to join ${wsName}`,
          message: `${requester} requested access. Approve from the workspace members tab.`,
          action: "NAVIGATE_WORKSPACE_SETTINGS",
          workspaceId: ws.id,
          orgId: ws.org_id,
        });
      });
      return { status: "submitted", request_id: id };
    },

    async list(who: Signed, workspaceId: string) {
      const member = requireOnboarded(who);
      const ws = await loadWorkspace(workspaceId);
      await requireCanAction(member, ws.id, ws.org_id);
      const rows = await pendingRequests(db, ws.id);
      const users = new Map(
        (
          await appUsersByIds(
            db,
            rows.map((r) => r.user_id),
          )
        ).map((u) => [u.id, u]),
      );
      return {
        requests: rows.map((r) => ({
          id: r.id,
          workspace_id: r.workspace_id,
          user_id: r.user_id,
          user_display_name: users.get(r.user_id)?.display_name ?? null,
          user_email: users.get(r.user_id)?.email ?? null,
          status: r.status || "pending",
          requested_at: isoTimestamp(r.requested_at) || "",
        })),
      };
    },

    /** Grants a direct row (billing for finance-only people, member otherwise) and tells the requester. */
    async approve(who: Signed, workspaceId: string, requestId: string) {
      const member = requireOnboarded(who);
      const now = clock(deps);
      const ws = await loadWorkspace(workspaceId);
      await requireCanAction(member, ws.id, ws.org_id);
      const req = await loadPending(ws.id, requestId);
      await db.transaction(async (tx) => {
        if (!(await activeMembership(tx, ws.id, req.user_id))) {
          const role = (await isOrgBillingOnly(tx, ws.org_id, req.user_id)) ? "billing" : "member";
          await insertMembership(tx, {
            id: newId(),
            workspace_id: ws.id,
            user_id: req.user_id,
            role,
            source: "direct",
            created_at: iso(now),
            updated_at: iso(now),
          });
        }
        await updateAccessRequest(tx, req.id, {
          status: "approved",
          actioned_at: iso(now),
          actioned_by: member.appUserId,
        });
        const wsName = ws.name || "a workspace";
        await emit(tx, now, req.user_id, {
          actor: member.appUserId,
          event: "MEMBERSHIP_REQUEST_APPROVED",
          title: `You're in ${wsName}`,
          message: `Your request to join ${wsName} was approved.`,
          action: "NAVIGATE_WS",
          workspaceId: ws.id,
          orgId: ws.org_id,
        });
      });
      return { status: "approved" };
    },

    /** Silent by design: the requester is not told. */
    async reject(who: Signed, workspaceId: string, requestId: string) {
      const member = requireOnboarded(who);
      const now = clock(deps);
      const ws = await loadWorkspace(workspaceId);
      await requireCanAction(member, ws.id, ws.org_id);
      const req = await loadPending(ws.id, requestId);
      await updateAccessRequest(db, req.id, {
        status: "rejected",
        actioned_at: iso(now),
        actioned_by: member.appUserId,
      });
      return { status: "rejected" };
    },

    /** Workspaces of an org the caller could join (admins: all) or request (members: open ones). */
    async discoverable(who: Signed, orgId: string) {
      const member = requireOnboarded(who);
      const role = await orgRole(db, orgId, member.appUserId);
      if (role === null) throw new ForbiddenError("Not a member of this organisation");
      if (await isOrgExternalOnly(db, orgId, member.appUserId)) return { workspaces: [] };
      const isAdmin = role === "admin" || role === "owner";
      const rows = await discoverableWorkspaces(db, orgId, !isAdmin);
      const ids = rows.map((w) => w.id);
      const direct = new Set(
        (await membershipsOfUser(db, member.appUserId, { workspaceIds: ids })).map(
          (m) => m.workspace_id,
        ),
      );
      const pending = new Map<string, string>();
      if (!isAdmin)
        for (const r of await pendingRequestsOfUser(db, ids, member.appUserId))
          pending.set(r.workspace_id, r.id);
      const counts = (await countsByWorkspace(db, ids)).members;
      return {
        workspaces: rows.map((w) => ({
          id: w.id,
          name: w.name || "",
          visibility: w.visibility || "open_to_organisation",
          action: direct.has(w.id)
            ? "member"
            : isAdmin
              ? "join"
              : pending.has(w.id)
                ? "pending"
                : "request-access",
          pending_request_id: !direct.has(w.id) && !isAdmin ? (pending.get(w.id) ?? null) : null,
          member_count: counts.get(w.id) ?? 0,
        })),
      };
    },
  };
}
