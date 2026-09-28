import { ForbiddenError, NotFoundError } from "@dembrane/core";
import { type OrgPolicy, orgRoleHas } from "./org";
import { meetsTier, type Policy, roleHas, TIER_REQUIRED } from "./policies";
import {
  type Principal,
  type ProjectAccess,
  resolveProject,
  resolveWorkspace,
  type WorkspaceAccess,
} from "./resolve";
import type { AccessStore } from "./store";

/** The old API's text for a role that lacks the policy. */
const NO_PERMISSION = "You do not have permission to do this";

/**
 * The only way a service obtains access to a workspace or project. No access answers 404,
 * so the existence of a resource is never revealed; a missing policy answers 403; a tier
 * gate answers 403 naming the tier, which is what the frontend shows.
 */
export class Access {
  constructor(private readonly store: AccessStore) {}

  async project(
    who: Principal,
    projectId: string,
    policy: Policy,
    now = new Date(),
  ): Promise<ProjectAccess> {
    const access = await resolveProject(this.store, projectId, who, now);
    if (!access) throw new NotFoundError("project.not_found");
    check(access.role, policy, access.extra, access.tier, access.limitedTo);
    return access;
  }

  /**
   * Org-level access for the customer account. Not a member (or no app_user yet): 404, as
   * for workspaces. A member whose role lacks the policy: 403.
   */
  async org(who: Principal, orgId: string, policy: OrgPolicy): Promise<{ role: string }> {
    const role = who.appUserId ? await this.store.orgRole(orgId, who.appUserId) : null;
    if (!role) throw new NotFoundError("organisation.not_found");
    if (!orgRoleHas(role, policy))
      throw new ForbiddenError("access.forbidden", { message: NO_PERMISSION });
    return { role };
  }

  async workspace(
    who: Principal,
    workspaceId: string,
    policy: Policy,
    now = new Date(),
  ): Promise<WorkspaceAccess> {
    const access = await resolveWorkspace(this.store, workspaceId, who, now);
    if (!access) throw new NotFoundError("workspace.not_found");
    check(access.role, policy, access.extra, access.workspace.tier, access.limitedTo);
    return access;
  }
}

function check(
  role: ProjectAccess["role"],
  policy: Policy,
  extra: readonly Policy[],
  tier: string | null,
  limitedTo?: ReadonlySet<Policy>,
) {
  if (limitedTo && !limitedTo.has(policy))
    throw new ForbiddenError("access.support_session_limited");
  if (!roleHas(role, policy, extra))
    throw new ForbiddenError("access.forbidden", { message: NO_PERMISSION });
  const required = TIER_REQUIRED[policy];
  if (required && !meetsTier(tier, required)) {
    throw new ForbiddenError("billing.tier_required", {
      params: { required, tier },
      message: `This action requires the ${required} tier`,
      details: { requiredTier: required },
    });
  }
}
