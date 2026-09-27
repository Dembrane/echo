import { ForbiddenError, NotFoundError } from "@echo/core";
import { meetsTier, type Policy, roleHas, TIER_REQUIRED } from "./policies";
import {
  type Principal,
  type ProjectAccess,
  resolveProject,
  resolveWorkspace,
  type WorkspaceAccess,
} from "./resolve";
import type { AccessStore } from "./store";

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
    if (!access) throw new NotFoundError("Project not found");
    check(access.role, policy, access.extra, access.tier);
    return access;
  }

  async workspace(
    who: Principal,
    workspaceId: string,
    policy: Policy,
    now = new Date(),
  ): Promise<WorkspaceAccess> {
    const access = await resolveWorkspace(this.store, workspaceId, who, now);
    if (!access) throw new NotFoundError("Workspace not found");
    check(access.role, policy, access.extra, access.workspace.tier);
    return access;
  }
}

function check(
  role: ProjectAccess["role"],
  policy: Policy,
  extra: readonly Policy[],
  tier: string | null,
) {
  if (!roleHas(role, policy, extra))
    throw new ForbiddenError("You do not have permission to do this");
  const required = TIER_REQUIRED[policy];
  if (required && !meetsTier(tier, required)) {
    throw new ForbiddenError(`This action requires the ${required} tier`, {
      requiredTier: required,
    });
  }
}
