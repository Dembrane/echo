import {
  type AccessStore,
  meetsTier,
  type Policy,
  resolveWorkspace,
  roleHas,
  TIER_REQUIRED,
  type WorkspaceAccess,
} from "@dembrane/access";
import { ForbiddenError, NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { isUuid } from "./db";

/** A signed-in caller who has an app_user row. */
export interface Member extends Signed {
  readonly appUserId: string;
}

/** 403 with the old API's text for a signed-in user who never onboarded. */
export function requireOnboarded(who: Signed): Member {
  if (!who.appUserId) throw new ForbiddenError("access.not_onboarded");
  return who as Member;
}

/**
 * What the old API's `get_workspace_context` hands a route: the caller's resolved role on
 * the workspace. Resolution and every policy decision come from @dembrane/access; this only
 * keeps the old status codes and texts (404 missing, 403 no access, 403 "Access denied").
 */
export class WorkspaceContext {
  constructor(
    readonly who: Member,
    readonly access: WorkspaceAccess,
  ) {}

  get workspaceId() {
    return this.access.workspace.id;
  }
  get role() {
    return this.access.role;
  }
  get tier() {
    return this.access.workspace.tier;
  }
  /** A staff member holding a temporary support grant. */
  get isSupportSession() {
    return this.access.source === "staff_support";
  }

  /** A support visit's limits, role, custom policies and the tier gate, as access decides them. */
  allows(policy: Policy): boolean {
    if (this.limits(policy)) return false;
    if (!roleHas(this.access.role, policy, this.access.extra)) return false;
    const required = TIER_REQUIRED[policy];
    return !required || meetsTier(this.access.workspace.tier, required);
  }

  require(policy: Policy): void {
    // The code Access.check gives, so the dashboard says why a support visit may not.
    if (this.limits(policy))
      throw new ForbiddenError("access.support_session_limited", { message: "Access denied" });
    if (!this.allows(policy))
      throw new ForbiddenError("access.forbidden", { message: "Access denied" });
  }

  private limits(policy: Policy): boolean {
    return Boolean(this.access.limitedTo && !this.access.limitedTo.has(policy));
  }

  /**
   * Consent, membership and approval decisions belong to the customer. A staff support
   * grant reads and helps but never makes them (spec H-13, CTO Q4).
   */
  requireCustomer(): void {
    if (this.isSupportSession)
      throw new ForbiddenError("access.support_session_limited", { message: "Access denied" });
  }
}

export async function workspaceContext(
  store: AccessStore,
  who: Signed,
  workspaceId: string,
  now: Date,
): Promise<WorkspaceContext> {
  const member = requireOnboarded(who);
  const ws = isUuid(workspaceId) ? await store.workspace(workspaceId) : null;
  if (!ws || ws.deleted) throw new NotFoundError("workspace.not_found");
  const access = await resolveWorkspace(store, workspaceId, member, now);
  // A workspace held back for a demo is not there yet for the organisation's people.
  if (!access)
    throw ws.held
      ? new NotFoundError("workspace.not_found")
      : new ForbiddenError("workspace.no_access");
  return new WorkspaceContext(member, access);
}
