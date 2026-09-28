import {
  type Access,
  meetsTier,
  type Policy,
  type ProjectAccess,
  TIER_REQUIRED,
  type WorkspaceAccess,
} from "@dembrane/access";
import { ForbiddenError, NotFoundError } from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { isUuid } from "./storage";

/**
 * How a route reports refusals. The decision always comes from @dembrane/access; only the
 * wording differs, because the dashboard shows these texts and they differ per surface.
 *   bff: onboarding is required first (403 "User not onboarded"), a missing policy is
 *        403 "Not allowed", a tier gate names the current tier.
 *   v1:  a caller without an app user gets the same 404 as one without access, so the
 *        project's existence is never confirmed.
 *   any: no onboarding check, so a legacy project's creator reaches it by Directus id.
 */
export type Surface = "bff" | "v1" | "any";

export async function projectFor(
  access: Access,
  who: Signed,
  projectId: string,
  policy: Policy,
  surface: Surface = "bff",
  denied = "Not allowed",
): Promise<ProjectAccess> {
  if (!who.appUserId && surface !== "any") {
    throw surface === "bff"
      ? new ForbiddenError("User not onboarded")
      : new NotFoundError("Project not found");
  }
  if (!isUuid(projectId)) throw new NotFoundError("Project not found");
  try {
    return await access.project(who, projectId, policy);
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err;
    throw await refusal(policy, denied, () =>
      access.project(who, projectId, "project:read").then(
        (a) => a.tier,
        () => null,
      ),
    );
  }
}

/** Whether a policy holds, without throwing: for filters over many projects. */
export async function projectAllows(
  access: Access,
  who: Signed,
  projectId: string,
  policy: Policy,
): Promise<boolean> {
  if (!who.appUserId || !isUuid(projectId)) return false;
  return access.project(who, projectId, policy).then(
    () => true,
    () => false,
  );
}

/**
 * Workspace access in the v2 middleware's words: 404 when the workspace is gone, 403
 * when the caller has no role in it, 403 `denied` when the role lacks the policy.
 */
export async function workspaceFor(
  access: Access,
  who: Signed,
  workspaceId: string,
  policy: Policy,
  exists: (id: string) => Promise<boolean>,
  denied = "Access denied",
): Promise<WorkspaceAccess> {
  if (!who.appUserId) throw new ForbiddenError("User not onboarded");
  if (!(await exists(workspaceId))) throw new NotFoundError("Workspace not found");
  try {
    return await access.workspace(who, workspaceId, policy);
  } catch (err) {
    if (err instanceof NotFoundError) throw new ForbiddenError("No access to this workspace");
    if (err instanceof ForbiddenError) throw new ForbiddenError(denied);
    throw err;
  }
}

/**
 * The refusal text for a policy the role or tier does not grant. A tier-gated policy on a
 * workspace below that tier names the tier first, whatever the role, because that is the
 * upgrade the dashboard offers.
 */
async function refusal(
  policy: Policy,
  denied: string,
  tierOf: () => Promise<string | null>,
): Promise<ForbiddenError> {
  const required = TIER_REQUIRED[policy];
  if (required) {
    const tier = await tierOf();
    if (tier !== null && !meetsTier(tier, required))
      return new ForbiddenError(`This action requires the ${required} tier (currently ${tier}).`);
  }
  return new ForbiddenError(denied);
}

/**
 * Where the caller's project role came from, in the words the frontend reads: direct or
 * inherited for workspace-visible projects, workspace for admins on private projects,
 * project_share, or legacy. Support-staff rows are stored rows, so they read as direct.
 */
export async function projectSource(
  access: Access,
  who: Signed,
  pa: ProjectAccess,
): Promise<string> {
  if (pa.source !== "workspace" || pa.project.visibility === "private") return pa.source;
  const wsId = pa.project.workspaceId;
  if (!wsId) return pa.source;
  const ws = await access.workspace(who, wsId, "project:read");
  return ws.source === "inherited" ? "inherited" : "direct";
}
