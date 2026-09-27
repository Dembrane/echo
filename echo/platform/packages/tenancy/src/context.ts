import {
  type AccessStore,
  meetsTier,
  type Policy,
  resolveWorkspace,
  roleHas,
  TIER_REQUIRED,
  type WorkspaceAccess,
} from "@echo/access";
import { ForbiddenError, NotFoundError } from "@echo/core";
import type { Signed } from "@echo/http";
import { isUuid } from "./db";

/** A signed-in caller who has an app_user row. */
export interface Member extends Signed {
  readonly appUserId: string;
}

/** 403 with the old API's text for a signed-in user who never onboarded. */
export function requireOnboarded(who: Signed): Member {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  return who as Member;
}

/**
 * What the old API's `get_workspace_context` hands a route: the caller's resolved role on
 * the workspace. Resolution and every policy decision come from @echo/access; this only
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

  /** Role, custom policies and the tier gate, as access decides them. */
  allows(policy: Policy): boolean {
    if (!roleHas(this.access.role, policy, this.access.extra)) return false;
    const required = TIER_REQUIRED[policy];
    return !required || meetsTier(this.access.workspace.tier, required);
  }

  require(policy: Policy): void {
    if (!this.allows(policy)) throw new ForbiddenError("Access denied");
  }

  /**
   * Consent, membership and approval decisions belong to the customer. A staff support
   * grant reads and helps but never makes them (spec H-13, CTO Q4).
   */
  requireCustomer(): void {
    if (this.isSupportSession) throw new ForbiddenError("Access denied");
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
  if (!ws || ws.deleted) throw new NotFoundError("Workspace not found");
  const access = await resolveWorkspace(store, workspaceId, member, now);
  if (!access) throw new ForbiddenError("No access to this workspace");
  return new WorkspaceContext(member, access);
}
