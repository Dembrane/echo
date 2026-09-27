import { ConflictError, NotFoundError } from "@echo/core";
import { isoTimestamp, pythonIso } from "@echo/legacy-shape";
import type { WorkspaceContext } from "../context";
import { iso } from "../db";
import { clock, type TenancyDeps } from "../deps";
import { appUsersByIds } from "../storage/people";
import {
  cancelPendingTasks,
  pendingSupportRequests,
  supportEvents,
  supportRequest,
  updateSupportRequest,
} from "../storage/support";
import { grantSupportMembership, recordSupportEvent } from "../support";

/** The customer's side of staff support access: the audit trail, and approving or denying requests. */
export function supportAccessService(deps: TenancyDeps) {
  const { db } = deps;
  const support = { jobs: deps.jobs, dashboardUrl: deps.dashboardUrl };

  async function names(ids: readonly (string | null)[]) {
    const rows = await appUsersByIds(
      db,
      ids.filter((i): i is string => Boolean(i)),
    );
    return new Map(rows.map((r) => [r.id, r.display_name ?? ""]));
  }

  /**
   * A still-pending request of this workspace. One whose seven days ran out is expired here
   * and committed before the 409, so the lazy expiry sticks even though the call fails.
   */
  async function loadPending(ctx: WorkspaceContext, requestId: string) {
    const req = await supportRequest(db, requestId);
    if (!req || req.workspace_id !== ctx.workspaceId) throw new NotFoundError("Request not found");
    if (req.status !== "pending") throw new ConflictError(`Request is already ${req.status}.`);
    const now = clock(deps);
    if (req.expires_at && new Date(req.expires_at).getTime() <= now.getTime()) {
      await db.transaction(async (tx) => {
        await updateSupportRequest(tx, req.id, { status: "expired", resolved_at: iso(now) });
        await recordSupportEvent(support, tx, now, {
          workspaceId: ctx.workspaceId,
          event: "request_expired",
          staff: req.requested_by,
          params: { request_id: req.id },
        });
      });
      throw new ConflictError("Request expired.");
    }
    return req;
  }

  return {
    async events(ctx: WorkspaceContext, page: number, limit: number) {
      ctx.require("settings:manage");
      const rows = await supportEvents(db, ctx.workspaceId, limit + 1, (page - 1) * limit);
      const hasMore = rows.length > limit;
      const shown = rows.slice(0, limit);
      const n = await names(shown.flatMap((r) => [r.actor_user_id, r.staff_user_id]));
      return {
        events: shown.map((r) => ({
          id: r.id,
          event_code: r.event_code || "",
          created_at: isoTimestamp(r.created_at),
          actor_name: n.get(r.actor_user_id ?? "") || null,
          staff_name: n.get(r.staff_user_id ?? "") || null,
          params: (r.params as Record<string, unknown> | null) || {},
        })),
        has_more: hasMore,
      };
    },

    async requests(ctx: WorkspaceContext) {
      ctx.require("settings:manage");
      const rows = await pendingSupportRequests(db, ctx.workspaceId);
      const n = await names(rows.map((r) => r.requested_by));
      return {
        requests: rows.map((r) => ({
          id: r.id,
          requested_by_name: n.get(r.requested_by) || "dembrane staff",
          message: r.message,
          created_at: isoTimestamp(r.created_at),
          expires_at: isoTimestamp(r.expires_at),
        })),
      };
    },

    /** A one-off 24 hour grant; the standing consent toggle stays as it is. */
    async approve(ctx: WorkspaceContext, requestId: string) {
      ctx.require("settings:manage");
      ctx.requireCustomer();
      const req = await loadPending(ctx, requestId);
      const now = clock(deps);
      const ws = ctx.access.workspace;
      const grant = await db.transaction(async (tx) => {
        const g = await grantSupportMembership(tx, now, {
          workspaceId: ctx.workspaceId,
          appUserId: req.requested_by,
          orgId: ws.orgId,
        });
        await updateSupportRequest(tx, req.id, {
          status: "approved",
          resolved_at: iso(now),
          resolved_by: ctx.who.appUserId,
          membership_id: g.membershipId,
        });
        await cancelPendingTasks(tx, iso(now), "expire_support_access_request", {
          request_id: req.id,
        });
        await recordSupportEvent(support, tx, now, {
          workspaceId: ctx.workspaceId,
          event: "request_approved",
          actor: ctx.who.appUserId,
          staff: req.requested_by,
          params: {
            request_id: req.id,
            membership_id: g.membershipId,
            expires_at: pythonTime(g.expiresAt),
          },
        });
        return g;
      });
      return { status: "approved", expires_at: pythonTime(grant.expiresAt) };
    },

    async deny(ctx: WorkspaceContext, requestId: string) {
      ctx.require("settings:manage");
      ctx.requireCustomer();
      const req = await loadPending(ctx, requestId);
      const now = clock(deps);
      await db.transaction(async (tx) => {
        await updateSupportRequest(tx, req.id, {
          status: "denied",
          resolved_at: iso(now),
          resolved_by: ctx.who.appUserId,
        });
        await cancelPendingTasks(tx, iso(now), "expire_support_access_request", {
          request_id: req.id,
        });
        await recordSupportEvent(support, tx, now, {
          workspaceId: ctx.workspaceId,
          event: "request_denied",
          actor: ctx.who.appUserId,
          staff: req.requested_by,
          params: { request_id: req.id },
        });
      });
      return { status: "denied", expires_at: null };
    },
  };
}

/** The old API computed this instant in Python and printed it with isoformat(). */
function pythonTime(isoValue: string | null): string | null {
  return isoValue ? pythonIso(new Date(isoValue)) : null;
}
