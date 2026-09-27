import {
  DrizzleAccessStore,
  meetsTier,
  type Policy,
  resolveWorkspace,
  roleHas,
  TIER_REQUIRED,
  type WorkspaceAccess,
} from "@echo/access";
import { ForbiddenError, NotFoundError } from "@echo/core";
import type { Db } from "@echo/db";
import type { Signed } from "@echo/http";

/**
 * The workspace a route acts on and the caller's role there, from the access resolver.
 * Split from the policy check because the old API resolved access before validating the
 * body and checked the policy after, and callers see that order (a bad body from a member
 * without the policy is a 422, not a 403). No access answers 404, never revealing that the
 * workspace exists.
 */
export async function workspaceAccess(
  db: Db,
  who: Signed,
  workspaceId: string,
  now: Date,
): Promise<WorkspaceAccess & { appUserId: string }> {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  const access = await resolveWorkspace(new DrizzleAccessStore(db), workspaceId, who, now);
  if (!access) throw new NotFoundError("Workspace not found");
  return { ...access, appUserId: who.appUserId };
}

/** The resolver's policy and tier rules, answered with the old API's "Access denied". */
export function requirePolicy(access: WorkspaceAccess, policy: Policy): void {
  if (!hasPolicy(access, policy)) throw new ForbiddenError("Access denied");
}

export function hasPolicy(access: WorkspaceAccess, policy: Policy): boolean {
  const tier = TIER_REQUIRED[policy];
  return (
    roleHas(access.role, policy, access.extra) && (!tier || meetsTier(access.workspace.tier, tier))
  );
}
