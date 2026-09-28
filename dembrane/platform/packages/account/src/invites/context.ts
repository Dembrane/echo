import {
  DrizzleAccessStore,
  meetsTier,
  type Policy,
  resolveWorkspace,
  roleHas,
  TIER_REQUIRED,
  type WorkspaceAccess,
} from "@dembrane/access";
import { ForbiddenError, NotFoundError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { isUuid } from "./storage";

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
  if (!who.appUserId) throw new ForbiddenError("access.not_onboarded");
  if (!isUuid(workspaceId)) throw new NotFoundError("workspace.not_found");
  const access = await resolveWorkspace(new DrizzleAccessStore(db), workspaceId, who, now);
  if (!access) throw new NotFoundError("workspace.not_found");
  return { ...access, appUserId: who.appUserId };
}

/** The resolver's policy and tier rules, answered with the old API's "Access denied". */
export function requirePolicy(access: WorkspaceAccess, policy: Policy): void {
  if (!hasPolicy(access, policy))
    throw new ForbiddenError("access.forbidden", { message: "Access denied" });
}

export function hasPolicy(access: WorkspaceAccess, policy: Policy): boolean {
  const tier = TIER_REQUIRED[policy];
  return (
    roleHas(access.role, policy, access.extra) && (!tier || meetsTier(access.workspace.tier, tier))
  );
}
